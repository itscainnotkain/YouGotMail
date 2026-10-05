import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import type { Env } from './env';
import type { Participant, Filter } from '../shared/types';
import { id, json, now, notifyMailbox, setting } from './lib';
import { cleanHtml, storeMessage, type StoredAttachment } from './content';
import { sendSystemEmail } from './sending';

export async function resolveRecipient(
  env: Env,
  email: string,
): Promise<string | null> {
  const address = email.trim().toLowerCase();
  const exact = await env.DB.prepare(
    "SELECT a.mailbox_id FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.email=? AND a.active=1 AND d.receiving_status='ready'",
  )
    .bind(address)
    .first<{ mailbox_id: string }>();
  if (exact) return exact.mailbox_id;
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const local = address.slice(0, at),
    domain = address.slice(at + 1);
  if (local.includes('+')) {
    const base = await env.DB.prepare(
      "SELECT a.mailbox_id FROM addresses a JOIN domains d ON d.id=a.domain_id WHERE a.email=? AND a.active=1 AND d.receiving_status='ready'",
    )
      .bind(`${local.split('+')[0]}@${domain}`)
      .first<{ mailbox_id: string }>();
    if (base) return base.mailbox_id;
  }
  const catchAll = await env.DB.prepare(
    "SELECT catch_all_mailbox FROM domains WHERE name=? AND receiving_status='ready'",
  )
    .bind(domain)
    .first<{ catch_all_mailbox: string | null }>();
  return catchAll?.catch_all_mailbox || null;
}
export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const mailboxId = await resolveRecipient(env, message.to);
  if (!mailboxId) {
    message.setReject('Unknown recipient');
    return;
  }
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject('Message exceeds the 25 MiB limit');
    return;
  }
  const reserved = await env.DB.prepare(
    'UPDATE mailboxes SET used_bytes=used_bytes+? WHERE id=? AND used_bytes+?<=quota_bytes',
  )
    .bind(message.rawSize, mailboxId, message.rawSize)
    .run();
  if (!reserved.meta.changes) {
    message.setReject('Mailbox storage quota exceeded');
    return;
  }
  const ingestionId = id(),
    rawKey = `raw/${mailboxId}/${ingestionId}.eml`,
    hash = createHash('sha256');
  let bytes = 0,
    stored = false;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 25 * 1024 * 1024) throw new Error('Message too large');
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  try {
    // R2 requires a known stream length. Hashing through a TransformStream loses
    // the original length, so explicitly restore it without buffering the MIME.
    const fixed = new FixedLengthStream(message.rawSize);
    await Promise.all([
      (message.raw as ReadableStream<Uint8Array>)
        .pipeThrough(stream)
        .pipeTo(fixed.writable),
      env.FILES.put(rawKey, fixed.readable, {
        httpMetadata: { contentType: 'message/rfc822' },
      }),
    ]);
    const fingerprint = hash.digest('base64');
    const inserted = await env.DB.prepare(
      'INSERT OR IGNORE INTO ingestions(id,mailbox_id,envelope_from,envelope_to,raw_key,fingerprint,size,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
      .bind(
        ingestionId,
        mailboxId,
        message.from,
        message.to.toLowerCase(),
        rawKey,
        fingerprint,
        message.rawSize,
        now(),
      )
      .run();
    if (!inserted.meta.changes) {
      await env.DB.prepare(
        'UPDATE mailboxes SET used_bytes=MAX(0,used_bytes-?) WHERE id=?',
      )
        .bind(message.rawSize, mailboxId)
        .run();
      await env.FILES.delete(rawKey);
      return;
    }
    stored = true;
    try {
      await env.JOBS.send({ kind: 'ingest', id: ingestionId });
    } catch {
      /* A durable ingestion row is recovered by the scheduled handler. */
    }
  } catch {
    if (!stored) {
      await env.DB.prepare(
        'UPDATE mailboxes SET used_bytes=MAX(0,used_bytes-?) WHERE id=?',
      )
        .bind(message.rawSize, mailboxId)
        .run();
      await env.FILES.delete(rawKey);
      message.setReject('Mailbox storage is temporarily unavailable');
    }
  }
}
type Ingestion = {
  id: string;
  mailbox_id: string;
  envelope_from: string;
  envelope_to: string;
  raw_key: string;
  fingerprint: string;
  size: number;
};
function addresses(items: unknown): Participant[] {
  if (!Array.isArray(items)) return [];
  const out: Participant[] = [];
  for (const item of items) {
    if (item?.address)
      out.push({
        address: String(item.address).toLowerCase(),
        name: item.name || '',
      });
    if (item?.group) out.push(...addresses(item.group));
  }
  return out.slice(0, 1000);
}
export async function processIngestion(env: Env, ingestionId: string) {
  const ingestion = await env.DB.prepare(
    "UPDATE ingestions SET status='processing',attempts=attempts+1,lease_until=? WHERE id=? AND status='pending' RETURNING *",
  )
    .bind(now() + 5 * 60_000, ingestionId)
    .first<Ingestion>();
  if (!ingestion) return;
  try {
    const object = await env.FILES.get(ingestion.raw_key);
    if (!object) throw new Error('Original message is missing');
    let parsed: Awaited<ReturnType<PostalMime['parse']>> | null = null,
      parseError = '';
    try {
      parsed = await PostalMime.parse(await object.arrayBuffer(), {
        attachmentEncoding: 'arraybuffer',
        maxNestingDepth: 20,
        maxHeadersSize: 64 * 1024,
      });
    } catch {
      parseError =
        'The message could not be fully parsed. Download the original email to inspect it.';
    }
    const from = parsed?.from?.address
      ? {
          address: parsed.from.address.toLowerCase(),
          name: parsed.from.name || '',
        }
      : { address: ingestion.envelope_from, name: '' };
    const to = addresses(parsed?.to),
      cc = addresses(parsed?.cc),
      subject = (parsed?.subject || '(no subject)').slice(0, 998);
    const text = parsed?.text || (parseError ? parseError : ''),
      html = cleanHtml(parsed?.html || '');
    const attachments: StoredAttachment[] = [];
    for (const [index, attachment] of (parsed?.attachments || []).entries()) {
      const attachmentId = id(),
        key = `attachments/${ingestion.mailbox_id}/${ingestion.id}/${index}`;
      const content =
        typeof attachment.content === 'string'
          ? new TextEncoder().encode(attachment.content)
          : attachment.content;
      await env.FILES.put(key, content, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      attachments.push({
        id: attachmentId,
        filename: attachment.filename || 'attachment',
        content_type: attachment.mimeType || 'application/octet-stream',
        size: content.byteLength,
        object_key: key,
        cid: (attachment.contentId || '').replace(/^<|>$/g, ''),
        inline: attachment.disposition === 'inline' ? 1 : 0,
      });
    }
    let folder = 'inbox',
      markRead = false,
      star = false;
    const labels: string[] = [];
    const blocked = await env.DB.prepare(
      'SELECT 1 FROM blocked_senders WHERE mailbox_id=? AND (sender=? OR sender=?)',
    )
      .bind(
        ingestion.mailbox_id,
        from.address,
        `@${from.address.split('@')[1]}`,
      )
      .first();
    // Only Cloudflare-authenticated metadata should be used for trust decisions. User-supplied Authentication-Results is not trusted.
    if (blocked) folder = 'spam';
    const filters = (
      await env.DB.prepare(
        'SELECT * FROM filters WHERE mailbox_id=? AND enabled=1 ORDER BY position,id',
      )
        .bind(ingestion.mailbox_id)
        .all<{ conditions: string; actions: string }>()
    ).results;
    for (const filter of filters) {
      const match = json<Filter['conditions']>(filter.conditions, {}),
        actions = json<Filter['actions']>(filter.actions, {});
      if (
        match.from &&
        !`${from.name} ${from.address}`
          .toLowerCase()
          .includes(match.from.toLowerCase())
      )
        continue;
      if (
        match.to &&
        ![...to, ...cc, { address: ingestion.envelope_to }].some((p) =>
          p.address.toLowerCase().includes(match.to!.toLowerCase()),
        )
      )
        continue;
      if (
        match.subject &&
        !subject.toLowerCase().includes(match.subject.toLowerCase())
      )
        continue;
      if (match.text && !text.toLowerCase().includes(match.text.toLowerCase()))
        continue;
      if (match.hasAttachment && !attachments.length) continue;
      if (actions.spam) folder = 'spam';
      else if (actions.archive && folder !== 'spam') folder = 'archived';
      if (actions.star) star = true;
      if (actions.markRead) markRead = true;
      if (actions.labelId) labels.push(actions.labelId);
    }
    const parsedDate = Date.parse(parsed?.date || '');
    const refs = (parsed?.references || '').match(/<[^<>\s]+>/g) || [];
    await storeMessage(env, {
      mailboxId: ingestion.mailbox_id,
      direction: 'incoming',
      from,
      replyTo: addresses(parsed?.replyTo),
      to: to.length ? to : [{ address: ingestion.envelope_to }],
      cc,
      subject,
      date: Number.isFinite(parsedDate)
        ? Math.min(parsedDate, now() + 5 * 60_000)
        : now(),
      internetId: parsed?.messageId || '',
      inReplyTo: parsed?.inReplyTo || '',
      references: refs.slice(-100),
      rawKey: ingestion.raw_key,
      html,
      text,
      attachments,
      fingerprint: ingestion.fingerprint,
      size: ingestion.size,
      parseError,
      folder: folder === 'inbox' ? undefined : folder,
      markRead,
      star,
      labelIds: labels,
    });
    await env.DB.prepare(
      "UPDATE ingestions SET status='done',lease_until=NULL,error='' WHERE id=?",
    )
      .bind(ingestionId)
      .run();
    await notifyMailbox(env, ingestion.mailbox_id);
    if (folder !== 'spam' && parsed && !parseError)
      await vacationReply(env, ingestion, parsed, from.address);
  } catch (e) {
    await env.DB.prepare(
      "UPDATE ingestions SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,lease_until=NULL,error=? WHERE id=?",
    )
      .bind(
        e instanceof Error ? e.message.slice(0, 300) : 'Processing failed',
        ingestionId,
      )
      .run();
    throw e;
  }
}
async function vacationReply(
  env: Env,
  ingestion: Ingestion,
  parsed: Awaited<ReturnType<PostalMime['parse']>>,
  sender: string,
) {
  const box = await env.DB.prepare('SELECT vacation FROM mailboxes WHERE id=?')
    .bind(ingestion.mailbox_id)
    .first<{ vacation: string }>();
  const vacation = json<{
      enabled?: boolean;
      start?: number;
      end?: number;
      subject?: string;
      text?: string;
    }>(box?.vacation, {}),
    timestamp = now();
  if (
    !vacation.enabled ||
    !vacation.start ||
    !vacation.end ||
    timestamp < vacation.start ||
    timestamp > vacation.end ||
    !sender ||
    sender === ingestion.envelope_to
  )
    return;
  const headers = new Map(
    parsed.headers.map((h) => [h.key.toLowerCase(), h.value]),
  );
  if (
    headers.has('list-id') ||
    headers.has('list-unsubscribe') ||
    headers.has('x-yougotmail-job') ||
    ['bulk', 'list', 'junk'].includes(headers.get('precedence') || '') ||
    (headers.get('auto-submitted') && headers.get('auto-submitted') !== 'no') ||
    /mailer-daemon|postmaster|no-?reply/i.test(sender)
  )
    return;
  const claim = await env.DB.prepare(
    'INSERT INTO vacation_replies(mailbox_id,sender,last_sent) VALUES(?,?,?) ON CONFLICT(mailbox_id,sender) DO UPDATE SET last_sent=excluded.last_sent WHERE last_sent<? RETURNING last_sent',
  )
    .bind(ingestion.mailbox_id, sender, timestamp, timestamp - 86400_000)
    .first();
  if (!claim) return;
  const address = await env.DB.prepare(
    'SELECT id FROM addresses WHERE mailbox_id=? AND active=1 ORDER BY email=? DESC LIMIT 1',
  )
    .bind(ingestion.mailbox_id, ingestion.envelope_to)
    .first<{ id: string }>();
  if (!address) return;
  try {
    await sendSystemEmail(
      env,
      sender,
      vacation.subject || 'Out of office',
      vacation.text || 'I am currently away and will reply when I return.',
      address.id,
    );
  } catch {
    await env.DB.prepare(
      'DELETE FROM vacation_replies WHERE mailbox_id=? AND sender=? AND last_sent=?',
    )
      .bind(ingestion.mailbox_id, sender, timestamp)
      .run();
  }
}
