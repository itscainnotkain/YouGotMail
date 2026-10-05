import type { Env } from './env';
import { AppError } from './env';
import type { Participant, Provider } from '../shared/types';
import { getIntegration, base64, token } from './crypto';
import type { ResendConnection } from './providers';
import { audit, id, json, now, notifyMailbox, rateLimit } from './lib';
import {
  cleanHtml,
  escapeHtml,
  storeMessage,
  type StoredAttachment,
} from './content';

export const MAX_OUTBOUND = {
  cloudflare: 5 * 1024 * 1024,
  resend: 25 * 1024 * 1024,
};
export type SendPayload = {
  mailboxId: string;
  addressId: string;
  from: Participant;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  subject: string;
  html: string;
  text: string;
  attachments: StoredAttachment[];
  threadId: string | null;
  inReplyTo: string;
  references: string[];
  size: number;
};
type Job = {
  id: string;
  mailbox_id: string;
  provider: Provider;
  domain_id: string;
  payload_key: string;
  status: string;
  due_at: number;
  attempts: number;
  started_at: number | null;
  created_at: number;
  provider_id: string;
  message_id: string | null;
  idempotency_key: string;
};
export async function enqueueSend(
  env: Env,
  payload: SendPayload,
  options: {
    userId: string | null;
    draftId?: string;
    dueAt: number;
    idempotencyKey: string;
  },
) {
  const old = await env.DB.prepare(
    'SELECT id,status,due_at FROM send_jobs WHERE idempotency_key=?',
  )
    .bind(options.idempotencyKey)
    .first<{ id: string; status: string; due_at: number }>();
  if (old) return old;
  const address = await env.DB.prepare(
    'SELECT a.*,d.provider,d.sending_status FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.id=? AND a.mailbox_id=? AND a.active=1',
  )
    .bind(payload.addressId, payload.mailboxId)
    .first<{ domain_id: string; provider: Provider; sending_status: string }>();
  if (!address || address.sending_status !== 'ready')
    throw new AppError(
      400,
      'This sending address is not ready. Check its domain in Settings.',
    );
  if (payload.size > MAX_OUTBOUND[address.provider])
    throw new AppError(
      413,
      `This provider accepts messages up to ${MAX_OUTBOUND[address.provider] / 1024 / 1024} MiB, including encoded attachments.`,
    );
  const recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  if (address.provider === 'cloudflare' && payload.attachments.length > 32)
    throw new AppError(
      400,
      'Cloudflare supports at most 32 attachments per message',
    );
  if (!recipients.length || recipients.length > 50)
    throw new AppError(400, 'Use between 1 and 50 recipients');
  if (!payload.to.length)
    throw new AppError(
      400,
      'Add at least one To recipient. These sending providers require a To address.',
    );
  await rateLimit(env, `send-mailbox:${payload.mailboxId}`, 100, 3600_000);
  const reserved = await env.DB.prepare(
    'UPDATE mailboxes SET used_bytes=used_bytes+? WHERE id=? AND used_bytes+?<=quota_bytes',
  )
    .bind(payload.size, payload.mailboxId, payload.size)
    .run();
  if (!reserved.meta.changes)
    throw new AppError(409, 'This mailbox has reached its storage quota');
  const jobId = id(),
    payloadKey = `outbox/${payload.mailboxId}/${jobId}.json`,
    timestamp = now();
  try {
    await env.FILES.put(
      payloadKey,
      JSON.stringify({ ...payload, html: cleanHtml(payload.html) }),
    );
    const statements = [
      env.DB.prepare(
        'INSERT INTO send_jobs(id,mailbox_id,user_id,draft_id,provider,domain_id,payload_key,due_at,created_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        jobId,
        payload.mailboxId,
        options.userId,
        options.draftId || null,
        address.provider,
        address.domain_id,
        payloadKey,
        options.dueAt,
        timestamp,
        options.idempotencyKey,
      ),
    ];
    if (options.draftId) {
      statements.push(
        env.DB.prepare(
          'UPDATE attachments SET draft_id=NULL,job_id=? WHERE draft_id=?',
        ).bind(jobId, options.draftId),
      );
      statements.push(
        env.DB.prepare('DELETE FROM drafts WHERE id=?').bind(options.draftId),
      );
    }
    for (const p of recipients)
      statements.push(
        env.DB.prepare(
          'INSERT INTO deliveries(job_id,recipient,status,updated_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
        ).bind(jobId, p.address, 'pending', timestamp),
      );
    await env.DB.batch(statements);
  } catch (e) {
    await env.DB.prepare(
      'UPDATE mailboxes SET used_bytes=MAX(0,used_bytes-?) WHERE id=?',
    )
      .bind(payload.size, payload.mailboxId)
      .run();
    await env.FILES.delete(payloadKey);
    const duplicate = await env.DB.prepare(
      'SELECT id,status,due_at FROM send_jobs WHERE idempotency_key=?',
    )
      .bind(options.idempotencyKey)
      .first<{ id: string; status: string; due_at: number }>();
    if (duplicate) return duplicate;
    throw e;
  }
  try {
    await env.JOBS.send(
      { kind: 'send', id: jobId },
      {
        delaySeconds: Math.min(
          86400,
          Math.max(0, Math.ceil((options.dueAt - now()) / 1000)),
        ),
      },
    );
  } catch {
    /* The scheduled dispatcher recovers durable pending jobs. */
  }
  await notifyMailbox(env, payload.mailboxId);
  return { id: jobId, status: 'pending', due_at: options.dueAt };
}
export async function sendSystemEmail(
  env: Env,
  recipient: string,
  subject: string,
  text: string,
  addressId?: string,
) {
  const address = addressId
    ? await env.DB.prepare(
        "SELECT a.id,a.mailbox_id,a.email,a.name FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.id=? AND a.active=1 AND d.sending_status='ready'",
      )
        .bind(addressId)
        .first<{
          id: string;
          mailbox_id: string;
          email: string;
          name: string;
        }>()
    : await env.DB.prepare(
        "SELECT a.id,a.mailbox_id,a.email,a.name FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.active=1 AND d.sending_status='ready' ORDER BY a.id LIMIT 1",
      ).first<{
        id: string;
        mailbox_id: string;
        email: string;
        name: string;
      }>();
  if (!address)
    throw new AppError(400, 'No verified sending address is available');
  const html = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  return enqueueSend(
    env,
    {
      mailboxId: address.mailbox_id,
      addressId: address.id,
      from: { address: address.email, name: address.name },
      to: [{ address: recipient }],
      cc: [],
      bcc: [],
      subject,
      html,
      text,
      attachments: [],
      threadId: null,
      inReplyTo: '',
      references: [],
      size: new TextEncoder().encode(text + html).length + 4096,
    },
    { userId: null, dueAt: now(), idempotencyKey: `system:${token()}` },
  );
}
function toProviderAddress(
  p: Participant,
): string | { email: string; name: string } {
  return p.name ? { email: p.address, name: p.name } : p.address;
}
function resentAddress(p: Participant) {
  return p.name
    ? `${p.name.replace(/[<>"\r\n]/g, '')} <${p.address}>`
    : p.address;
}
export async function dispatchSend(env: Env, jobId: string) {
  const timestamp = now();
  const claim = await env.DB.prepare(
    "UPDATE send_jobs SET status='sending',lease_until=?,started_at=COALESCE(started_at,?),attempts=attempts+1 WHERE id=? AND status IN ('pending','queued') AND due_at<=? RETURNING *",
  )
    .bind(timestamp + 5 * 60_000, timestamp, jobId, timestamp)
    .first<Job>();
  if (!claim) return;
  let payload: SendPayload;
  try {
    const object = await env.FILES.get(claim.payload_key);
    if (!object) throw new Error('Saved message is missing');
    payload = await object.json<SendPayload>();
    const address = await env.DB.prepare(
      "SELECT 1 FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.id=? AND a.active=1 AND d.sending_status='ready' AND d.provider=?",
    )
      .bind(payload.addressId, claim.provider)
      .first();
    if (!address) throw new Error('The sending address is no longer available');
  } catch (e) {
    await env.DB.prepare(
      "UPDATE send_jobs SET status='failed',last_error=?,lease_until=NULL WHERE id=?",
    )
      .bind(
        e instanceof Error ? e.message : 'Saved message could not be loaded',
        jobId,
      )
      .run();
    return;
  }
  let providerId = '';
  try {
    const attachments = [];
    for (const attachment of payload.attachments) {
      const object = await env.FILES.get(attachment.object_key);
      if (!object) throw new AppError(400, 'An attachment is missing');
      const bytes = new Uint8Array(await object.arrayBuffer());
      attachments.push({
        filename: attachment.filename,
        content: base64(bytes),
        type: attachment.content_type,
        disposition: attachment.inline ? 'inline' : 'attachment',
        contentId: attachment.cid || undefined,
      });
    }
    const headers: Record<string, string> = { 'X-YouGotMail-Job': jobId };
    if (payload.inReplyTo) headers['In-Reply-To'] = payload.inReplyTo;
    if (payload.references.length)
      headers.References = payload.references.slice(-20).join(' ').slice(-2000);
    if (claim.provider === 'cloudflare') {
      if (!env.EMAIL)
        throw new AppError(400, 'The Cloudflare Email binding is unavailable');
      const result = await env.EMAIL.send({
        from: toProviderAddress(payload.from),
        to: payload.to.map(toProviderAddress),
        ...(payload.cc.length ? { cc: payload.cc.map(toProviderAddress) } : {}),
        ...(payload.bcc.length
          ? { bcc: payload.bcc.map(toProviderAddress) }
          : {}),
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        headers,
        attachments: attachments.map((a) =>
          a.disposition === 'inline' && a.contentId
            ? {
                filename: a.filename,
                type: a.type,
                content: a.content,
                disposition: 'inline' as const,
                contentId: a.contentId,
              }
            : {
                filename: a.filename,
                type: a.type,
                content: a.content,
                disposition: 'attachment' as const,
              },
        ),
      });
      providerId = result.messageId;
    } else {
      const config = await getIntegration<ResendConnection>(env, 'resend');
      if (!config) throw new AppError(400, 'Resend is not connected');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `yougotmail/${jobId}`,
        },
        body: JSON.stringify({
          from: resentAddress(payload.from),
          to: payload.to.map(resentAddress),
          ...(payload.cc.length ? { cc: payload.cc.map(resentAddress) } : {}),
          ...(payload.bcc.length
            ? { bcc: payload.bcc.map(resentAddress) }
            : {}),
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          headers,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            ...(a.contentId ? { content_id: a.contentId } : {}),
          })),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const result = (await response.json()) as {
        id?: string;
        message?: string;
      };
      if (!response.ok)
        throw Object.assign(
          new Error(result.message || 'Resend rejected this message'),
          {
            rejected: true,
            temporary: response.status === 429 || response.status >= 500,
          },
        );
      if (!result.id)
        throw new Error('Resend did not return a message identifier');
      providerId = result.id;
    }
  } catch (e) {
    const error = e as Error & {
      code?: string;
      rejected?: boolean;
      temporary?: boolean;
    };
    const definitive =
      e instanceof AppError ||
      error.rejected ||
      (!!error.code && error.code !== 'E_INTERNAL_SERVER_ERROR');
    const retryable =
      claim.provider === 'resend' &&
      claim.attempts < 4 &&
      now() - (claim.started_at || timestamp) < 23 * 3600_000 &&
      (error.temporary || !definitive);
    const status = retryable ? 'pending' : definitive ? 'failed' : 'uncertain';
    await env.DB.prepare(
      'UPDATE send_jobs SET status=?,last_error=?,lease_until=NULL,due_at=? WHERE id=?',
    )
      .bind(
        status,
        definitive
          ? error.message
          : 'The provider response was interrupted. Delivery may have occurred; review before retrying.',
        now() + Math.min(3600_000, 60_000 * 2 ** claim.attempts),
        jobId,
      )
      .run();
    await notifyMailbox(env, claim.mailbox_id);
    return;
  }
  // Persist acceptance before writing the Sent copy. A later storage failure must never cause another provider call.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE send_jobs SET status='accepted',provider_id=?,lease_until=NULL,last_error='' WHERE id=?",
    ).bind(providerId, jobId),
    env.DB.prepare(
      "UPDATE deliveries SET status='accepted',updated_at=? WHERE job_id=? AND status='pending'",
    ).bind(now(), jobId),
  ]);
  await materializeSent(env, claim, payload, providerId);
  const pending = (
    await env.DB.prepare(
      'SELECT payload FROM pending_events WHERE provider_id=?',
    )
      .bind(providerId)
      .all<{ payload: string }>()
  ).results;
  for (const event of pending)
    await handleDelivery(env, JSON.parse(event.payload));
  await notifyMailbox(env, claim.mailbox_id);
}
export async function materializeSent(
  env: Env,
  job: Job,
  payload?: SendPayload,
  providerId?: string,
) {
  if (!payload) {
    const object = await env.FILES.get(job.payload_key);
    if (!object) throw new Error('Outbox snapshot missing');
    payload = await object.json<SendPayload>();
  }
  const provider = providerId || job.provider_id;
  // Cloudflare generates its own Message-ID. Never supply a platform-controlled header.
  const internetId = provider.includes('@')
    ? provider.startsWith('<')
      ? provider
      : `<${provider}>`
    : '';
  await storeMessage(env, {
    mailboxId: payload.mailboxId,
    direction: 'outgoing',
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    date: job.started_at || now(),
    internetId,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    rawKey: '',
    html: payload.html,
    text: payload.text,
    attachments: payload.attachments,
    fingerprint: `outgoing:${job.id}`,
    size: payload.size,
    threadId: payload.threadId,
    providerId: provider,
    jobId: job.id,
  });
}
type DeliveryEvent = {
  id: string;
  provider: 'cloudflare' | 'resend';
  providerId: string;
  recipients: string[];
  status: string;
  detail: string;
  at: number;
};
export async function handleDelivery(env: Env, event: DeliveryEvent) {
  if (!event.id || !event.providerId) return;
  if (
    await env.DB.prepare('SELECT 1 FROM events WHERE id=?')
      .bind(event.id)
      .first()
  )
    return;
  const job = await env.DB.prepare(
    'SELECT id,mailbox_id FROM send_jobs WHERE provider_id=? AND provider=?',
  )
    .bind(event.providerId, event.provider)
    .first<{ id: string; mailbox_id: string }>();
  if (!job) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO pending_events(id,provider_id,payload,created_at) VALUES(?,?,?,?)',
    )
      .bind(event.id, event.providerId, JSON.stringify(event), now())
      .run();
    return;
  }
  const recipients = event.recipients.length
    ? event.recipients
    : (
        await env.DB.prepare('SELECT recipient FROM deliveries WHERE job_id=?')
          .bind(job.id)
          .all<{ recipient: string }>()
      ).results.map((r) => r.recipient);
  const statements = [
    env.DB.prepare(
      'INSERT OR IGNORE INTO events(id,provider,created_at) VALUES(?,?,?)',
    ).bind(event.id, event.provider, now()),
  ];
  for (const recipient of recipients)
    statements.push(
      env.DB.prepare(
        "UPDATE deliveries SET status=?,detail=?,updated_at=? WHERE job_id=? AND recipient=? AND updated_at<=? AND (status NOT IN ('bounced','failed','complained') OR ?='complained') AND (status<>'delivered' OR ? IN ('complained','bounced'))",
      ).bind(
        event.status,
        event.detail.slice(0, 500),
        event.at,
        job.id,
        recipient,
        event.at,
        event.status,
        event.status,
      ),
    );
  statements.push(
    env.DB.prepare('DELETE FROM pending_events WHERE id=?').bind(event.id),
  );
  await env.DB.batch(statements);
  const states = (
    await env.DB.prepare('SELECT status FROM deliveries WHERE job_id=?')
      .bind(job.id)
      .all<{ status: string }>()
  ).results.map((r) => r.status);
  const status = states.every((s) => s === 'delivered')
    ? 'delivered'
    : states.some((s) => ['bounced', 'failed', 'complained'].includes(s))
      ? 'delivery_failed'
      : 'accepted';
  await env.DB.prepare('UPDATE send_jobs SET status=? WHERE id=?')
    .bind(status, job.id)
    .run();
  await notifyMailbox(env, job.mailbox_id);
}
export async function cloudflareEvent(env: Env, value: unknown) {
  const event = value as {
    type?: string;
    source?: { zoneId?: string; domain?: string };
    payload?: {
      eventId?: string;
      messageId?: string;
      recipient?: string;
      delivery?: { smtpResponse?: string };
      bounce?: { reason?: string };
      failure?: { reason?: string };
    };
    metadata?: {
      accountId?: string;
      eventTimestamp?: string;
      eventSubscriptionId?: string;
    };
  };
  if (
    !event.type?.startsWith('cf.email.sending.') ||
    !event.payload?.eventId ||
    !event.source?.domain
  )
    return;
  const connection = await getIntegration<{ accountId: string }>(
    env,
    'cloudflare',
  );
  if (!connection || connection.accountId !== event.metadata?.accountId) return;
  const domain = await env.DB.prepare(
    'SELECT event_subscription_id FROM domains WHERE name=? AND zone_id=?',
  )
    .bind(event.source.domain, event.source.zoneId || '')
    .first<{ event_subscription_id: string }>();
  if (
    !domain ||
    !domain.event_subscription_id ||
    domain.event_subscription_id !== event.metadata?.eventSubscriptionId
  )
    return;
  const suffix = event.type.split('.').at(-1) || '';
  const status = (
    {
      delivered: 'delivered',
      deferred: 'deferred',
      bounced: 'bounced',
      failed: 'failed',
      rejected: 'failed',
      complained: 'complained',
    } as Record<string, string>
  )[suffix];
  if (!status) return;
  const parsedAt = Date.parse(event.metadata?.eventTimestamp || '');
  await handleDelivery(env, {
    id: `cf:${event.payload.eventId}`,
    provider: 'cloudflare',
    providerId: event.payload.messageId || '',
    recipients: event.payload.recipient ? [event.payload.recipient] : [],
    status,
    detail:
      event.payload.bounce?.reason ||
      event.payload.failure?.reason ||
      event.payload.delivery?.smtpResponse ||
      '',
    at: Number.isFinite(parsedAt) ? parsedAt : now(),
  });
}
