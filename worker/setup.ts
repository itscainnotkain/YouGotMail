import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { AppError } from './env';
import { authenticate, createSession } from './auth';
import {
  admin,
  audit,
  body,
  branding,
  colorSchema,
  emailSchema,
  id,
  nameSchema,
  now,
  passwordSchema,
  publicUser,
  rateLimit,
  setSetting,
  setting,
  timezoneSchema,
} from './lib';
import {
  cf,
  cfWithToken,
  cfList,
  cfListWithToken,
  resendWithToken,
  type CloudflareConnection,
  type ResendConnection,
} from './providers';
import {
  encrypt,
  getIntegration,
  hashPassword,
  putIntegration,
  same,
} from './crypto';
import { applyDomain, checkDomain, getDomain, previewDomain } from './domains';
import { sendSystemEmail } from './sending';

export const setup = new Hono<AppEnv>();
setup.get('/status', async (c) => {
  const owner = await c.env.DB.prepare(
    "SELECT 1 FROM users WHERE role='owner'",
  ).first();
  return c.json({
    hasOwner: !!owner,
    branding: await branding(c.env),
    version: '0.1.0',
  });
});
setup.post('/claim', async (c) => {
  await rateLimit(
    c.env,
    `setup:${c.req.header('cf-connecting-ip') || 'local'}`,
    5,
  );
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE role='owner'").first())
    throw new AppError(409, 'This instance already has an owner');
  const data = await body(
    c,
    z.object({
      setupToken: z.string().max(256),
      username: z
        .string()
        .trim()
        .regex(/^[a-zA-Z0-9._@-]{3,100}$/),
      name: nameSchema,
      recoveryEmail: emailSchema,
      password: passwordSchema,
      timezone: timezoneSchema.default('UTC'),
    }),
  );
  if (
    !c.env.SETUP_TOKEN ||
    c.env.SETUP_TOKEN.length < 32 ||
    /replace|example|change.?me/i.test(c.env.SETUP_TOKEN)
  )
    throw new AppError(
      503,
      'Configure a unique SETUP_TOKEN in your Worker secrets before setup',
    );
  if (!(await same(data.setupToken, c.env.SETUP_TOKEN)))
    throw new AppError(403, 'Incorrect setup key');
  // Validate the encryption secret before claiming ownership.
  await encrypt(c.env, 'key-check');
  const userId = id(),
    passwordHash = await hashPassword(data.password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO users(id,username,name,recovery_email,password_hash,role,timezone,created_at) VALUES(?,?,?,?,?,'owner',?,?)",
      ).bind(
        userId,
        data.username,
        data.name,
        data.recoveryEmail,
        passwordHash,
        data.timezone,
        now(),
      ),
      c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('setup_claimed','true')",
      ),
    ]);
  } catch {
    throw new AppError(
      409,
      'Ownership was already claimed or the username is unavailable',
    );
  }
  await audit(c.env, userId, 'setup.claim', userId);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(userId)
    .first<Record<string, unknown>>();
  return createSession(c, user!);
});
setup.use('*', authenticate);
setup.use('*', async (c, next) => {
  admin(c);
  await next();
});
setup.get('/progress', async (c) => {
  const domains = (
    await c.env.DB.prepare('SELECT * FROM domains ORDER BY created_at').all()
  ).results;
  const integrations = (
    await c.env.DB.prepare('SELECT name FROM integrations').all<{
      name: string;
    }>()
  ).results.map((r) => r.name);
  return c.json({
    domains,
    integrations,
    connection: await getIntegration<CloudflareConnection>(
      c.env,
      'cloudflare',
    ).then((v) =>
      v
        ? {
            accountId: v.accountId,
            workerName: v.workerName,
            queueId: v.queueId,
          }
        : null,
    ),
    test: await setting(c.env, 'setup_test', null),
    branding: await branding(c.env),
    mailboxes: (
      await c.env.DB.prepare(
        'SELECT id,name,primary_address FROM mailboxes',
      ).all()
    ).results,
  });
});
setup.patch('/branding', async (c) => {
  const data = await body(
    c,
    z.object({
      name: nameSchema,
      accent: colorSchema,
      login_text: z.string().max(250),
      logo: z
        .string()
        .max(200)
        .refine((v) => !v || /^\/api\/v1\/branding\/[\w-]+$/.test(v)),
      favicon: z
        .string()
        .max(200)
        .refine((v) => !v || /^\/api\/v1\/branding\/[\w-]+$/.test(v)),
      app_url: z
        .string()
        .max(250)
        .refine(
          (v) =>
            !v ||
            (() => {
              try {
                const u = new URL(v);
                return (
                  (u.protocol === 'https:' ||
                    ['localhost', '127.0.0.1'].includes(u.hostname)) &&
                  u.pathname === '/' &&
                  !u.search &&
                  !u.hash &&
                  !u.username
                );
              } catch {
                return false;
              }
            })(),
          'Use an HTTPS app origin',
        ),
    }),
  );
  const existing = await branding(c.env);
  await setSetting(c.env, 'branding', {
    ...existing,
    ...data,
    app_url: data.app_url.replace(/\/$/, ''),
  });
  await audit(c.env, c.get('user').id, 'branding.update', 'instance');
  return c.json({ ok: true });
});
setup.post('/cloudflare', async (c) => {
  const data = await body(
    c,
    z.object({
      token: z.string().min(20).max(200),
      accountId: z.string().regex(/^[a-f0-9]{32}$/i),
      workerName: z.string().regex(/^[a-z0-9-]{1,63}$/),
      queueId: z.string().max(32).default(''),
    }),
  );
  const zones = await cfListWithToken<{
    id: string;
    name: string;
    status: string;
    account: { id: string };
  }>(data.token, `/zones?account.id=${data.accountId}`);
  const worker = await cfWithToken<{
    bindings: {
      name: string;
      type: string;
      queue_name?: string;
      queue_id?: string;
    }[];
  }>(
    data.token,
    `/accounts/${data.accountId}/workers/scripts/${data.workerName}/settings`,
  );
  let queueId = data.queueId;
  if (!queueId) {
    const queues = await cfWithToken<
      { queue_id: string; queue_name: string }[]
    >(data.token, `/accounts/${data.accountId}/queues?per_page=100`);
    const binding = worker.bindings.find((b) => b.name === 'JOBS');
    queueId =
      binding?.queue_id ||
      queues.find(
        (q) => q.queue_name === (binding?.queue_name || 'yougotmail-jobs'),
      )?.queue_id ||
      '';
  }
  await putIntegration(c.env, 'cloudflare', { ...data, queueId });
  await audit(c.env, c.get('user').id, 'integration.connect', 'cloudflare');
  return c.json({
    zones: zones.filter((z) => z.status === 'active'),
    workerName: data.workerName,
    queueId,
  });
});
setup.get('/zones', async (c) => {
  const connection = await getIntegration<CloudflareConnection>(
    c.env,
    'cloudflare',
  );
  if (!connection) return c.json([]);
  const zones = await cfList<{ id: string; name: string; status: string }>(
    c.env,
    `/zones?account.id=${connection.accountId}`,
  );
  return c.json(zones.filter((z) => z.status === 'active'));
});
setup.post('/resend', async (c) => {
  const data = await body(c, z.object({ token: z.string().min(15).max(200) }));
  await resendWithToken(data.token, '/domains');
  const existing = await getIntegration<ResendConnection>(c.env, 'resend');
  const connection: ResendConnection = { token: data.token };
  const config = await branding(c.env),
    appUrl = config.app_url || new URL(c.req.url).origin;
  let warning = '';
  try {
    const hook = existing?.webhookId
      ? await resendWithToken<{ id: string; signing_secret: string }>(
          data.token,
          `/webhooks/${existing.webhookId}`,
        )
      : await resendWithToken<{ id: string; signing_secret: string }>(
          data.token,
          '/webhooks',
          'POST',
          {
            endpoint: `${appUrl}/api/v1/webhooks/resend`,
            events: [
              'email.sent',
              'email.delivered',
              'email.delivery_delayed',
              'email.bounced',
              'email.failed',
              'email.complained',
            ],
          },
        );
    connection.webhookId = hook.id;
    connection.webhookSecret = hook.signing_secret || existing?.webhookSecret;
  } catch {
    warning =
      'Sending is connected. Automatic webhook setup failed; configure your Resend webhook and signing secret in Settings to track deliveries.';
  }
  await putIntegration(c.env, 'resend', connection);
  await audit(c.env, c.get('user').id, 'integration.connect', 'resend');
  return c.json({ ok: true, warning });
});
setup.post('/resend-webhook', async (c) => {
  const data = await body(
    c,
    z.object({ secret: z.string().startsWith('whsec_').max(200) }),
  );
  const connection = await getIntegration<ResendConnection>(c.env, 'resend');
  if (!connection) throw new AppError(400, 'Connect Resend first');
  await putIntegration(c.env, 'resend', {
    ...connection,
    webhookSecret: data.secret,
  });
  return c.json({ ok: true });
});
setup.post('/domains', async (c) => {
  const data = await body(
    c,
    z.object({
      zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
      provider: z.enum(['cloudflare', 'resend']),
    }),
  );
  const zone = await cf<{
    id: string;
    name: string;
    account: { id: string };
    status: string;
  }>(c.env, `/zones/${data.zoneId}`);
  const connection = await getIntegration<CloudflareConnection>(
    c.env,
    'cloudflare',
  );
  if (zone.account.id !== connection!.accountId || zone.status !== 'active')
    throw new AppError(400, 'Choose an active zone in your connected account');
  const domainId = id();
  await c.env.DB.prepare(
    'INSERT INTO domains(id,name,zone_id,provider,created_at) VALUES(?,?,?,?,?)',
  )
    .bind(domainId, zone.name, zone.id, data.provider, now())
    .run();
  await audit(c.env, c.get('user').id, 'domain.create', domainId, zone.name);
  return c.json(await getDomain(c.env, domainId), 201);
});
setup.patch('/domains/:id', async (c) => {
  const data = await body(
    c,
    z.object({
      provider: z.enum(['cloudflare', 'resend']).optional(),
      catchAllMailbox: z.string().uuid().nullable().optional(),
    }),
  );
  const domain = await getDomain(c.env, c.req.param('id'));
  if (data.catchAllMailbox) {
    if (
      !(await c.env.DB.prepare('SELECT 1 FROM mailboxes WHERE id=?')
        .bind(data.catchAllMailbox)
        .first())
    )
      throw new AppError(400, 'Mailbox does not exist');
  }
  if (data.provider && data.provider !== domain.provider) {
    const pending = await c.env.DB.prepare(
      "SELECT 1 FROM send_jobs WHERE domain_id=? AND status IN ('pending','queued','sending','uncertain') LIMIT 1",
    )
      .bind(domain.id)
      .first();
    if (pending)
      throw new AppError(
        409,
        'Resolve or cancel pending sends before changing providers',
      );
    await c.env.DB.prepare(
      "UPDATE domains SET provider=?,provider_domain_id='',sending_status='pending',last_error='' WHERE id=?",
    )
      .bind(data.provider, domain.id)
      .run();
  }
  if (data.catchAllMailbox !== undefined)
    await c.env.DB.prepare('UPDATE domains SET catch_all_mailbox=? WHERE id=?')
      .bind(data.catchAllMailbox, domain.id)
      .run();
  await audit(c.env, c.get('user').id, 'domain.update', domain.id);
  return c.json(await getDomain(c.env, domain.id));
});
setup.post('/domains/:id/preview', async (c) =>
  c.json(await previewDomain(c.env, await getDomain(c.env, c.req.param('id')))),
);
setup.post('/domains/:id/apply', async (c) => {
  const data = await body(
    c,
    z.object({
      snapshot: z.string().max(100),
      confirmMigration: z.boolean().default(false),
    }),
  );
  const domain = await applyDomain(
    c.env,
    await getDomain(c.env, c.req.param('id')),
    data.snapshot,
    data.confirmMigration,
  );
  await audit(
    c.env,
    c.get('user').id,
    'domain.configure',
    domain.id,
    data.confirmMigration ? 'Migration confirmed' : 'New setup',
  );
  return c.json(domain);
});
setup.post('/domains/:id/check', async (c) =>
  c.json(await checkDomain(c.env, await getDomain(c.env, c.req.param('id')))),
);
setup.post('/hostname', async (c) => {
  const data = await body(
    c,
    z.object({
      hostname: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+$/)
        .max(253),
      zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
    }),
  );
  const connection = await getIntegration<CloudflareConnection>(
    c.env,
    'cloudflare',
  );
  if (!connection) throw new AppError(400, 'Connect Cloudflare first');
  const zone = await cf<{ name: string; account: { id: string } }>(
    c.env,
    `/zones/${data.zoneId}`,
  );
  if (
    zone.account.id !== connection.accountId ||
    !data.hostname.endsWith(`.${zone.name}`)
  )
    throw new AppError(400, 'Choose a hostname below your selected zone');
  await cf(c.env, `/accounts/${connection.accountId}/workers/domains`, 'PUT', {
    hostname: data.hostname,
    service: connection.workerName,
    environment: 'production',
    zone_id: data.zoneId,
  });
  const config = await branding(c.env);
  await setSetting(c.env, 'branding', {
    ...config,
    app_url: `https://${data.hostname}`,
  });
  await audit(c.env, c.get('user').id, 'hostname.configure', data.hostname);
  return c.json({ ok: true, url: `https://${data.hostname}` });
});
setup.post('/test', async (c) => {
  const data = await body(
    c,
    z.object({ recipient: emailSchema, addressId: z.string().uuid() }),
  );
  const address = await c.env.DB.prepare(
    'SELECT email FROM addresses WHERE id=? AND active=1',
  )
    .bind(data.addressId)
    .first<{ email: string }>();
  if (!address) throw new AppError(400, 'Choose a sending address');
  const job = await sendSystemEmail(
    c.env,
    data.recipient,
    'Your YouGotMail setup test',
    `Your outbound email is working. Reply to this message to verify inbound delivery.\n\nSent from ${address.email}`,
    data.addressId,
  );
  await setSetting(c.env, 'setup_test', {
    jobId: job.id,
    address: address.email,
    startedAt: now(),
  });
  return c.json({ jobId: job.id });
});
setup.get('/test', async (c) => {
  const test = await setting<{
    jobId: string;
    address: string;
    startedAt: number;
  } | null>(c.env, 'setup_test', null);
  if (!test) return c.json({ outbound: false, inbound: false });
  const job = await c.env.DB.prepare(
    'SELECT status,last_error FROM send_jobs WHERE id=?',
  )
    .bind(test.jobId)
    .first<{ status: string; last_error: string }>();
  const inbound = await c.env.DB.prepare(
    "SELECT 1 FROM ingestions WHERE envelope_to=? COLLATE NOCASE AND created_at>=? AND status='done' LIMIT 1",
  )
    .bind(test.address, test.startedAt)
    .first();
  return c.json({
    outbound: !!job && ['accepted', 'delivered'].includes(job.status),
    inbound: !!inbound,
    status: job?.status,
    error: job?.last_error,
    address: test.address,
  });
});
setup.post('/complete', async (c) => {
  const test = await setting<{
    jobId: string;
    address: string;
    startedAt: number;
  } | null>(c.env, 'setup_test', null);
  if (!test) throw new AppError(400, 'Send a setup test first');
  const outbound = await c.env.DB.prepare(
    "SELECT 1 FROM send_jobs WHERE id=? AND status IN ('accepted','delivered')",
  )
    .bind(test.jobId)
    .first();
  const inbound = await c.env.DB.prepare(
    "SELECT 1 FROM ingestions WHERE envelope_to=? COLLATE NOCASE AND created_at>=? AND status='done'",
  )
    .bind(test.address, test.startedAt)
    .first();
  if (!outbound || !inbound)
    throw new AppError(
      400,
      'Verify both outbound sending and inbound receipt before completing setup',
    );
  const config = await branding(c.env);
  await setSetting(c.env, 'branding', { ...config, setup_complete: true });
  await audit(c.env, c.get('user').id, 'setup.complete', 'instance');
  return c.json({ ok: true });
});
