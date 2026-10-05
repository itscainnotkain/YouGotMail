import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
import { AppError } from './env';
import type { Branding, User } from '../shared/types';

export const now = () => Date.now();
export const id = () => crypto.randomUUID();
export const json = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return JSON.parse(value || '') as T;
  } catch {
    return fallback;
  }
};
export async function body<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<z.infer<T>> {
  const data = await readLimited(c.req.raw, 512 * 1024);
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(data)));
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new AppError(
        400,
        e.issues[0]?.message || 'Invalid input',
        'VALIDATION',
        e.issues,
      );
    throw new AppError(400, 'Invalid JSON', 'VALIDATION');
  }
}
export async function readLimited(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length')) > limit)
    throw new AppError(413, 'This upload is too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new AppError(413, 'This upload is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const nameSchema = z.string().trim().min(1).max(100);
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters for your password')
  .max(256);
export const participantSchema = z.object({
  address: emailSchema,
  name: z.string().max(100).optional(),
});
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex colour');
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid timezone');
export function admin(c: Context<AppEnv>) {
  if (c.get('user').role === 'member')
    throw new AppError(403, 'Administrator access required');
}
export async function mailboxAccess(env: Env, user: User, mailboxId: string) {
  const membership = await env.DB.prepare(
    'SELECT 1 FROM mailbox_members WHERE user_id=? AND mailbox_id=?',
  )
    .bind(user.id, mailboxId)
    .first();
  if (!membership) throw new AppError(404, 'Mailbox not found');
}
export async function audit(
  env: Env,
  userId: string | null,
  action: string,
  target: string,
  detail = '',
) {
  await env.DB.prepare(
    'INSERT INTO audit (id,user_id,action,target,detail,created_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(id(), userId, action, target, detail, now())
    .run();
}
export async function branding(env: Env): Promise<Branding> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='branding'",
  ).first<{ value: string }>();
  return json(row?.value, {
    name: 'YouGotMail',
    accent: '#365c45',
    login_text: 'A little less noise. A little more you.',
    logo: '',
    favicon: '',
    app_url: '',
    setup_complete: false,
  });
}
export async function setting<T>(
  env: Env,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?')
    .bind(key)
    .first<{ value: string }>();
  return json(row?.value, fallback);
}
export async function setSetting(env: Env, key: string, value: unknown) {
  await env.DB.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
    .bind(key, JSON.stringify(value))
    .run();
}
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  window = 900_000,
) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const response = await stub.fetch('https://limit/check', {
    method: 'POST',
    body: JSON.stringify({ limit, window }),
  });
  if (!response.ok)
    throw new AppError(
      429,
      'Too many attempts. Please try again later.',
      'RATE_LIMIT',
    );
}
export async function notifyMailbox(env: Env, mailboxId: string) {
  await env.LIVE.get(env.LIVE.idFromName(mailboxId)).fetch(
    'https://live/notify',
    { method: 'POST' },
  );
}
export function safeFilename(name: string) {
  return (
    name.replace(/[\x00-\x1f\x7f\/\\"]/g, '_').slice(0, 200) || 'attachment'
  );
}
export function contentDisposition(filename: string, inline = false) {
  const safe = new TextDecoder().decode(
      new TextEncoder().encode(safeFilename(filename)),
    ),
    fallback = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function publicUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
    recovery_email: String(row.recovery_email),
    role: row.role as User['role'],
    timezone: String(row.timezone),
    two_factor: !!row.totp_secret,
  };
}
