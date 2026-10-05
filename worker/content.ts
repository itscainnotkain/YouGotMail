import sanitizeHtml from 'sanitize-html';
import type { Env } from './env';
import type { Participant } from '../shared/types';
import { id, json, now } from './lib';
import { digest } from './crypto';

export function cleanHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'a',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'hr',
      'table',
      'tbody',
      'thead',
      'tfoot',
      'tr',
      'th',
      'td',
      'img',
    ],
    allowedAttributes: {
      '*': ['style', 'dir'],
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^(#[0-9a-f]{3,8}|[a-z]+|rgb\([\d\s,]+\))$/i],
        'background-color': [/^(#[0-9a-f]{3,8}|[a-z]+|rgb\([\d\s,]+\))$/i],
        'font-size': [/^\d{1,2}(px|pt)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'text-align': [/^(left|right|center)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        padding: [/^[\d\s.px%]+$/],
        border: [/^[\d\s.px#\w-]+$/],
      },
    },
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: 'a',
        attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
  });
}
export function htmlText(html: string) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
export type StoredAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  object_key: string;
  cid: string;
  inline: number;
};
export type StoredMessageInput = {
  mailboxId: string;
  direction: 'incoming' | 'outgoing';
  from: Participant;
  to: Participant[];
  cc: Participant[];
  bcc?: Participant[];
  replyTo?: Participant[];
  subject: string;
  date: number;
  internetId: string;
  inReplyTo: string;
  references: string[];
  rawKey: string;
  bodyKey?: string;
  html: string;
  text: string;
  attachments: StoredAttachment[];
  fingerprint: string;
  size: number;
  parseError?: string;
  threadId?: string | null;
  providerId?: string;
  jobId?: string;
  folder?: string;
  markRead?: boolean;
  star?: boolean;
  labelIds?: string[];
};
export async function storeMessage(env: Env, input: StoredMessageInput) {
  const existing = await env.DB.prepare(
    'SELECT id,thread_id FROM messages WHERE mailbox_id=? AND fingerprint=?',
  )
    .bind(input.mailboxId, input.fingerprint)
    .first<{ id: string; thread_id: string }>();
  if (existing) return existing;
  const messageId = id(),
    bodyKey = input.bodyKey || `bodies/${input.mailboxId}/${messageId}.json`;
  let threadId = input.threadId || '';
  if (
    threadId &&
    !(await env.DB.prepare('SELECT 1 FROM threads WHERE id=? AND mailbox_id=?')
      .bind(threadId, input.mailboxId)
      .first())
  )
    threadId = '';
  if (!threadId) {
    const refs = [...input.references, input.inReplyTo, input.internetId]
      .filter(Boolean)
      .slice(-100);
    if (refs.length) {
      const match = await env.DB.prepare(
        `SELECT thread_id FROM messages WHERE mailbox_id=? AND internet_id IN (${refs.map(() => '?').join(',')}) ORDER BY date DESC LIMIT 1`,
      )
        .bind(input.mailboxId, ...refs)
        .first<{ thread_id: string }>();
      threadId = match?.thread_id || '';
    }
    // Some providers return an API identifier rather than the RFC Message-ID.
    // Only use the reply heuristic for one unambiguous recent outbound conversation.
    if (!threadId && input.direction === 'incoming' && input.inReplyTo) {
      const candidates = (
        await env.DB.prepare(
          "SELECT m.thread_id,m.subject,m.to_json,m.cc_json,m.from_address FROM messages m WHERE m.mailbox_id=? AND m.direction='outgoing' AND m.internet_id='' AND m.date>? ORDER BY m.date DESC LIMIT 100",
        )
          .bind(input.mailboxId, input.date - 30 * 86400_000)
          .all<{
            thread_id: string;
            subject: string;
            to_json: string;
            cc_json: string;
            from_address: string;
          }>()
      ).results;
      const normal = (s: string) =>
        s
          .replace(/^(?:(?:re|fw|fwd):\s*)+/i, '')
          .trim()
          .toLowerCase();
      const matches = new Set(
        candidates
          .filter(
            (m) =>
              normal(m.subject) === normal(input.subject) &&
              [
                ...json<Participant[]>(m.to_json, []),
                ...json<Participant[]>(m.cc_json, []),
              ].some(
                (p) =>
                  p.address.toLowerCase() === input.from.address.toLowerCase(),
              ) &&
              [...input.to, ...input.cc].some(
                (p) => p.address.toLowerCase() === m.from_address.toLowerCase(),
              ),
          )
          .map((m) => m.thread_id),
      );
      if (matches.size === 1) threadId = [...matches][0];
    }
    if (!threadId)
      threadId = (
        await digest(
          `${input.mailboxId}:${input.references[0] || input.inReplyTo || input.internetId || input.fingerprint}`,
        )
      )
        .replace(/[+/=]/g, '')
        .slice(0, 32);
  }
  const oldThread = await env.DB.prepare(
    'SELECT participants,folder,snoozed_until FROM threads WHERE id=?',
  )
    .bind(threadId)
    .first<{
      participants: string;
      folder: string;
      snoozed_until: number | null;
    }>();
  const participants = new Map<string, Participant>();
  for (const p of [
    ...json<Participant[]>(oldThread?.participants, []),
    input.from,
    ...input.to,
    ...input.cc,
  ])
    participants.set(p.address, p);
  const html = cleanHtml(input.html),
    text = input.text || htmlText(html),
    snippet = text.replace(/\s+/g, ' ').slice(0, 180);
  await env.FILES.put(bodyKey, JSON.stringify({ html, text }), {
    httpMetadata: { contentType: 'application/json' },
  });
  const folder =
    input.folder ||
    (input.direction === 'incoming'
      ? oldThread && ['trash', 'spam'].includes(oldThread.folder)
        ? oldThread.folder
        : 'inbox'
      : oldThread?.folder || 'sent');
  const unread = input.direction === 'incoming' && !input.markRead ? 1 : 0;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO threads(id,mailbox_id,subject,snippet,participants,updated_at,unread,starred,folder,count,has_attachments) VALUES(?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING',
    ).bind(
      threadId,
      input.mailboxId,
      input.subject,
      snippet,
      JSON.stringify([...participants.values()]),
      input.date,
      unread,
      input.star ? 1 : 0,
      folder,
      input.attachments.length ? 1 : 0,
    ),
    env.DB.prepare(
      'INSERT INTO messages(id,thread_id,mailbox_id,direction,from_address,from_name,to_json,cc_json,bcc_json,reply_to_json,subject,date,internet_id,in_reply_to,references_json,raw_key,body_key,parse_error,size,fingerprint,provider_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      messageId,
      threadId,
      input.mailboxId,
      input.direction,
      input.from.address,
      input.from.name || '',
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.direction === 'outgoing' ? input.bcc || [] : []),
      JSON.stringify(input.replyTo || []),
      input.subject,
      input.date,
      input.internetId,
      input.inReplyTo,
      JSON.stringify(input.references.slice(-100)),
      input.rawKey,
      bodyKey,
      input.parseError || '',
      input.size,
      input.fingerprint,
      input.providerId || '',
    ),
    env.DB.prepare(
      'UPDATE threads SET snippet=?,participants=?,updated_at=MAX(updated_at,?),count=count+1,has_attachments=MAX(has_attachments,?),unread=MAX(unread,?),starred=MAX(starred,?),folder=?,snoozed_until=CASE WHEN ?=1 THEN NULL ELSE snoozed_until END WHERE id=?',
    ).bind(
      snippet,
      JSON.stringify([...participants.values()]),
      input.date,
      input.attachments.length ? 1 : 0,
      unread,
      input.star ? 1 : 0,
      folder,
      input.direction === 'incoming' ? 1 : 0,
      threadId,
    ),
  ];
  for (const attachment of input.attachments)
    statements.push(
      env.DB.prepare(
        'INSERT INTO attachments(id,mailbox_id,message_id,filename,content_type,size,object_key,cid,inline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id,draft_id=NULL,job_id=NULL',
      ).bind(
        attachment.id,
        input.mailboxId,
        messageId,
        attachment.filename,
        attachment.content_type,
        attachment.size,
        attachment.object_key,
        attachment.cid,
        attachment.inline,
        now(),
      ),
    );
  for (const label of input.labelIds || [])
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO thread_labels(thread_id,label_id) SELECT ?,id FROM labels WHERE id=? AND mailbox_id=?',
      ).bind(threadId, label, input.mailboxId),
    );
  // FTS chunks have a safe size even for very large plain-text MIME parts.
  const chunks = text.match(/[\s\S]{1,32000}/g) || [''];
  for (const chunk of chunks)
    statements.push(
      env.DB.prepare(
        'INSERT INTO search_chunks(message_id,mailbox_id,subject,participants,body) VALUES(?,?,?,?,?)',
      ).bind(
        messageId,
        input.mailboxId,
        input.subject,
        [...participants.values()]
          .map((p) => `${p.name || ''} ${p.address}`)
          .join(' '),
        chunk,
      ),
    );
  if (input.jobId)
    statements.push(
      env.DB.prepare('UPDATE send_jobs SET message_id=? WHERE id=?').bind(
        messageId,
        input.jobId,
      ),
    );
  try {
    await env.DB.batch(statements);
  } catch (e) {
    const duplicate = await env.DB.prepare(
      'SELECT id,thread_id FROM messages WHERE mailbox_id=? AND fingerprint=?',
    )
      .bind(input.mailboxId, input.fingerprint)
      .first<{ id: string; thread_id: string }>();
    if (duplicate) return duplicate;
    throw e;
  }
  return { id: messageId, thread_id: threadId };
}
