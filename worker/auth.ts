import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { Secret, TOTP } from 'otpauth';
import type { AppEnv, Env } from './env';
import { AppError } from './env';
import {
  body,
  id,
  now,
  publicUser,
  passwordSchema,
  nameSchema,
  emailSchema,
  timezoneSchema,
  rateLimit,
  audit,
  json,
  branding,
} from './lib';
import {
  decrypt,
  digest,
  encrypt,
  hashPassword,
  same,
  token,
  verifyPassword,
} from './crypto';
import { sendSystemEmail } from './sending';
import type { Context, Next } from 'hono';

export async function authenticate(c: Context<AppEnv>, next: Next) {
  const raw = getCookie(c, 'ygm_session');
  if (!raw) throw new AppError(401, 'Please sign in', 'UNAUTHENTICATED');
  const sessionId = await digest(raw);
  const row = await c.env.DB.prepare(
    'SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled=0',
  )
    .bind(sessionId, now())
    .first<Record<string, unknown>>();
  if (!row)
    throw new AppError(401, 'Your session has expired', 'UNAUTHENTICATED');
  c.set('user', publicUser(row));
  c.set('session', { id: sessionId, csrf: String(row.csrf) });
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !(await same(c.req.header('X-CSRF-Token') || '', String(row.csrf)))
  )
    throw new AppError(403, 'Refresh the page and try again', 'CSRF');
  await next();
}
export async function createSession(
  c: Context<AppEnv>,
  user: Record<string, unknown>,
) {
  const raw = token(),
    csrf = token(),
    timestamp = now();
  await c.env.DB.prepare(
    'INSERT INTO sessions(id,user_id,csrf,expires_at,created_at,last_seen) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      await digest(raw),
      String(user.id),
      csrf,
      timestamp + 7 * 86400_000,
      timestamp,
      timestamp,
    )
    .run();
  setCookie(c, 'ygm_session', raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 86400,
  });
  return c.json({ user: publicUser(user), csrf });
}
export async function checkSecondFactor(
  env: Env,
  row: Record<string, unknown>,
  code?: string,
) {
  if (!row.totp_secret) return;
  if (!code)
    throw new AppError(401, 'Enter your authenticator code', 'TWO_FACTOR');
  const totp = new TOTP({
    secret: await decrypt(env, String(row.totp_secret)),
    period: 30,
    digits: 6,
    algorithm: 'SHA1',
  });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta !== null) {
    const step = Math.floor(now() / 30_000) + delta;
    const update = await env.DB.prepare(
      'UPDATE users SET totp_last_step=? WHERE id=? AND totp_last_step<?',
    )
      .bind(step, String(row.id), step)
      .run();
    if (update.meta.changes === 1) return;
  } else {
    const hashed = await digest(code.toUpperCase().replace(/\s/g, ''));
    const codes = json<string[]>(String(row.recovery_codes), []);
    if (codes.includes(hashed)) {
      const update = await env.DB.prepare(
        'UPDATE users SET recovery_codes=? WHERE id=? AND recovery_codes=?',
      )
        .bind(
          JSON.stringify(codes.filter((v) => v !== hashed)),
          String(row.id),
          String(row.recovery_codes),
        )
        .run();
      if (update.meta.changes === 1) return;
    }
  }
  throw new AppError(
    401,
    'Invalid or already used authenticator code',
    'TWO_FACTOR',
  );
}
export const auth = new Hono<AppEnv>();
auth.post('/login', async (c) => {
  await rateLimit(
    c.env,
    `login-ip:${c.req.header('cf-connecting-ip') || 'local'}`,
    30,
  );
  const data = await body(
    c,
    z.object({
      username: z.string().trim().min(1).max(254),
      password: z.string().max(256),
      code: z.string().max(50).optional(),
    }),
  );
  await rateLimit(c.env, `login-user:${data.username.toLowerCase()}`, 10);
  const row = await c.env.DB.prepare(
    'SELECT * FROM users WHERE username=? COLLATE NOCASE AND disabled=0',
  )
    .bind(data.username)
    .first<Record<string, unknown>>();
  if (!row || !(await verifyPassword(data.password, String(row.password_hash))))
    throw new AppError(401, 'Incorrect username or password');
  await checkSecondFactor(c.env, row, data.code);
  await audit(c.env, String(row.id), 'auth.login', String(row.id));
  return createSession(c, row);
});
auth.get('/invite/:token', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT name,email,expires_at FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
  )
    .bind(await digest(c.req.param('token')), now())
    .first();
  if (!row)
    throw new AppError(
      404,
      'This invitation has expired or was already accepted',
    );
  return c.json(row);
});
auth.post('/accept-invite', async (c) => {
  await rateLimit(
    c.env,
    `invite:${c.req.header('cf-connecting-ip') || 'local'}`,
    10,
  );
  const data = await body(
    c,
    z.object({
      token: z.string().max(100),
      username: z
        .string()
        .trim()
        .regex(/^[a-zA-Z0-9._@-]{3,100}$/),
      name: nameSchema,
      password: passwordSchema,
      timezone: timezoneSchema.default('UTC'),
    }),
  );
  const invitation = await c.env.DB.prepare(
    'SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
  )
    .bind(await digest(data.token), now())
    .first<Record<string, unknown>>();
  if (!invitation)
    throw new AppError(400, 'This invitation is no longer available');
  const passwordHash = await hashPassword(data.password),
    userId = id(),
    timestamp = now();
  // INSERT SELECT and the invitation marker execute in one atomic batch. The one-time token is never consumed before the user exists.
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO users(id,username,name,recovery_email,password_hash,role,timezone,created_at) SELECT ?,?,?,?,?,?,?,? FROM invitations WHERE id=? AND used_at IS NULL AND expires_at>?',
    ).bind(
      userId,
      data.username,
      data.name,
      String(invitation.email),
      passwordHash,
      String(invitation.role),
      data.timezone,
      timestamp,
      String(invitation.id),
      timestamp,
    ),
    c.env.DB.prepare(
      'UPDATE invitations SET used_at=? WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=?)',
    ).bind(timestamp, String(invitation.id), userId),
  ];
  for (const mailboxId of json<string[]>(String(invitation.mailbox_ids), []))
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO mailbox_members(mailbox_id,user_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)',
      ).bind(mailboxId, userId, userId),
    );
  const result = await c.env.DB.batch(statements);
  if (!result[0].meta.changes)
    throw new AppError(409, 'This invitation was already accepted');
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(userId)
    .first<Record<string, unknown>>();
  await audit(c.env, userId, 'auth.invite.accept', String(invitation.id));
  return createSession(c, user!);
});
auth.post('/forgot-password', async (c) => {
  await rateLimit(
    c.env,
    `recover:${c.req.header('cf-connecting-ip') || 'local'}`,
    5,
    3600_000,
  );
  const { username } = await body(
    c,
    z.object({ username: z.string().trim().max(254) }),
  );
  const row = await c.env.DB.prepare(
    'SELECT id,name,recovery_email FROM users WHERE username=? COLLATE NOCASE AND disabled=0',
  )
    .bind(username)
    .first<{ id: string; name: string; recovery_email: string }>();
  if (row) {
    const raw = token(),
      hash = await digest(raw),
      config = await branding(c.env),
      url = config.app_url || new URL(c.req.url).origin;
    await c.env.DB.prepare(
      'INSERT INTO recovery_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)',
    )
      .bind(hash, row.id, now() + 30 * 60_000)
      .run();
    try {
      await sendSystemEmail(
        c.env,
        row.recovery_email,
        'Reset your password',
        `Reset your ${config.name} password: ${url}/reset?token=${raw}\nThis link expires in 30 minutes.`,
      );
    } catch {
      await c.env.DB.prepare('DELETE FROM recovery_tokens WHERE token_hash=?')
        .bind(hash)
        .run();
    }
  }
  return c.json({
    message:
      'If this account exists and recovery email is configured, a reset link has been sent.',
  });
});
auth.post('/reset-password', async (c) => {
  await rateLimit(
    c.env,
    `reset:${c.req.header('cf-connecting-ip') || 'local'}`,
    10,
  );
  const data = await body(
    c,
    z.object({
      token: z.string().max(100),
      password: passwordSchema,
      code: z.string().max(50).optional(),
    }),
  );
  const hash = await digest(data.token),
    timestamp = now();
  const row = await c.env.DB.prepare(
    'SELECT u.* FROM recovery_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.disabled=0',
  )
    .bind(hash, timestamp)
    .first<Record<string, unknown>>();
  if (!row)
    throw new AppError(400, 'This reset link has expired or was already used');
  await checkSecondFactor(c.env, row, data.code);
  const passwordHash = await hashPassword(data.password);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash=? WHERE id=? AND EXISTS(SELECT 1 FROM recovery_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?)',
    ).bind(passwordHash, String(row.id), hash, timestamp),
    c.env.DB.prepare(
      'UPDATE recovery_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL',
    ).bind(timestamp, hash),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(
      String(row.id),
    ),
  ]);
  if (!results[0].meta.changes)
    throw new AppError(409, 'This reset link was already used');
  return c.json({ ok: true });
});
auth.use('*', authenticate);
auth.get('/me', (c) =>
  c.json({ user: c.get('user'), csrf: c.get('session').csrf }),
);
auth.post('/logout', async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id=?')
    .bind(c.get('session').id)
    .run();
  deleteCookie(c, 'ygm_session', { path: '/' });
  return c.json({ ok: true });
});
auth.patch('/profile', async (c) => {
  const data = await body(
    c,
    z.object({
      name: nameSchema,
      recovery_email: emailSchema,
      timezone: timezoneSchema,
      password: z.string().max(256).optional(),
      code: z.string().max(50).optional(),
    }),
  );
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(c.get('user').id)
    .first<Record<string, unknown>>();
  if (data.recovery_email !== row!.recovery_email) {
    if (
      !data.password ||
      !(await verifyPassword(data.password, String(row!.password_hash)))
    )
      throw new AppError(
        400,
        'Enter your current password to change your recovery address',
      );
    await checkSecondFactor(c.env, row!, data.code);
  }
  await c.env.DB.prepare(
    'UPDATE users SET name=?,recovery_email=?,timezone=? WHERE id=?',
  )
    .bind(data.name, data.recovery_email, data.timezone, c.get('user').id)
    .run();
  return c.json({ ok: true });
});
auth.post('/password', async (c) => {
  const data = await body(
    c,
    z.object({
      current: z.string().max(256),
      password: passwordSchema,
      code: z.string().max(50).optional(),
    }),
  );
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(c.get('user').id)
    .first<Record<string, unknown>>();
  if (!(await verifyPassword(data.current, String(row!.password_hash))))
    throw new AppError(400, 'Current password is incorrect');
  await checkSecondFactor(c.env, row!, data.code);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(
      await hashPassword(data.password),
      c.get('user').id,
    ),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').bind(
      c.get('user').id,
      c.get('session').id,
    ),
  ]);
  return c.json({ ok: true });
});
auth.get('/sessions', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT created_at,expires_at,last_seen,id FROM sessions WHERE user_id=? ORDER BY created_at DESC',
      )
        .bind(c.get('user').id)
        .all()
    ).results.map((row) => ({
      ...row,
      current: row.id === c.get('session').id,
    })),
  ),
);
auth.delete('/sessions/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND id=?')
    .bind(c.get('user').id, c.req.param('id'))
    .run();
  return c.json({ ok: true });
});
auth.post('/2fa/start', async (c) => {
  const { password } = await body(
    c,
    z.object({ password: z.string().max(256) }),
  );
  const row = await c.env.DB.prepare(
    'SELECT password_hash,totp_secret FROM users WHERE id=?',
  )
    .bind(c.get('user').id)
    .first<{ password_hash: string; totp_secret: string }>();
  if (row?.totp_secret)
    throw new AppError(400, 'Two-factor authentication is already enabled');
  if (!row || !(await verifyPassword(password, row.password_hash)))
    throw new AppError(400, 'Password is incorrect');
  const secret = new Secret({ size: 20 }).base32;
  await c.env.DB.prepare('UPDATE users SET totp_pending=? WHERE id=?')
    .bind(
      await encrypt(
        c.env,
        JSON.stringify({ secret, expires: now() + 10 * 60_000 }),
      ),
      c.get('user').id,
    )
    .run();
  const config = await branding(c.env);
  return c.json({
    secret,
    uri: new TOTP({
      issuer: config.name,
      label: c.get('user').username,
      secret,
    }).toString(),
  });
});
auth.post('/2fa/confirm', async (c) => {
  const { code } = await body(c, z.object({ code: z.string().length(6) }));
  const row = await c.env.DB.prepare(
    'SELECT totp_pending FROM users WHERE id=? AND totp_secret IS NULL',
  )
    .bind(c.get('user').id)
    .first<{ totp_pending: string }>();
  if (!row?.totp_pending)
    throw new AppError(400, 'Start two-factor setup first');
  const pending = JSON.parse(await decrypt(c.env, row.totp_pending)) as {
    secret: string;
    expires: number;
  };
  const totp = new TOTP({ secret: pending.secret });
  if (
    pending.expires < now() ||
    totp.validate({ token: code, window: 1 }) === null
  )
    throw new AppError(400, 'Invalid code or expired setup');
  const codes = Array.from({ length: 8 }, () =>
    token().slice(0, 16).toUpperCase(),
  );
  await c.env.DB.prepare(
    'UPDATE users SET totp_secret=?,totp_pending=NULL,recovery_codes=? WHERE id=? AND totp_secret IS NULL',
  )
    .bind(
      await encrypt(c.env, pending.secret),
      JSON.stringify(await Promise.all(codes.map(digest))),
      c.get('user').id,
    )
    .run();
  return c.json({ codes });
});
auth.post('/2fa/disable', async (c) => {
  const data = await body(
    c,
    z.object({ password: z.string().max(256), code: z.string().max(50) }),
  );
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(c.get('user').id)
    .first<Record<string, unknown>>();
  if (!(await verifyPassword(data.password, String(row!.password_hash))))
    throw new AppError(400, 'Password is incorrect');
  await checkSecondFactor(c.env, row!, data.code);
  await c.env.DB.prepare(
    "UPDATE users SET totp_secret=NULL,totp_pending=NULL,recovery_codes='[]' WHERE id=?",
  )
    .bind(c.get('user').id)
    .run();
  return c.json({ ok: true });
});
