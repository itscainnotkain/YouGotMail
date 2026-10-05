import { argon2idAsync } from '@noble/hashes/argon2.js';
import type { Env } from './env';
import { AppError } from './env';

export function base64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function token() {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
export async function digest(value: string | Uint8Array<ArrayBuffer>) {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
export function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function same(a: string, b: string) {
  return equal(unbase64(await digest(a)), unbase64(await digest(b)));
}
const costs = {
  m: 19456,
  t: 2,
  p: 1,
  dkLen: 32,
  maxmem: 32 * 1024 * 1024,
  asyncTick: 10,
};
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await argon2idAsync(password, salt, costs);
  return `$argon2id$v=19$m=19456,t=2,p=1$${base64(salt)}$${base64(hash)}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[3] !== 'm=19456,t=2,p=1') return false;
  return equal(
    await argon2idAsync(password, unbase64(parts[4]), costs),
    unbase64(parts[5]),
  );
}
async function key(env: Env) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unbase64(env.APP_KEY);
  } catch {
    throw new AppError(503, 'The application encryption key is not configured');
  }
  if (bytes.length !== 32)
    throw new AppError(503, 'APP_KEY must be a unique 32-byte base64 key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function encrypt(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    new TextEncoder().encode(value),
  );
  return `${base64(iv)}.${base64(new Uint8Array(bytes))}`;
}
export async function decrypt(env: Env, value: string) {
  const [iv, ciphertext] = value.split('.');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(iv) },
      await key(env),
      unbase64(ciphertext),
    ),
  );
}
export async function getIntegration<T>(
  env: Env,
  name: string,
): Promise<T | null> {
  const row = await env.DB.prepare(
    'SELECT encrypted FROM integrations WHERE name=?',
  )
    .bind(name)
    .first<{ encrypted: string }>();
  return row ? (JSON.parse(await decrypt(env, row.encrypted)) as T) : null;
}
export async function putIntegration(env: Env, name: string, value: unknown) {
  await env.DB.prepare(
    'INSERT INTO integrations(name,encrypted,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at',
  )
    .bind(name, await encrypt(env, JSON.stringify(value)), Date.now())
    .run();
}
