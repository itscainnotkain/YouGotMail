import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
import { AppError } from './env';
import { auth, authenticate } from './auth';
import { setup } from './setup';
import { mail } from './mail';
import { preferences } from './preferences';
import { administration } from './admin';
import { admin, id, readLimited } from './lib';
import { getIntegration, unbase64, base64, same } from './crypto';
import type { ResendConnection } from './providers';
import { handleDelivery } from './sending';
import { receiveEmail } from './receiving';
import { queueHandler, scheduledHandler } from './jobs';
export { MailboxLive, RateLimiter } from './objects';

const app = new Hono<AppEnv>();
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (
    c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
    origin !== new URL(c.req.url).origin
  )
    throw new AppError(
      403,
      'WebSocket requests must originate from this application',
    );
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    c.req.path !== '/api/v1/webhooks/resend' &&
    origin !== new URL(c.req.url).origin
  ) {
    // Same-origin browser requests include Origin. Non-browser API clients must explicitly provide it as well.
    throw new AppError(
      403,
      'Requests must originate from this application',
      'ORIGIN',
    );
  }
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status as 400,
    );
  if (error instanceof z.ZodError)
    return c.json(
      {
        error: error.issues[0]?.message || 'Invalid input',
        code: 'VALIDATION',
      },
      400,
    );
  if (/UNIQUE constraint failed/.test(error.message))
    return c.json(
      { error: 'That name or address is already in use', code: 'DUPLICATE' },
      409,
    );
  if (/FOREIGN KEY constraint failed/.test(error.message))
    return c.json(
      {
        error: 'This item is still in use or is no longer available',
        code: 'IN_USE',
      },
      409,
    );
  const requestId = id();
  console.error(
    JSON.stringify({
      type: 'request_error',
      requestId,
      path: c.req.path,
      errorType: error.name,
    }),
  );
  return c.json(
    {
      error: 'This request could not be completed. Please try again.',
      code: 'INTERNAL',
      requestId,
    },
    500,
  );
});
app.get('/health', (c) => c.json({ ok: true, version: '0.1.0' }));
app.route('/api/v1/auth', auth);
app.route('/api/v1/setup', setup);
app.route('/api/v1/mail', mail);
app.route('/api/v1/preferences', preferences);
app.route('/api/v1/admin', administration);
app.get('/api/v1/branding/:id', async (c) => {
  if (!/^[\w-]{1,100}$/.test(c.req.param('id')))
    throw new AppError(404, 'Image not found');
  const object = await c.env.FILES.get(`branding/${c.req.param('id')}`);
  if (!object) throw new AppError(404, 'Image not found');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
app.post('/api/v1/branding', authenticate, async (c) => {
  admin(c);
  const bytes = await readLimited(c.req.raw, 2 * 1024 * 1024);
  let type = '';
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    type = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    type = 'image/jpeg';
  else if (
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  )
    type = 'image/webp';
  else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0)
    type = 'image/x-icon';
  if (!type) throw new AppError(400, 'Upload a PNG, JPEG, WebP, or ICO image');
  const imageId = id();
  await c.env.FILES.put(`branding/${imageId}`, bytes, {
    httpMetadata: { contentType: type },
  });
  return c.json({ url: `/api/v1/branding/${imageId}` }, 201);
});
app.post('/api/v1/webhooks/resend', async (c) => {
  const config = await getIntegration<ResendConnection>(c.env, 'resend');
  if (!config?.webhookSecret)
    throw new AppError(503, 'Webhook verification is not configured');
  const timestamp = c.req.header('svix-timestamp') || '',
    eventId = c.req.header('svix-id') || '',
    signatures = c.req.header('svix-signature') || '';
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !eventId
  )
    throw new AppError(401, 'Invalid webhook');
  const bytes = await readLimited(c.req.raw, 256 * 1024),
    raw = new TextDecoder().decode(bytes);
  const key = await crypto.subtle.importKey(
    'raw',
    unbase64(config.webhookSecret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${eventId}.${timestamp}.${raw}`),
      ),
    ),
  );
  let valid = false;
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',');
    if (version === 'v1' && value && (await same(expected, value)))
      valid = true;
  }
  if (!valid) throw new AppError(401, 'Invalid webhook signature');
  const event = JSON.parse(raw) as {
    type: string;
    created_at: string;
    data: {
      email_id: string;
      to: string[];
      bounce?: { message?: string };
      failed?: { reason?: string };
    };
  };
  const status = (
    {
      'email.sent': 'accepted',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'deferred',
      'email.bounced': 'bounced',
      'email.failed': 'failed',
      'email.complained': 'complained',
    } as Record<string, string>
  )[event.type];
  if (status)
    await handleDelivery(c.env, {
      id: `resend:${eventId}`,
      provider: 'resend',
      providerId: event.data.email_id,
      recipients: event.data.to || [],
      status,
      detail: event.data.bounce?.message || event.data.failed?.reason || '',
      at: Date.parse(event.created_at) || Date.now(),
    });
  return c.json({ ok: true });
});
app.all('/api/*', (c) => c.json({ error: 'Endpoint not found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  email: receiveEmail,
  queue: queueHandler,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(scheduledHandler(env)),
} satisfies ExportedHandler<Env>;
