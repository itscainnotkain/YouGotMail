import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { AppError } from './env';
import { authenticate } from './auth';
import {
  body,
  colorSchema,
  id,
  json,
  mailboxAccess,
  nameSchema,
  now,
  notifyMailbox,
  participantSchema,
  readLimited,
  safeFilename,
  contentDisposition,
} from './lib';
import {
  cleanHtml,
  htmlText,
  escapeHtml,
  type StoredAttachment,
} from './content';
import { base64, unbase64 } from './crypto';
import { deleteThread } from './jobs';
import { enqueueSend, type SendPayload } from './sending';
import type { Participant } from '../shared/types';

export const mail = new Hono<AppEnv>();
mail.use('*', authenticate);
const belongs =
  'EXISTS(SELECT 1 FROM mailbox_members mm WHERE mm.mailbox_id=t.mailbox_id AND mm.user_id=?)';
export function searchQuery(input: string) {
  const tokens = input.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) || [];
  const result: {
    text: string[];
    from: string[];
    to: string[];
    subject: string[];
    before?: number;
    after?: number;
    unread?: boolean;
    starred?: boolean;
    attachment?: boolean;
    labels: string[];
  } = { text: [], from: [], to: [], subject: [], labels: [] };
  for (const token of tokens) {
    const colon = token.indexOf(':'),
      key = colon > 0 ? token.slice(0, colon).toLowerCase() : '',
      value = (colon > 0 ? token.slice(colon + 1) : token).replace(
        /^"|"$/g,
        '',
      );
    if (['from', 'to', 'subject'].includes(key)) {
      result[key as 'from' | 'to' | 'subject'].push(value);
      continue;
    }
    if (key === 'label') {
      result.labels.push(value);
      continue;
    }
    if (key === 'is' && ['unread', 'read', 'starred'].includes(value)) {
      if (value === 'starred') result.starred = true;
      else result.unread = value === 'unread';
      continue;
    }
    if (key === 'has' && value === 'attachment') {
      result.attachment = true;
      continue;
    }
    if (['before', 'after'].includes(key)) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) {
        result[key as 'before' | 'after'] = time;
        continue;
      }
    }
    if (value) result.text.push(token.replace(/^"|"$/g, ''));
  }
  return result;
}
const like = (value: string) =>
  `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
mail.get('/mailboxes', async (c) => {
  const boxes = (
    await c.env.DB.prepare(
      "SELECT b.*,(SELECT COUNT(*) FROM threads t WHERE t.mailbox_id=b.id AND t.folder='inbox' AND t.unread=1 AND t.snoozed_until IS NULL) unread FROM mailboxes b JOIN mailbox_members mm ON mm.mailbox_id=b.id WHERE mm.user_id=? ORDER BY b.kind,b.name",
    )
      .bind(c.get('user').id)
      .all()
  ).results;
  const addresses = (
    await c.env.DB.prepare(
      'SELECT a.*,d.provider,d.sending_status FROM addresses a JOIN domains d ON d.id=a.domain_id JOIN mailbox_members mm ON mm.mailbox_id=a.mailbox_id WHERE mm.user_id=? ORDER BY a.email',
    )
      .bind(c.get('user').id)
      .all()
  ).results;
  return c.json(
    boxes.map((b) => ({
      ...b,
      addresses: addresses.filter((a) => a.mailbox_id === b.id),
    })),
  );
});
mail.get('/counts', async (c) => {
  const mailbox = c.req.query('mailbox') || '',
    user = c.get('user').id;
  const extra = mailbox ? ' AND t.mailbox_id=?' : '';
  const counts = (
    await c.env.DB.prepare(
      `SELECT t.folder,COUNT(*) count,SUM(CASE WHEN t.snoozed_until IS NULL THEN t.unread ELSE 0 END) unread,SUM(t.starred) starred,SUM(CASE WHEN t.snoozed_until IS NOT NULL THEN 1 ELSE 0 END) snoozed FROM threads t WHERE ${belongs}${extra} GROUP BY t.folder`,
    )
      .bind(user, ...(mailbox ? [mailbox] : []))
      .all<{
        folder: string;
        count: number;
        unread: number;
        starred: number;
        snoozed: number;
      }>()
  ).results;
  const drafts = await c.env.DB.prepare(
    `SELECT COUNT(*) count FROM drafts t WHERE ${belongs}${extra}`,
  )
    .bind(user, ...(mailbox ? [mailbox] : []))
    .first<{ count: number }>();
  const jobs = await c.env.DB.prepare(
    `SELECT COUNT(*) count FROM send_jobs t WHERE ${belongs}${extra} AND status IN ('pending','queued','sending','failed','uncertain')`,
  )
    .bind(user, ...(mailbox ? [mailbox] : []))
    .first<{ count: number }>();
  return c.json({
    folders: counts,
    drafts: drafts?.count || 0,
    scheduled: jobs?.count || 0,
  });
});
mail.get('/threads', async (c) => {
  const folder = z
    .enum(['inbox', 'sent', 'all', 'spam', 'trash', 'starred', 'snoozed'])
    .parse(c.req.query('folder') || 'inbox');
  const where = [belongs],
    args: unknown[] = [c.get('user').id];
  const mailbox = c.req.query('mailbox');
  if (mailbox) {
    where.push('t.mailbox_id=?');
    args.push(mailbox);
  }
  if (folder === 'inbox')
    where.push("t.folder='inbox' AND t.snoozed_until IS NULL");
  else if (folder === 'sent')
    where.push(
      "t.folder NOT IN ('spam','trash') AND EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.direction='outgoing')",
    );
  else if (folder === 'starred')
    where.push("t.starred=1 AND t.folder NOT IN ('spam','trash')");
  else if (folder === 'snoozed')
    where.push(
      "t.snoozed_until IS NOT NULL AND t.folder NOT IN ('spam','trash')",
    );
  else if (folder === 'all') where.push("t.folder NOT IN ('spam','trash')");
  else {
    where.push('t.folder=?');
    args.push(folder);
  }
  const label = c.req.query('label');
  if (label) {
    where.push(
      'EXISTS(SELECT 1 FROM thread_labels tl WHERE tl.thread_id=t.id AND tl.label_id=?)',
    );
    args.push(label);
  }
  const search = searchQuery((c.req.query('q') || '').slice(0, 1000));
  for (const value of search.from) {
    where.push(
      "EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND (m.from_address LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\'))",
    );
    args.push(like(value), like(value));
  }
  for (const value of search.to) {
    where.push(
      "EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND (m.to_json LIKE ? ESCAPE '\\' OR m.cc_json LIKE ? ESCAPE '\\' OR (m.direction='outgoing' AND m.bcc_json LIKE ? ESCAPE '\\')))",
    );
    args.push(like(value), like(value), like(value));
  }
  for (const value of search.subject) {
    where.push("t.subject LIKE ? ESCAPE '\\'");
    args.push(like(value));
  }
  if (search.before !== undefined) {
    where.push('t.updated_at<?');
    args.push(search.before);
  }
  if (search.after !== undefined) {
    where.push('t.updated_at>?');
    args.push(search.after);
  }
  if (search.unread !== undefined) {
    where.push('t.unread=?');
    args.push(search.unread ? 1 : 0);
  }
  if (search.starred) where.push('t.starred=1');
  if (search.attachment) where.push('t.has_attachments=1');
  for (const labelName of search.labels) {
    where.push(
      'EXISTS(SELECT 1 FROM thread_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.thread_id=t.id AND l.name=? COLLATE NOCASE)',
    );
    args.push(labelName);
  }
  if (search.text.length) {
    where.push(
      'EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.id IN (SELECT message_id FROM search_chunks WHERE search_chunks MATCH ?))',
    );
    args.push(
      search.text.map((v) => `"${v.replace(/"/g, '""')}"`).join(' AND '),
    );
  }
  if (c.req.query('cursor')) {
    try {
      const cursor = JSON.parse(
        new TextDecoder().decode(unbase64(c.req.query('cursor')!)),
      ) as { time: number; id: string };
      if (!Number.isFinite(cursor.time) || typeof cursor.id !== 'string')
        throw new Error();
      where.push('(t.updated_at<? OR (t.updated_at=? AND t.id<?))');
      args.push(cursor.time, cursor.time, cursor.id);
    } catch {
      throw new AppError(400, 'Invalid page cursor');
    }
  }
  const rows = (
    await c.env.DB.prepare(
      `SELECT t.*,b.name mailbox_name,(SELECT j.status FROM send_jobs j JOIN messages m ON m.id=j.message_id WHERE m.thread_id=t.id ORDER BY j.created_at DESC LIMIT 1) delivery_status FROM threads t JOIN mailboxes b ON b.id=t.mailbox_id WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC,t.id DESC LIMIT 51`,
    )
      .bind(...args)
      .all<Record<string, unknown>>()
  ).results;
  const hasMore = rows.length > 50,
    page = rows.slice(0, 50);
  const labels = (
    await c.env.DB.prepare(
      `SELECT tl.thread_id,l.* FROM thread_labels tl JOIN labels l ON l.id=tl.label_id JOIN mailbox_members mm ON mm.mailbox_id=l.mailbox_id WHERE mm.user_id=?`,
    )
      .bind(c.get('user').id)
      .all()
  ).results;
  const last = page.at(-1);
  return c.json({
    items: page.map((t) => ({
      ...t,
      participants: json(String(t.participants), []),
      labels: labels.filter((l) => l.thread_id === t.id),
    })),
    cursor:
      hasMore && last
        ? base64(
            new TextEncoder().encode(
              JSON.stringify({ time: last.updated_at, id: last.id }),
            ),
          )
        : null,
  });
});
mail.get('/threads/:id', async (c) => {
  const thread = await c.env.DB.prepare('SELECT * FROM threads WHERE id=?')
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!thread) throw new AppError(404, 'Conversation not found');
  await mailboxAccess(c.env, c.get('user'), String(thread.mailbox_id));
  let cursorTime = Number.MAX_SAFE_INTEGER,
    cursorId = '~';
  if (c.req.query('cursor')) {
    try {
      const v = JSON.parse(
        new TextDecoder().decode(unbase64(c.req.query('cursor')!)),
      );
      cursorTime = v.time;
      cursorId = v.id;
      if (!Number.isFinite(cursorTime) || typeof cursorId !== 'string')
        throw new Error();
    } catch {
      throw new AppError(400, 'Invalid page cursor');
    }
  }
  const rows = (
    await c.env.DB.prepare(
      'SELECT m.*,(SELECT status FROM send_jobs j WHERE j.message_id=m.id) delivery_status FROM messages m WHERE thread_id=? AND (date<? OR (date=? AND id<?)) ORDER BY date DESC,id DESC LIMIT 51',
    )
      .bind(thread.id, cursorTime, cursorTime, cursorId)
      .all<Record<string, unknown>>()
  ).results;
  const hasMore = rows.length > 50,
    page = rows.slice(0, 50),
    last = page.at(-1),
    messages = [];
  for (const m of page.reverse()) {
    const object = await c.env.FILES.get(String(m.body_key));
    const content = object
      ? await object.json<{ html: string; text: string }>()
      : { html: '', text: 'Message body is temporarily unavailable.' };
    const attachments = (
      await c.env.DB.prepare(
        'SELECT id,filename,content_type,size,cid,inline FROM attachments WHERE message_id=?',
      )
        .bind(m.id)
        .all()
    ).results;
    const deliveries = (
      await c.env.DB.prepare(
        'SELECT recipient,status,detail FROM deliveries WHERE job_id IN (SELECT id FROM send_jobs WHERE message_id=?)',
      )
        .bind(m.id)
        .all()
    ).results;
    messages.push({
      ...m,
      ...content,
      reply_to: json(String(m.reply_to_json), []),
      to: json(String(m.to_json), []),
      cc: json(String(m.cc_json), []),
      bcc: m.direction === 'outgoing' ? json(String(m.bcc_json), []) : [],
      references: json(String(m.references_json), []),
      attachments,
      deliveries,
    });
  }
  const labels = (
    await c.env.DB.prepare(
      'SELECT l.* FROM labels l JOIN thread_labels tl ON tl.label_id=l.id WHERE tl.thread_id=?',
    )
      .bind(thread.id)
      .all()
  ).results;
  return c.json({
    thread: {
      ...thread,
      participants: json(String(thread.participants), []),
      labels,
    },
    messages,
    cursor:
      hasMore && last
        ? base64(
            new TextEncoder().encode(
              JSON.stringify({ time: last.date, id: last.id }),
            ),
          )
        : null,
  });
});
const actionSchema = z.object({
  ids: z.array(z.string().max(100)).min(1).max(100),
  action: z.enum([
    'archive',
    'inbox',
    'spam',
    'trash',
    'read',
    'unread',
    'star',
    'unstar',
    'snooze',
    'unsnooze',
    'label',
    'unlabel',
    'delete',
  ]),
  labelId: z.string().uuid().optional(),
  until: z.number().int().optional(),
});
mail.post('/threads/actions', async (c) => {
  const data = await body(c, actionSchema),
    marks = data.ids.map(() => '?').join(',');
  const threads = (
    await c.env.DB.prepare(
      `SELECT t.id,t.mailbox_id,t.folder FROM threads t WHERE t.id IN (${marks}) AND ${belongs}`,
    )
      .bind(...data.ids, c.get('user').id)
      .all<{ id: string; mailbox_id: string; folder: string }>()
  ).results;
  if (threads.length !== new Set(data.ids).size)
    throw new AppError(404, 'One or more conversations are unavailable');
  if (data.action === 'delete') {
    if (threads.some((t) => !['trash', 'spam'].includes(t.folder)))
      throw new AppError(
        400,
        'Move conversations to Trash before deleting permanently',
      );
    for (const t of threads) await deleteThread(c.env, t.id, t.mailbox_id);
    return c.json({ ok: true });
  }
  const statements: D1PreparedStatement[] = [];
  if (['label', 'unlabel'].includes(data.action)) {
    if (!data.labelId) throw new AppError(400, 'Choose a label');
    const label = await c.env.DB.prepare(
      'SELECT mailbox_id FROM labels WHERE id=?',
    )
      .bind(data.labelId)
      .first<{ mailbox_id: string }>();
    if (!label || threads.some((t) => t.mailbox_id !== label.mailbox_id))
      throw new AppError(
        400,
        'Labels belong to one mailbox. Select conversations in that mailbox.',
      );
    for (const t of threads)
      statements.push(
        c.env.DB.prepare(
          data.action === 'label'
            ? 'INSERT OR IGNORE INTO thread_labels(thread_id,label_id) VALUES(?,?)'
            : 'DELETE FROM thread_labels WHERE thread_id=? AND label_id=?',
        ).bind(t.id, data.labelId),
      );
  } else {
    let set = '',
      args: unknown[] = [];
    if (['archive', 'inbox', 'spam', 'trash'].includes(data.action)) {
      set = 'folder=?,deleted_at=?,snoozed_until=NULL';
      args = [
        data.action === 'archive' ? 'archived' : data.action,
        ['trash', 'spam'].includes(data.action) ? now() : null,
      ];
    } else if (['read', 'unread'].includes(data.action)) {
      set = 'unread=?';
      args = [data.action === 'unread' ? 1 : 0];
    } else if (['star', 'unstar'].includes(data.action)) {
      set = 'starred=?';
      args = [data.action === 'star' ? 1 : 0];
    } else {
      if (
        data.action === 'snooze' &&
        (!data.until ||
          data.until < now() ||
          data.until > now() + 366 * 86400_000)
      )
        throw new AppError(400, 'Choose a snooze date in the next year');
      set = 'snoozed_until=?';
      args = [data.action === 'snooze' ? data.until : null];
    }
    statements.push(
      c.env.DB.prepare(`UPDATE threads SET ${set} WHERE id IN (${marks})`).bind(
        ...args,
        ...data.ids,
      ),
    );
  }
  await c.env.DB.batch(statements);
  for (const box of new Set(threads.map((t) => t.mailbox_id)))
    await notifyMailbox(c.env, box);
  return c.json({ ok: true });
});
mail.get('/messages/:id/render', async (c) => {
  const message = await c.env.DB.prepare(
    'SELECT mailbox_id,body_key FROM messages WHERE id=?',
  )
    .bind(c.req.param('id'))
    .first<{ mailbox_id: string; body_key: string }>();
  if (!message) throw new AppError(404, 'Message not found');
  await mailboxAccess(c.env, c.get('user'), message.mailbox_id);
  const object = await c.env.FILES.get(message.body_key);
  if (!object) throw new AppError(404, 'Message body not found');
  const body = await object.json<{ html: string; text: string }>(),
    origin = new URL(c.req.url).origin;
  const attachments = (
    await c.env.DB.prepare(
      "SELECT id,cid FROM attachments WHERE message_id=? AND cid<>''",
    )
      .bind(c.req.param('id'))
      .all<{ id: string; cid: string }>()
  ).results;
  const html = cleanHtml(body.html).replace(
    /cid:([^"'\s>]+)/g,
    (_match, cid) => {
      const a = attachments.find((a) => a.cid === cid);
      return a ? `${origin}/api/v1/mail/attachments/${a.id}?inline=1` : '';
    },
  );
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.7 system-ui,sans-serif;color:#2b3530;margin:0;padding:2px 0 12px;overflow-wrap:anywhere}p{margin:0 0 14px}img{max-width:100%;height:auto}blockquote{margin:15px 0;padding-left:16px;border-left:2px solid #dce3dd;color:#667169}a{color:#365c45}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${html || `<pre>${escapeHtml(body.text)}</pre>`}</body></html>`;
  return new Response(document, {
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${origin}${c.req.query('images') === '1' ? ' https:' : ''}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
    },
  });
});
mail.get('/messages/:id/source', async (c) => {
  const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id=?')
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!m) throw new AppError(404, 'Message not found');
  await mailboxAccess(c.env, c.get('user'), String(m.mailbox_id));
  if (m.raw_key) {
    const object = await c.env.FILES.get(String(m.raw_key));
    if (!object) throw new AppError(404, 'Original message not found');
    return new Response(object.body, {
      headers: {
        'Content-Type': 'message/rfc822',
        'Content-Disposition': contentDisposition(`${String(m.subject)}.eml`),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  // Outgoing snapshots are a faithful readable EML export, with BCC visible only in this mailbox's Sent copy.
  const object = await c.env.FILES.get(String(m.body_key));
  const content = object
    ? await object.json<{ text: string; html: string }>()
    : { text: '', html: '' };
  const { createMimeMessage } = await import('mimetext');
  const mime = createMimeMessage();
  mime.setSender({ addr: String(m.from_address), name: String(m.from_name) });
  mime.setRecipients(
    json<Participant[]>(String(m.to_json), []).map((p) => ({
      addr: p.address,
      name: p.name,
    })),
  );
  const cc = json<Participant[]>(String(m.cc_json), []),
    bcc = json<Participant[]>(String(m.bcc_json), []);
  if (cc.length) mime.setCc(cc.map((p) => ({ addr: p.address, name: p.name })));
  if (bcc.length)
    mime.setBcc(bcc.map((p) => ({ addr: p.address, name: p.name })));
  mime.setSubject(String(m.subject));
  mime.setHeader('Date', new Date(Number(m.date)).toUTCString());
  if (m.internet_id) mime.setHeader('Message-ID', String(m.internet_id));
  if (m.in_reply_to) mime.setHeader('In-Reply-To', String(m.in_reply_to));
  const refs = json<string[]>(String(m.references_json), []);
  if (refs.length) mime.setHeader('References', refs.join(' '));
  mime.addMessage({ contentType: 'text/plain', data: content.text });
  if (content.html)
    mime.addMessage({ contentType: 'text/html', data: content.html });
  for (const a of (
    await c.env.DB.prepare('SELECT * FROM attachments WHERE message_id=?')
      .bind(m.id)
      .all<StoredAttachment>()
  ).results) {
    const file = await c.env.FILES.get(a.object_key);
    if (file)
      mime.addAttachment({
        filename: a.filename,
        contentType: a.content_type,
        data: base64(new Uint8Array(await file.arrayBuffer())),
      });
  }
  return new Response(mime.asRaw(), {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': contentDisposition(`${String(m.subject)}.eml`),
      'Cache-Control': 'no-store',
    },
  });
});
mail.get('/attachments/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM attachments WHERE id=?')
    .bind(c.req.param('id'))
    .first<StoredAttachment & { mailbox_id: string }>();
  if (!a) throw new AppError(404, 'Attachment not found');
  await mailboxAccess(c.env, c.get('user'), a.mailbox_id);
  const object = await c.env.FILES.get(a.object_key);
  if (!object) throw new AppError(404, 'Attachment content not found');
  const inline =
    c.req.query('inline') === '1' &&
    /^image\/(png|jpeg|gif|webp|avif)$/.test(a.content_type);
  return new Response(object.body, {
    headers: {
      'Content-Type': inline ? a.content_type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(a.filename, inline),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
const draftSchema = z.object({
  mailbox_id: z.string().uuid(),
  address_id: z.string().uuid(),
  thread_id: z.string().max(100).nullable().default(null),
  subject: z
    .string()
    .max(998)
    .refine((v) => !/[\r\n]/.test(v), 'Subject must be one line')
    .default(''),
  to: z.array(participantSchema).max(50).default([]),
  cc: z.array(participantSchema).max(50).default([]),
  bcc: z.array(participantSchema).max(50).default([]),
  html: z.string().max(250_000).default(''),
  text: z.string().max(250_000).default(''),
  in_reply_to: z
    .string()
    .max(200)
    .refine((v) => !/[\r\n]/.test(v))
    .default(''),
  references: z
    .array(
      z
        .string()
        .max(200)
        .refine((v) => !/[\r\n]/.test(v)),
    )
    .max(100)
    .default([]),
});
async function validateDraft(
  c: Parameters<typeof body>[0],
  data: z.infer<typeof draftSchema>,
) {
  await mailboxAccess(c.env, c.get('user'), data.mailbox_id);
  if (
    !(await c.env.DB.prepare(
      'SELECT 1 FROM addresses WHERE id=? AND mailbox_id=? AND active=1',
    )
      .bind(data.address_id, data.mailbox_id)
      .first())
  )
    throw new AppError(400, 'Choose an active address in this mailbox');
  if (
    data.thread_id &&
    !(await c.env.DB.prepare(
      'SELECT 1 FROM threads WHERE id=? AND mailbox_id=?',
    )
      .bind(data.thread_id, data.mailbox_id)
      .first())
  )
    throw new AppError(400, 'Conversation does not belong to this mailbox');
}
function draftResult(
  row: Record<string, unknown>,
  attachments: unknown[] = [],
) {
  return {
    ...row,
    to: json(String(row.to_json), []),
    cc: json(String(row.cc_json), []),
    bcc: json(String(row.bcc_json), []),
    references: json(String(row.references_json), []),
    attachments,
  };
}
mail.get('/drafts', async (c) => {
  const mailbox = c.req.query('mailbox');
  return c.json(
    (
      await c.env.DB.prepare(
        `SELECT t.*,a.email from_address,u.name updated_by_name FROM drafts t JOIN addresses a ON a.id=t.address_id JOIN users u ON u.id=t.updated_by WHERE ${belongs}${mailbox ? ' AND t.mailbox_id=?' : ''} ORDER BY t.updated_at DESC LIMIT 200`,
      )
        .bind(c.get('user').id, ...(mailbox ? [mailbox] : []))
        .all()
    ).results.map((r) => draftResult(r)),
  );
});
mail.get('/drafts/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM drafts WHERE id=?')
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'Draft not found');
  await mailboxAccess(c.env, c.get('user'), String(row.mailbox_id));
  const attachments = (
    await c.env.DB.prepare(
      'SELECT id,filename,content_type,size,cid,inline FROM attachments WHERE draft_id=?',
    )
      .bind(row.id)
      .all()
  ).results;
  return c.json(draftResult(row, attachments));
});
mail.post('/drafts', async (c) => {
  const data = await body(c, draftSchema);
  await validateDraft(c, data);
  const draftId = id();
  await c.env.DB.prepare(
    'INSERT INTO drafts(id,mailbox_id,address_id,thread_id,subject,to_json,cc_json,bcc_json,html,text,updated_at,updated_by,in_reply_to,references_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      draftId,
      data.mailbox_id,
      data.address_id,
      data.thread_id,
      data.subject,
      JSON.stringify(data.to),
      JSON.stringify(data.cc),
      JSON.stringify(data.bcc),
      cleanHtml(data.html),
      data.text,
      now(),
      c.get('user').id,
      data.in_reply_to,
      JSON.stringify(data.references),
    )
    .run();
  await notifyMailbox(c.env, data.mailbox_id);
  return c.json(
    { ...data, id: draftId, revision: 1, updated_at: now(), attachments: [] },
    201,
  );
});
mail.patch('/drafts/:id', async (c) => {
  const data = await body(
    c,
    draftSchema.extend({ revision: z.number().int().positive() }),
  );
  await validateDraft(c, data);
  const old = await c.env.DB.prepare('SELECT mailbox_id FROM drafts WHERE id=?')
    .bind(c.req.param('id'))
    .first<{ mailbox_id: string }>();
  if (!old || old.mailbox_id !== data.mailbox_id)
    throw new AppError(404, 'Draft not found');
  const row = await c.env.DB.prepare(
    'UPDATE drafts SET address_id=?,thread_id=?,subject=?,to_json=?,cc_json=?,bcc_json=?,html=?,text=?,revision=revision+1,updated_at=?,updated_by=?,in_reply_to=?,references_json=? WHERE id=? AND revision=? AND send_lock IS NULL RETURNING revision,updated_at',
  )
    .bind(
      data.address_id,
      data.thread_id,
      data.subject,
      JSON.stringify(data.to),
      JSON.stringify(data.cc),
      JSON.stringify(data.bcc),
      cleanHtml(data.html),
      data.text,
      now(),
      c.get('user').id,
      data.in_reply_to,
      JSON.stringify(data.references),
      c.req.param('id'),
      data.revision,
    )
    .first();
  if (!row)
    throw new AppError(
      409,
      'Another member edited or sent this draft. Your text has been preserved; save a new copy or reload their version.',
      'DRAFT_CONFLICT',
    );
  await notifyMailbox(c.env, data.mailbox_id);
  return c.json(row);
});
mail.delete('/drafts/:id', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT mailbox_id FROM drafts WHERE id=? AND send_lock IS NULL',
  )
    .bind(c.req.param('id'))
    .first<{ mailbox_id: string }>();
  if (!row) throw new AppError(404, 'Draft not found or already sending');
  await mailboxAccess(c.env, c.get('user'), row.mailbox_id);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE attachments SET draft_id=NULL WHERE draft_id=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND send_lock IS NULL)',
    ).bind(c.req.param('id'), c.req.param('id')),
    c.env.DB.prepare(
      'DELETE FROM drafts WHERE id=? AND send_lock IS NULL',
    ).bind(c.req.param('id')),
  ]);
  await notifyMailbox(c.env, row.mailbox_id);
  return c.json({ ok: true });
});
mail.post('/drafts/:id/attachments', async (c) => {
  const draftId = c.req.param('id'),
    draft = await c.env.DB.prepare(
      'SELECT mailbox_id FROM drafts WHERE id=? AND send_lock IS NULL',
    )
      .bind(draftId)
      .first<{ mailbox_id: string }>();
  if (!draft) throw new AppError(404, 'Draft not found');
  await mailboxAccess(c.env, c.get('user'), draft.mailbox_id);
  const bytes = await readLimited(c.req.raw, 18 * 1024 * 1024),
    attachmentId = id(),
    key = `attachments/${draft.mailbox_id}/${attachmentId}`;
  const filename = safeFilename(c.req.query('filename') || 'attachment'),
    type = c.req.header('Content-Type') || 'application/octet-stream';
  const inline = c.req.query('inline') === '1';
  if (
    inline &&
    !(
      (bytes[0] === 137 && bytes[1] === 80 && type === 'image/png') ||
      (bytes[0] === 255 && bytes[1] === 216 && type === 'image/jpeg') ||
      (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
        new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP' &&
        type === 'image/webp')
    )
  )
    throw new AppError(400, 'Inline images must be PNG, JPEG, or WebP files');
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) count FROM attachments WHERE draft_id=?',
  )
    .bind(draftId)
    .first<{ count: number }>();
  if ((count?.count || 0) >= 50)
    throw new AppError(400, 'Use at most 50 attachments');
  await c.env.FILES.put(key, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  const cid = inline ? `${attachmentId}@yougotmail` : '';
  const result = await c.env.DB.prepare(
    'INSERT INTO attachments(id,mailbox_id,draft_id,filename,content_type,size,object_key,created_at,cid,inline) SELECT ?,?,?,?,?,?,?,?,?,? FROM drafts WHERE id=? AND send_lock IS NULL',
  )
    .bind(
      attachmentId,
      draft.mailbox_id,
      draftId,
      filename,
      type.slice(0, 100),
      bytes.length,
      key,
      now(),
      cid,
      inline ? 1 : 0,
      draftId,
    )
    .run();
  if (!result.meta.changes) {
    await c.env.FILES.delete(key);
    throw new AppError(
      409,
      'This draft was sent while the attachment uploaded',
    );
  }
  return c.json(
    {
      id: attachmentId,
      filename,
      content_type: type,
      size: bytes.length,
      cid,
      inline: inline ? 1 : 0,
    },
    201,
  );
});
mail.delete('/drafts/:draft/attachments/:id', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT a.mailbox_id,a.object_key FROM attachments a JOIN drafts d ON d.id=a.draft_id WHERE a.id=? AND a.draft_id=? AND d.send_lock IS NULL',
  )
    .bind(c.req.param('id'), c.req.param('draft'))
    .first<{ mailbox_id: string; object_key: string }>();
  if (!row) throw new AppError(404, 'Attachment not found');
  await mailboxAccess(c.env, c.get('user'), row.mailbox_id);
  await c.env.DB.prepare(
    'DELETE FROM attachments WHERE id=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND send_lock IS NULL)',
  )
    .bind(c.req.param('id'), c.req.param('draft'))
    .run();
  // Orphan cleanup removes the file after the draft/send race has settled.
  return c.json({ ok: true });
});
mail.post('/drafts/:id/send', async (c) => {
  const data = await body(
    c,
    z.object({
      revision: z.number().int(),
      dueAt: z.number().int().optional(),
      key: z.string().uuid(),
    }),
  );
  const draftId = c.req.param('id'),
    idem = `${c.get('user').id}:${data.key}`;
  const old = await c.env.DB.prepare(
    'SELECT id,status,due_at,mailbox_id FROM send_jobs WHERE idempotency_key=?',
  )
    .bind(idem)
    .first<{
      id: string;
      status: string;
      due_at: number;
      mailbox_id: string;
    }>();
  if (old) {
    await mailboxAccess(c.env, c.get('user'), old.mailbox_id);
    return c.json(old);
  }
  const draft = await c.env.DB.prepare('SELECT * FROM drafts WHERE id=?')
    .bind(draftId)
    .first<Record<string, unknown>>();
  if (!draft) throw new AppError(404, 'Draft not found');
  await mailboxAccess(c.env, c.get('user'), String(draft.mailbox_id));
  if (
    data.dueAt &&
    (data.dueAt < now() + 10_000 || data.dueAt > now() + 366 * 86400_000)
  )
    throw new AppError(400, 'Choose a send date in the next year');
  const lock = id();
  const locked = await c.env.DB.prepare(
    'UPDATE drafts SET send_lock=?,updated_at=? WHERE id=? AND revision=? AND send_lock IS NULL RETURNING *',
  )
    .bind(lock, now(), draftId, data.revision)
    .first<Record<string, unknown>>();
  if (!locked)
    throw new AppError(
      409,
      'This draft changed or is already sending',
      'DRAFT_CONFLICT',
    );
  try {
    const address = await c.env.DB.prepare(
      'SELECT id,email,name FROM addresses WHERE id=? AND active=1',
    )
      .bind(locked.address_id)
      .first<{ id: string; email: string; name: string }>();
    if (!address) throw new AppError(400, 'Sending address is unavailable');
    const attachments = (
      await c.env.DB.prepare('SELECT * FROM attachments WHERE draft_id=?')
        .bind(draftId)
        .all<StoredAttachment>()
    ).results;
    const html = String(locked.html),
      text = String(locked.text) || htmlText(html);
    const size =
      new TextEncoder().encode(html + text).length +
      4096 +
      attachments.reduce(
        (total, a) => total + Math.ceil(a.size / 3) * 4 * 1.03 + 512,
        0,
      );
    const payload: SendPayload = {
      mailboxId: String(locked.mailbox_id),
      addressId: address.id,
      from: { address: address.email, name: address.name },
      to: json<Participant[]>(String(locked.to_json), []),
      cc: json<Participant[]>(String(locked.cc_json), []),
      bcc: json<Participant[]>(String(locked.bcc_json), []),
      subject: String(locked.subject),
      html,
      text,
      attachments,
      threadId: locked.thread_id ? String(locked.thread_id) : null,
      inReplyTo: String(locked.in_reply_to),
      references: json<string[]>(String(locked.references_json), []),
      size: Math.ceil(size),
    };
    const job = await enqueueSend(c.env, payload, {
      userId: c.get('user').id,
      draftId,
      dueAt: data.dueAt || now() + 10_000,
      idempotencyKey: idem,
    });
    return c.json(job);
  } catch (e) {
    await c.env.DB.prepare(
      'UPDATE drafts SET send_lock=NULL WHERE id=? AND send_lock=?',
    )
      .bind(draftId, lock)
      .run();
    throw e;
  }
});
mail.get('/jobs', async (c) => {
  const mailbox = c.req.query('mailbox');
  const rows = (
    await c.env.DB.prepare(
      `SELECT t.* FROM send_jobs t WHERE ${belongs}${mailbox ? ' AND t.mailbox_id=?' : ''} AND t.status NOT IN ('cancelled') ORDER BY t.created_at DESC LIMIT 100`,
    )
      .bind(c.get('user').id, ...(mailbox ? [mailbox] : []))
      .all<Record<string, unknown>>()
  ).results;
  const items = [];
  for (const row of rows) {
    const object = await c.env.FILES.get(String(row.payload_key));
    const payload = object ? await object.json<SendPayload>() : null;
    items.push({
      id: row.id,
      mailbox_id: row.mailbox_id,
      status: row.status,
      due_at: row.due_at,
      created_at: row.created_at,
      last_error: row.last_error,
      subject: payload?.subject || '(no subject)',
      to: payload?.to || [],
      from_address: payload?.from.address || '',
      size: payload?.size || 0,
    });
  }
  return c.json(items);
});
mail.post('/jobs/:id/cancel', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM send_jobs WHERE id=?')
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'Send job not found');
  await mailboxAccess(c.env, c.get('user'), String(row.mailbox_id));
  const payloadObject = await c.env.FILES.get(String(row.payload_key));
  if (!payloadObject) throw new AppError(404, 'Message snapshot not found');
  const payload = await payloadObject.json<SendPayload>();
  const draftId = id();
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO drafts(id,mailbox_id,address_id,thread_id,subject,to_json,cc_json,bcc_json,html,text,updated_at,updated_by,in_reply_to,references_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM send_jobs WHERE id=? AND status IN ('pending','queued','failed')",
    ).bind(
      draftId,
      payload.mailboxId,
      payload.addressId,
      payload.threadId,
      payload.subject,
      JSON.stringify(payload.to),
      JSON.stringify(payload.cc),
      JSON.stringify(payload.bcc),
      payload.html,
      payload.text,
      now(),
      c.get('user').id,
      payload.inReplyTo,
      JSON.stringify(payload.references),
      row.id,
    ),
    c.env.DB.prepare(
      "UPDATE send_jobs SET status='cancelled',lease_until=NULL WHERE id=? AND status IN ('pending','queued','failed') AND EXISTS(SELECT 1 FROM drafts WHERE id=?)",
    ).bind(row.id, draftId),
    c.env.DB.prepare(
      'UPDATE attachments SET job_id=NULL,draft_id=? WHERE job_id=? AND EXISTS(SELECT 1 FROM drafts WHERE id=?)',
    ).bind(draftId, row.id, draftId),
    c.env.DB.prepare(
      'UPDATE mailboxes SET used_bytes=MAX(0,used_bytes-?) WHERE id=? AND EXISTS(SELECT 1 FROM drafts WHERE id=?)',
    ).bind(payload.size, payload.mailboxId, draftId),
  ];
  const result = await c.env.DB.batch(statements);
  if (!result[0].meta.changes)
    throw new AppError(409, 'This message has already started sending');
  await notifyMailbox(c.env, payload.mailboxId);
  return c.json({ draftId });
});
mail.get('/labels', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT l.* FROM labels l JOIN mailbox_members mm ON mm.mailbox_id=l.mailbox_id WHERE mm.user_id=? ORDER BY l.name',
      )
        .bind(c.get('user').id)
        .all()
    ).results,
  ),
);
mail.post('/labels', async (c) => {
  const data = await body(
    c,
    z.object({
      mailboxId: z.string().uuid(),
      name: nameSchema,
      color: colorSchema,
    }),
  );
  await mailboxAccess(c.env, c.get('user'), data.mailboxId);
  const labelId = id();
  await c.env.DB.prepare(
    'INSERT INTO labels(id,mailbox_id,name,color) VALUES(?,?,?,?)',
  )
    .bind(labelId, data.mailboxId, data.name, data.color)
    .run();
  return c.json({ id: labelId, mailbox_id: data.mailboxId, ...data }, 201);
});
mail.patch('/labels/:id', async (c) => {
  const data = await body(
    c,
    z.object({ name: nameSchema, color: colorSchema }),
  );
  const row = await c.env.DB.prepare('SELECT mailbox_id FROM labels WHERE id=?')
    .bind(c.req.param('id'))
    .first<{ mailbox_id: string }>();
  if (!row) throw new AppError(404, 'Label not found');
  await mailboxAccess(c.env, c.get('user'), row.mailbox_id);
  await c.env.DB.prepare('UPDATE labels SET name=?,color=? WHERE id=?')
    .bind(data.name, data.color, c.req.param('id'))
    .run();
  return c.json({ ok: true });
});
mail.delete('/labels/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT mailbox_id FROM labels WHERE id=?')
    .bind(c.req.param('id'))
    .first<{ mailbox_id: string }>();
  if (!row) throw new AppError(404, 'Label not found');
  await mailboxAccess(c.env, c.get('user'), row.mailbox_id);
  await c.env.DB.prepare('DELETE FROM labels WHERE id=?')
    .bind(c.req.param('id'))
    .run();
  return c.json({ ok: true });
});
mail.get('/live/:mailbox', async (c) => {
  const mailboxId = c.req.param('mailbox');
  await mailboxAccess(c.env, c.get('user'), mailboxId);
  const session = await c.env.DB.prepare(
    'SELECT expires_at FROM sessions WHERE id=?',
  )
    .bind(c.get('session').id)
    .first<{ expires_at: number }>();
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-session-id', c.get('session').id);
  headers.set('x-session-expires', String(session!.expires_at));
  headers.set('x-user-id', c.get('user').id);
  headers.set('x-mailbox-id', mailboxId);
  return c.env.LIVE.get(c.env.LIVE.idFromName(mailboxId)).fetch(
    new Request('https://live/connect', { headers }),
  );
});
