import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { env as bindings } from 'cloudflare:workers';
import {
  applyD1Migrations,
  reset,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../worker/index';
import type { Env } from '../worker/env';
import {
  digest,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  putIntegration,
  base64,
} from '../worker/crypto';
import { storeMessage, cleanHtml } from '../worker/content';
import {
  receiveEmail,
  processIngestion,
  resolveRecipient,
} from '../worker/receiving';
import { dispatchSend, handleDelivery } from '../worker/sending';
import { TOTP } from 'otpauth';
import { checkSecondFactor } from '../worker/auth';
import {
  previewDomain,
  applyDomain,
  getDomain,
  providerDnsName,
} from '../worker/domains';
import { scheduledHandler } from '../worker/jobs';
import { purgeMailboxFiles } from '../worker/mailbox-deletion';

const owner = '11111111-1111-4111-8111-111111111111',
  member = '22222222-2222-4222-8222-222222222222',
  box = '33333333-3333-4333-8333-333333333333',
  shared = '44444444-4444-4444-8444-444444444444',
  domain = '55555555-5555-4555-8555-555555555555',
  address = '66666666-6666-4666-8666-666666666666';
const csrf = 'csrf-test',
  password = 'A long test password 123!';
let hash: string;
const send = vi.fn(async () => ({ messageId: '<native-id@cloudflare.com>' }));
const jobs = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) };
const env = { ...bindings, JOBS: jobs, EMAIL: { send } } as unknown as Env;
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  who: 'owner' | 'member' | 'none' = 'owner',
  headers: Record<string, string> = {},
) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://mail.test/api/v1${path}`, {
      method,
      headers: {
        Origin: 'https://mail.test',
        ...(who === 'none'
          ? {}
          : { Cookie: `ygm_session=${who}-token`, 'X-CSRF-Token': csrf }),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
async function draft() {
  const response = await request('/mail/drafts', 'POST', {
    mailbox_id: box,
    address_id: address,
    to: [{ address: 'friend@example.net' }],
    bcc: [{ address: 'private@example.net' }],
    subject: 'A real conversation',
    html: '<p>Hello</p>',
    text: 'Hello',
  });
  expect(response.status).toBe(201);
  return (await response.json()) as any;
}
async function incoming(overrides: Record<string, unknown> = {}) {
  return storeMessage(env, {
    mailboxId: box,
    direction: 'incoming',
    from: { address: 'friend@example.net', name: 'Friend' },
    to: [{ address: 'owner@example.com' }],
    cc: [],
    subject: 'Weekend plans',
    date: Date.now(),
    internetId: '<inbound@example.net>',
    inReplyTo: '',
    references: [],
    rawKey: '',
    html: '<p>Let us visit the botanical gardens.</p>',
    text: 'Let us visit the botanical gardens.',
    attachments: [],
    fingerprint: crypto.randomUUID(),
    size: 1000,
    ...overrides,
  });
}

beforeAll(async () => {
  hash = await hashPassword(password);
});
beforeEach(async () => {
  await reset();
  vi.restoreAllMocks();
  send.mockClear();
  send.mockResolvedValue({ messageId: '<native-id@cloudflare.com>' });
  jobs.send.mockClear();
  await applyD1Migrations(env.DB, (bindings as any).TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users(id,username,name,recovery_email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(
      owner,
      'owner',
      'Alex Morgan',
      'alex@external.test',
      hash,
      'owner',
      Date.now(),
    ),
    env.DB.prepare(
      'INSERT INTO users(id,username,name,recovery_email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(
      member,
      'member',
      'Jamie Lee',
      'jamie@external.test',
      hash,
      'member',
      Date.now(),
    ),
    env.DB.prepare(
      "INSERT INTO domains(id,name,zone_id,provider,receiving_status,sending_status,created_at) VALUES(?,?,?,'cloudflare','ready','ready',?)",
    ).bind(domain, 'example.com', 'zone', Date.now()),
    env.DB.prepare(
      "INSERT INTO mailboxes(id,name,kind,primary_address,created_at) VALUES(?,?,'private',?,?)",
    ).bind(box, 'Personal', 'owner@example.com', Date.now()),
    env.DB.prepare(
      "INSERT INTO mailboxes(id,name,kind,primary_address,created_at) VALUES(?,?,'shared',?,?)",
    ).bind(shared, 'Team', 'team@example.com', Date.now()),
    env.DB.prepare('INSERT INTO mailbox_members VALUES(?,?)').bind(box, owner),
    env.DB.prepare('INSERT INTO mailbox_members VALUES(?,?)').bind(
      shared,
      owner,
    ),
    env.DB.prepare('INSERT INTO mailbox_members VALUES(?,?)').bind(
      shared,
      member,
    ),
    env.DB.prepare(
      'INSERT INTO addresses(id,mailbox_id,domain_id,email,name) VALUES(?,?,?,?,?)',
    ).bind(address, box, domain, 'owner@example.com', 'Alex Morgan'),
    env.DB.prepare(
      'INSERT INTO addresses(id,mailbox_id,domain_id,email,name) VALUES(?,?,?,?,?)',
    ).bind(crypto.randomUUID(), shared, domain, 'team@example.com', 'Team'),
    ...(await Promise.all(
      ['owner', 'member'].map(async (role) =>
        env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').bind(
          await digest(`${role}-token`),
          role === 'owner' ? owner : member,
          csrf,
          Date.now() + 86400_000,
          Date.now(),
          Date.now(),
        ),
      ),
    )),
  ]);
});

describe('accounts and access boundaries', () => {
  it('claims ownership once with a unique setup key and sets a secure session', async () => {
    await env.DB.prepare('DELETE FROM users').run();
    const data = {
      setupToken: env.SETUP_TOKEN,
      username: 'new-owner',
      name: 'Owner',
      recoveryEmail: 'owner@external.test',
      password,
      timezone: 'Europe/London',
    };
    expect(
      (
        await request(
          '/setup/claim',
          'POST',
          { ...data, setupToken: 'bad' },
          'none',
        )
      ).status,
    ).toBe(403);
    const result = await request('/setup/claim', 'POST', data, 'none');
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(result.headers.get('set-cookie')).toMatch(/Secure/);
    expect((await request('/setup/claim', 'POST', data, 'none')).status).toBe(
      409,
    );
  });
  it('verifies Argon2id hashes and authenticated AES-GCM encryption', async () => {
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    const secret = await encrypt(env, 'integration-key');
    expect(secret).not.toContain('integration-key');
    expect(await decrypt(env, secret)).toBe('integration-key');
    await expect(
      decrypt(
        { ...env, APP_KEY: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=' },
        secret,
      ),
    ).rejects.toThrow();
  });
  it('rejects unauthenticated, cross-origin and missing-CSRF mutations', async () => {
    expect(
      (await request('/mail/mailboxes', 'GET', undefined, 'none')).status,
    ).toBe(401);
    expect(
      (
        await request('/auth/profile', 'PATCH', {}, 'owner', {
          'X-CSRF-Token': '',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/auth/profile', 'PATCH', {}, 'owner', {
          Origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
  });
  it('keeps private mail, bodies and attachments inaccessible to other users', async () => {
    const m = await incoming();
    expect(
      (
        await request(
          `/mail/threads/${m.thread_id}`,
          'GET',
          undefined,
          'member',
        )
      ).status,
    ).toBe(404);
    const boxes = (await (
      await request('/mail/mailboxes', 'GET', undefined, 'member')
    ).json()) as any[];
    expect(boxes.map((b) => b.id)).toEqual([shared]);
    expect(
      (await request('/admin/users', 'GET', undefined, 'member')).status,
    ).toBe(403);
  });
  it('shares mailbox state equally between members', async () => {
    const m = await incoming({ mailboxId: shared, fingerprint: 'shared' });
    const response = await request(
      '/mail/threads/actions',
      'POST',
      { ids: [m.thread_id], action: 'read' },
      'member',
    );
    expect(response.status).toBe(200);
    const thread = (await (
      await request(`/mail/threads/${m.thread_id}`)
    ).json()) as any;
    expect(thread.thread.unread).toBe(0);
  });
  it('requires the current password when changing the recovery address', async () => {
    const data = {
      name: 'Alex',
      timezone: 'UTC',
      recovery_email: 'attacker@external.test',
    };
    expect((await request('/auth/profile', 'PATCH', data)).status).toBe(400);
    expect(
      (await request('/auth/profile', 'PATCH', { ...data, password })).status,
    ).toBe(200);
  });
  it('rejects replayed TOTP and consumes recovery codes once', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    await env.DB.prepare(
      'UPDATE users SET totp_secret=?,recovery_codes=? WHERE id=?',
    )
      .bind(
        await encrypt(env, secret),
        JSON.stringify([await digest('RECOVERY-CODE')]),
        owner,
      )
      .run();
    const row = (await env.DB.prepare('SELECT * FROM users WHERE id=?')
      .bind(owner)
      .first()) as any;
    const totp = new TOTP({ secret, period: 30, digits: 6, algorithm: 'SHA1' });
    await checkSecondFactor(env, row, totp.generate());
    await expect(
      checkSecondFactor(env, row, totp.generate()),
    ).rejects.toThrow();
    await checkSecondFactor(env, row, 'RECOVERY-CODE');
    await expect(
      checkSecondFactor(env, row, 'RECOVERY-CODE'),
    ).rejects.toThrow();
  });
});
describe('incoming email and organisation', () => {
  it('uploads and downloads Unicode filenames without exposing attachments to other members', async () => {
    const d = await draft(),
      ctx = createExecutionContext();
    const uploaded = await worker.fetch(
      new Request(
        `https://mail.test/api/v1/mail/drafts/${d.id}/attachments?filename=${encodeURIComponent('Résumé 🚀.txt')}`,
        {
          method: 'POST',
          headers: {
            Origin: 'https://mail.test',
            Cookie: 'ygm_session=owner-token',
            'X-CSRF-Token': csrf,
            'Content-Type': 'text/plain',
          },
          body: 'Private attachment',
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json()) as any;
    const download = await request(`/mail/attachments/${attachment.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain(
      "filename*=UTF-8''R%C3%A9sum%C3%A9%20%F0%9F%9A%80.txt",
    );
    expect(await download.text()).toBe('Private attachment');
    expect(
      (
        await request(
          `/mail/attachments/${attachment.id}`,
          'GET',
          undefined,
          'member',
        )
      ).status,
    ).toBe(404);
  });
  it('serves private HTML with sandboxing and blocks remote images until requested', async () => {
    const m = await incoming({
      html: '<p>Hello</p><img src="https://tracker.example/pixel"><script>alert(1)</script>',
    });
    const message = await env.DB.prepare(
      'SELECT id FROM messages WHERE thread_id=?',
    )
      .bind(m.thread_id)
      .first<{ id: string }>();
    const response = await request(`/mail/messages/${message!.id}/render`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get('Content-Security-Policy')).not.toContain(
      ' https:;',
    );
    expect(await response.text()).not.toContain('<script');
    expect(
      (
        await request(`/mail/messages/${message!.id}/render?images=1`)
      ).headers.get('Content-Security-Policy'),
    ).toContain(' https:;');
    expect(
      (
        await request(
          `/mail/messages/${message!.id}/render`,
          'GET',
          undefined,
          'member',
        )
      ).status,
    ).toBe(404);
  });
  it('routes aliases, plus addressing and opt-in catch-all without cross-domain leakage', async () => {
    expect(await resolveRecipient(env, 'Owner+receipt@example.com')).toBe(box);
    expect(await resolveRecipient(env, 'unknown@example.com')).toBeNull();
    await env.DB.prepare('UPDATE domains SET catch_all_mailbox=? WHERE id=?')
      .bind(shared, domain)
      .run();
    expect(await resolveRecipient(env, 'unknown@example.com')).toBe(shared);
    expect(await resolveRecipient(env, 'owner@elsewhere.com')).toBeNull();
  });
  it('persists, deduplicates, parses and sanitises MIME including Reply-To and attachments', async () => {
    const raw =
      'From: Friend <friend@example.net>\r\nTo: owner@example.com\r\nReply-To: replies@example.net\r\nSubject: MIME mail\r\nMessage-ID: <mime@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/html\r\n\r\n<p>Hello<script>attack()</script></p>\r\n--parts\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\nA private note\r\n--parts--\r\n';
    const bytes = new TextEncoder().encode(raw),
      reject = vi.fn();
    const event = () =>
      ({
        from: 'friend@example.net',
        to: 'owner@example.com',
        rawSize: bytes.length,
        raw: new Blob([bytes]).stream(),
        setReject: reject,
      }) as unknown as ForwardableEmailMessage;
    await receiveEmail(event(), env);
    await receiveEmail(event(), env);
    expect(reject).not.toHaveBeenCalled();
    const ingestions = (
      await env.DB.prepare('SELECT id FROM ingestions').all<{ id: string }>()
    ).results;
    expect(ingestions).toHaveLength(1);
    await processIngestion(env, ingestions[0].id);
    const m = (await env.DB.prepare('SELECT * FROM messages').first()) as any;
    expect(m.reply_to_json).toContain('replies@example.net');
    const body = (await (await env.FILES.get(m.body_key))!.json()) as any;
    expect(body.html).not.toContain('script');
    expect(
      (
        (await env.DB.prepare(
          'SELECT COUNT(*) count FROM attachments',
        ).first()) as any
      ).count,
    ).toBe(1);
    expect(
      (
        (await env.DB.prepare('SELECT used_bytes FROM mailboxes WHERE id=?')
          .bind(box)
          .first()) as any
      ).used_bytes,
    ).toBe(bytes.length);
  });
  it('rejects unknown recipients and storage-quota overflow before accepting mail', async () => {
    const reject = vi.fn();
    await receiveEmail(
      { to: 'missing@example.com', rawSize: 1, setReject: reject } as any,
      env,
    );
    expect(reject).toHaveBeenCalledWith('Unknown recipient');
    await env.DB.prepare('UPDATE mailboxes SET quota_bytes=1 WHERE id=?')
      .bind(box)
      .run();
    await receiveEmail(
      { to: 'owner@example.com', rawSize: 2, setReject: reject } as any,
      env,
    );
    expect(reject).toHaveBeenCalledWith('Mailbox storage quota exceeded');
  });
  it('threads RFC references and searches full message text with operators', async () => {
    const first = await incoming();
    const second = await incoming({
      internetId: '<reply@example.net>',
      inReplyTo: '<inbound@example.net>',
      references: ['<inbound@example.net>'],
    });
    expect(first.thread_id).toBe(second.thread_id);
    const result = (await (
      await request(
        '/mail/threads?folder=all&q=from%3Afriend%40example.net%20botanical',
      )
    ).json()) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].count).toBe(2);
    expect(
      cleanHtml(
        '<img src="javascript:alert(1)" onerror="attack()"><iframe src="https://evil.test"></iframe>',
      ),
    ).not.toMatch(/javascript|onerror|iframe/);
  });
  it('applies blocked senders and ordered filters to real inbound mail', async () => {
    await env.DB.prepare('INSERT INTO blocked_senders VALUES(?,?)')
      .bind(box, '@example.net')
      .run();
    const raw =
      'From: friend@example.net\r\nTo: owner@example.com\r\nSubject: Blocked\r\n\r\nHello';
    const bytes = new TextEncoder().encode(raw);
    await receiveEmail(
      {
        to: 'owner@example.com',
        from: 'friend@example.net',
        rawSize: bytes.length,
        raw: new Blob([bytes]).stream(),
        setReject: vi.fn(),
      } as any,
      env,
    );
    const i = await env.DB.prepare('SELECT id FROM ingestions').first<{
      id: string;
    }>();
    await processIngestion(env, i!.id);
    expect(
      ((await env.DB.prepare('SELECT folder FROM threads').first()) as any)
        .folder,
    ).toBe('spam');
  });
});
describe('mailbox deletion', () => {
  it('requires administrator access, CSRF and the exact mailbox name', async () => {
    const path = `/admin/mailboxes/${box}`;
    expect(
      (await request(path, 'DELETE', { confirmation: 'Personal' }, 'member'))
        .status,
    ).toBe(403);
    expect(
      (await request(path, 'DELETE', { confirmation: 'Personal' }, 'none'))
        .status,
    ).toBe(401);
    expect(
      (
        await request(path, 'DELETE', { confirmation: 'Personal' }, 'owner', {
          'X-CSRF-Token': '',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(path, 'DELETE', { confirmation: 'personal' })).status,
    ).toBe(400);
    expect((await request(path, 'DELETE', {})).status).toBe(400);
    expect(
      await env.DB.prepare('SELECT id FROM mailboxes WHERE id=?')
        .bind(box)
        .first(),
    ).toBeTruthy();
    expect(
      (await env.DB.prepare('SELECT * FROM mailbox_deletions').all()).results,
    ).toHaveLength(0);
  });

  it('removes mail and aliases, cancels queued sends, clears references, and preserves other mailboxes and accounts', async () => {
    await incoming();
    const other = await incoming({ mailboxId: shared });
    const d = await draft();
    const queued = await request(`/mail/drafts/${d.id}/send`, 'POST', {
      revision: d.revision,
      key: crypto.randomUUID(),
      dueAt: Date.now() + 3600_000,
    });
    expect(queued.status).toBe(200);
    const job = (await queued.json()) as any;
    await draft();
    const raw =
      'From: friend@example.net\r\nTo: owner@example.com\r\nSubject: Pending\r\n\r\nHello';
    await receiveEmail(
      {
        from: 'friend@example.net',
        to: 'owner@example.com',
        rawSize: raw.length,
        raw: new Blob([raw]).stream(),
        setReject: vi.fn(),
      } as any,
      env,
    );
    const ingestion = await env.DB.prepare('SELECT id FROM ingestions').first<{
      id: string;
    }>();
    const invitation = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('UPDATE domains SET catch_all_mailbox=? WHERE id=?').bind(
        box,
        domain,
      ),
      env.DB.prepare(
        'INSERT INTO invitations(id,token_hash,email,name,role,mailbox_ids,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        invitation,
        'invitation-hash',
        'new@example.net',
        'New member',
        'member',
        JSON.stringify([box, shared]),
        Date.now() + 86400_000,
        Date.now(),
      ),
      env.DB.prepare(
        'INSERT INTO addresses(id,mailbox_id,domain_id,email) VALUES(?,?,?,?)',
      ).bind(crypto.randomUUID(), box, domain, 'alias@example.com'),
      env.DB.prepare(
        'INSERT INTO labels(id,mailbox_id,name) VALUES(?,?,?)',
      ).bind(crypto.randomUUID(), box, 'Private'),
      env.DB.prepare(
        'INSERT INTO filters(id,mailbox_id,name,conditions,actions) VALUES(?,?,?,?,?)',
      ).bind(crypto.randomUUID(), box, 'Filter', '{}', '{}'),
    ]);
    jobs.send.mockRejectedValueOnce(new Error('Queue temporarily unavailable'));
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(202);
    for (const table of [
      'mailboxes',
      'mailbox_members',
      'addresses',
      'threads',
      'messages',
      'attachments',
      'labels',
      'drafts',
      'send_jobs',
      'ingestions',
      'filters',
      'search_chunks',
    ]) {
      const column = table === 'mailboxes' ? 'id' : 'mailbox_id';
      expect(
        (
          await env.DB.prepare(`SELECT * FROM ${table} WHERE ${column}=?`)
            .bind(box)
            .all()
        ).results,
        table,
      ).toHaveLength(0);
    }
    expect(
      (await env.DB.prepare('SELECT * FROM users').all()).results,
    ).toHaveLength(2);
    expect(
      await env.DB.prepare('SELECT id FROM messages WHERE id=?')
        .bind(other.id)
        .first(),
    ).toBeTruthy();
    expect(
      await env.FILES.get(`bodies/${shared}/${other.id}.json`),
    ).toBeTruthy();
    expect(
      (await env.DB.prepare('SELECT catch_all_mailbox FROM domains WHERE id=?')
        .bind(domain)
        .first())!.catch_all_mailbox,
    ).toBeNull();
    expect(
      JSON.parse(
        String(
          (await env.DB.prepare(
            'SELECT mailbox_ids FROM invitations WHERE id=?',
          )
            .bind(invitation)
            .first())!.mailbox_ids,
        ),
      ),
    ).toEqual([shared]);
    expect(await resolveRecipient(env, 'owner@example.com')).toBeNull();
    expect(await resolveRecipient(env, 'alias@example.com')).toBeNull();
    expect(await resolveRecipient(env, 'unknown@example.com')).toBeNull();
    await dispatchSend(env, job.id);
    await processIngestion(env, ingestion!.id);
    expect(send).not.toHaveBeenCalled();
    await scheduledHandler(env);
    for (const prefix of ['raw', 'bodies', 'attachments', 'outbox'])
      expect(
        (await env.FILES.list({ prefix: `${prefix}/${box}/` })).objects,
      ).toHaveLength(0);
    expect(
      (await env.DB.prepare('SELECT * FROM mailbox_deletions').all()).results,
    ).toHaveLength(0);
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit WHERE action='mailbox.delete' AND target=?",
      )
        .bind(box)
        .first(),
    ).toBeTruthy();
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(404);
  });

  it('blocks deletion during active processing without partially clearing metadata', async () => {
    await incoming();
    const d = await draft();
    await env.DB.batch([
      env.DB.prepare('UPDATE drafts SET send_lock=? WHERE id=?').bind(
        'active-lock',
        d.id,
      ),
      env.DB.prepare('UPDATE domains SET catch_all_mailbox=? WHERE id=?').bind(
        box,
        domain,
      ),
    ]);
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await env.DB.prepare('SELECT * FROM search_chunks WHERE mailbox_id=?')
          .bind(box)
          .all()
      ).results,
    ).toHaveLength(1);
    expect(
      (await env.DB.prepare('SELECT catch_all_mailbox FROM domains WHERE id=?')
        .bind(domain)
        .first())!.catch_all_mailbox,
    ).toBe(box);
    expect(
      await env.DB.prepare('SELECT id FROM drafts WHERE id=?')
        .bind(d.id)
        .first(),
    ).toBeTruthy();
    await env.DB.prepare('UPDATE drafts SET send_lock=NULL WHERE id=?')
      .bind(d.id)
      .run();
    const response = await request(`/mail/drafts/${d.id}/send`, 'POST', {
      revision: d.revision,
      key: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    await env.DB.prepare("UPDATE send_jobs SET status='sending'").run();
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(409);
    await env.DB.prepare("UPDATE send_jobs SET status='pending'").run();
    await env.DB.prepare(
      "INSERT INTO ingestions(id,mailbox_id,envelope_from,envelope_to,raw_key,fingerprint,status,size,created_at) VALUES(?,?,?,?,?,?,'processing',1,?)",
    )
      .bind(
        crypto.randomUUID(),
        box,
        'friend@example.net',
        'owner@example.com',
        `raw/${box}/active`,
        'active',
        Date.now(),
      )
      .run();
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(409);
    expect(
      (await env.DB.prepare('SELECT * FROM mailbox_deletions').all()).results,
    ).toHaveLength(0);
  });

  it('retries storage failures and paginates cleanup without touching another mailbox', async () => {
    const keys = Array.from(
      { length: 105 },
      (_, index) => `attachments/${box}/${index}`,
    );
    for (const key of keys) await env.FILES.put(key, 'private');
    const keep = `attachments/${shared}/keep`;
    await env.FILES.put(keep, 'keep');
    expect(
      (
        await request(`/admin/mailboxes/${box}`, 'DELETE', {
          confirmation: 'Personal',
        })
      ).status,
    ).toBe(202);
    const deletion = await env.DB.prepare(
      'SELECT id FROM mailbox_deletions',
    ).first<{ id: string }>();
    const failed = {
      ...env,
      FILES: {
        list: env.FILES.list.bind(env.FILES),
        delete: async () => {
          throw new Error('Storage temporarily unavailable');
        },
      },
    } as unknown as Env;
    await expect(purgeMailboxFiles(failed, deletion!.id)).rejects.toThrow(
      'Storage temporarily unavailable',
    );
    expect(
      await env.DB.prepare('SELECT id FROM mailbox_deletions').first(),
    ).toBeTruthy();
    await purgeMailboxFiles(env, deletion!.id);
    await purgeMailboxFiles(env, deletion!.id);
    expect(
      (await env.FILES.list({ prefix: `attachments/${box}/` })).objects,
    ).toHaveLength(0);
    expect(await env.FILES.get(keep)).toBeTruthy();
    expect(
      (await env.DB.prepare('SELECT * FROM mailbox_deletions').all()).results,
    ).toHaveLength(0);
    await purgeMailboxFiles(env, deletion!.id);
  });
});
describe('durable sending', () => {
  it('recovers stale draft locks and wakes snoozed mail in the scheduled handler', async () => {
    const d = await draft(),
      m = await incoming();
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE drafts SET send_lock=?,updated_at=0 WHERE id=?',
      ).bind('interrupted', d.id),
      env.DB.prepare('UPDATE threads SET snoozed_until=1 WHERE id=?').bind(
        m.thread_id,
      ),
    ]);
    await scheduledHandler(env);
    expect(
      ((await env.DB.prepare('SELECT send_lock FROM drafts').first()) as any)
        .send_lock,
    ).toBeNull();
    expect(
      (
        (await env.DB.prepare(
          'SELECT snoozed_until FROM threads',
        ).first()) as any
      ).snoozed_until,
    ).toBeNull();
  });
  it('guards shared draft revisions and provides idempotent queueing with undo', async () => {
    const d = await draft(),
      key = crypto.randomUUID();
    expect(
      (await request(`/mail/drafts/${d.id}`, 'PATCH', { ...d, revision: 2 }))
        .status,
    ).toBe(409);
    const response = await request(`/mail/drafts/${d.id}/send`, 'POST', {
      revision: d.revision,
      key,
    });
    expect(response.status).toBe(200);
    const job = (await response.json()) as any;
    const repeat = (await (
      await request(`/mail/drafts/${d.id}/send`, 'POST', {
        revision: d.revision,
        key,
      })
    ).json()) as any;
    expect(repeat.id).toBe(job.id);
    const undo = (await (
      await request(`/mail/jobs/${job.id}/cancel`, 'POST', {})
    ).json()) as any;
    expect(undo.draftId).toBeTruthy();
    expect((await request(`/mail/drafts/${undo.draftId}`)).status).toBe(200);
    await dispatchSend(env, job.id);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        (await env.DB.prepare('SELECT used_bytes FROM mailboxes WHERE id=?')
          .bind(box)
          .first()) as any
      ).used_bytes,
    ).toBe(0);
  });
  it('honours schedules, sends exactly once on redelivery and preserves private BCC', async () => {
    const d = await draft(),
      job = (await (
        await request(`/mail/drafts/${d.id}/send`, 'POST', {
          revision: d.revision,
          key: crypto.randomUUID(),
          dueAt: Date.now() + 3600_000,
        })
      ).json()) as any;
    await dispatchSend(env, job.id);
    expect(send).not.toHaveBeenCalled();
    await env.DB.prepare('UPDATE send_jobs SET due_at=0 WHERE id=?')
      .bind(job.id)
      .run();
    await Promise.all([dispatchSend(env, job.id), dispatchSend(env, job.id)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].bcc).toEqual(['private@example.net']);
    const m = (await env.DB.prepare('SELECT * FROM messages').first()) as any;
    expect(m.bcc_json).toContain('private@example.net');
    expect(m.internet_id).toBe('<native-id@cloudflare.com>');
    expect(
      ((await env.DB.prepare('SELECT status FROM send_jobs').first()) as any)
        .status,
    ).toBe('accepted');
  });
  it('marks ambiguous native provider failures for review without automatic retries', async () => {
    send.mockRejectedValueOnce(new Error('Connection interrupted'));
    const d = await draft(),
      job = (await (
        await request(`/mail/drafts/${d.id}/send`, 'POST', {
          revision: d.revision,
          key: crypto.randomUUID(),
        })
      ).json()) as any;
    await env.DB.prepare('UPDATE send_jobs SET due_at=0 WHERE id=?')
      .bind(job.id)
      .run();
    await dispatchSend(env, job.id);
    await dispatchSend(env, job.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      ((await env.DB.prepare('SELECT status FROM send_jobs').first()) as any)
        .status,
    ).toBe('uncertain');
    expect(
      (await request(`/admin/jobs/${job.id}/retry`, 'POST', {})).status,
    ).toBe(409);
  });
  it('sends through Resend with a stable idempotency key and signed delivery events', async () => {
    await env.DB.prepare("UPDATE domains SET provider='resend' WHERE id=?")
      .bind(domain)
      .run();
    const secret = base64(new Uint8Array(32).fill(7));
    await putIntegration(env, 'resend', {
      token: 'resend-test-token',
      webhookSecret: `whsec_${secret}`,
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'resend-message' }), { status: 200 }),
      );
    const d = await draft(),
      job = (await (
        await request(`/mail/drafts/${d.id}/send`, 'POST', {
          revision: d.revision,
          key: crypto.randomUUID(),
        })
      ).json()) as any;
    await env.DB.prepare('UPDATE send_jobs SET due_at=0 WHERE id=?')
      .bind(job.id)
      .run();
    await dispatchSend(env, job.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0][1]!.headers as any)['Idempotency-Key']).toBe(
      `yougotmail/${job.id}`,
    );
    fetch.mockRestore();
    const raw = JSON.stringify({
        type: 'email.delivered',
        created_at: new Date(Date.now() + 1000).toISOString(),
        data: { email_id: 'resend-message', to: ['friend@example.net'] },
      }),
      timestamp = String(Math.floor(Date.now() / 1000)),
      eventId = 'event-1';
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(7),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = base64(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(`${eventId}.${timestamp}.${raw}`),
        ),
      ),
    );
    const context = createExecutionContext();
    const webhook = await worker.fetch(
      new Request('https://mail.test/api/v1/webhooks/resend', {
        method: 'POST',
        headers: {
          'svix-id': eventId,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        },
        body: raw,
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    expect(webhook.status).toBe(200);
    expect(
      (
        (await env.DB.prepare('SELECT status FROM deliveries WHERE recipient=?')
          .bind('friend@example.net')
          .first()) as any
      ).status,
    ).toBe('delivered');
    expect((await request('/webhooks/resend', 'POST', {}, 'none')).status).toBe(
      401,
    );
  });
  it('holds early delivery events and prevents older events downgrading status', async () => {
    const d = await draft(),
      job = (await (
        await request(`/mail/drafts/${d.id}/send`, 'POST', {
          revision: d.revision,
          key: crypto.randomUUID(),
        })
      ).json()) as any;
    const at = Date.now() + 2000;
    await handleDelivery(env, {
      id: 'early',
      provider: 'cloudflare',
      providerId: '<native-id@cloudflare.com>',
      recipients: ['friend@example.net'],
      status: 'delivered',
      detail: '',
      at,
    });
    await env.DB.prepare('UPDATE send_jobs SET due_at=0 WHERE id=?')
      .bind(job.id)
      .run();
    await dispatchSend(env, job.id);
    await handleDelivery(env, {
      id: 'older',
      provider: 'cloudflare',
      providerId: '<native-id@cloudflare.com>',
      recipients: ['friend@example.net'],
      status: 'accepted',
      detail: '',
      at: at - 1000,
    });
    expect(
      (
        (await env.DB.prepare('SELECT status FROM deliveries WHERE recipient=?')
          .bind('friend@example.net')
          .first()) as any
      ).status,
    ).toBe('delivered');
  });
});
describe('automatic domain setup safety', () => {
  function mockDomainSetup(
    options: { routingError?: string; disabledSender?: boolean } = {},
  ) {
    const records = [
      ...[1, 2, 3].map((n) => ({
        id: `mx-${n}`,
        type: 'MX',
        name: 'example.com',
        content: `route${n}.mx.cloudflare.net`,
        priority: n * 10,
      })),
      {
        id: 'spf',
        type: 'TXT',
        name: 'example.com',
        content: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
      },
      {
        id: 'dmarc',
        type: 'TXT',
        name: '_dmarc.example.com',
        content: 'v=DMARC1; p=reject;',
      },
    ];
    const rule = {
      id: 'old-rule',
      name: 'Old forwarding',
      enabled: true,
      priority: 3,
      matchers: [{ type: 'literal', field: 'to', value: 'hello@example.com' }],
      actions: [{ type: 'forward', value: ['old@example.net'] }],
    };
    let route = {
      enabled: false,
      actions: [] as { type: string; value?: string[] }[],
    };
    let sender = options.disabledSender
      ? {
          name: 'example.com',
          tag: 'native-domain',
          enabled: false,
          dkim_selector: 'native-selector',
          return_path_domain: 'cf-bounce.example.com',
        }
      : null;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input)),
          method = init?.method || 'GET';
        const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
        const reply = (result: unknown) =>
          new Response(JSON.stringify({ success: true, result }));
        const rejected = (message: string) =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message }],
            }),
            { status: 400 },
          );
        if (url.hostname === 'cloudflare-dns.com') {
          const type = url.searchParams.get('type');
          return new Response(
            JSON.stringify({
              Answer:
                type === 'MX'
                  ? [1, 2, 3].map((n) => ({
                      data: `${n * 10} route${n}.mx.cloudflare.net.`,
                    }))
                  : [
                      {
                        data:
                          url.searchParams.get('name') ===
                          'cf-bounce.example.com'
                            ? '"v=spf1 include:_spf.mx.cloudflare.net ~all"'
                            : '"v=DKIM1; p=public-key"',
                      },
                    ],
            }),
          );
        }
        const path = url.pathname;
        if (path.endsWith('/dns_records') && method === 'GET')
          return reply(records);
        if (path.endsWith('/dns_records/spf') && method === 'PATCH')
          return reply(payload);
        if (path.endsWith('/email/routing/dns')) {
          // Cloudflare treats the optional name as a subdomain. Apex onboarding must omit it.
          if (payload?.name)
            return rejected(
              'Invalid Input: must be a subdomains of example.com',
            );
          if (options.routingError) return rejected(options.routingError);
          return reply({ enabled: true, name: 'example.com' });
        }
        if (path.endsWith('/email/routing') && method === 'PATCH')
          return reply({ enabled: true });
        if (path.endsWith('/email/routing/rules') && method === 'GET')
          return reply([rule]);
        if (path.endsWith('/email/routing/rules/old-rule')) {
          if (method !== 'PUT' || !payload?.matchers || !payload?.actions)
            return rejected('Routing rules require a complete PUT request');
          rule.enabled = payload.enabled;
          return reply({ ...rule });
        }
        if (path.endsWith('/email/routing/rules/catch_all')) {
          if (method === 'PUT') route = payload;
          return reply(route);
        }
        if (path.endsWith('/email/sending/subdomains')) {
          if (method === 'GET') return reply(sender ? [sender] : []);
          if (method === 'POST') {
            sender = {
              name: payload.name,
              tag: 'native-domain',
              enabled: true,
              dkim_selector: 'native-selector',
              return_path_domain: 'cf-bounce.example.com',
            };
            return reply(sender);
          }
        }
        if (path.endsWith('/email/sending/subdomains/native-domain'))
          return reply(sender);
        throw new Error(`Unexpected setup request: ${method} ${path}`);
      });
    return { fetch, rule };
  }
  async function connectSetup() {
    await putIntegration(env, 'cloudflare', {
      token: 'test-cloudflare-token',
      accountId: 'account',
      workerName: 'yougotmail',
      queueId: '',
    });
  }
  it('configures apex routing without a subdomain name and migrates forwarding rules with complete PUT requests', async () => {
    await connectSetup();
    const { fetch, rule } = mockDomainSetup();
    const d = await getDomain(env, domain),
      preview = await previewDomain(env, d);
    const result = await applyDomain(env, d, preview.snapshot, true);
    expect(result.receiving_status).toBe('ready');
    expect(result.sending_status).toBe('ready');
    expect(result.provider_domain_id).toBe('native-domain');
    expect((await getDomain(env, domain)).setup_lock_until).toBe(0);
    const routingCall = fetch.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith('/email/routing/dns') && init?.method === 'POST',
    );
    expect(JSON.parse(String(routingCall![1]!.body))).toEqual({});
    const migrationCall = fetch.mock.calls.find(([input]) =>
      String(input).endsWith('/email/routing/rules/old-rule'),
    );
    expect(migrationCall![1]!.method).toBe('PUT');
    expect(JSON.parse(String(migrationCall![1]!.body))).toMatchObject({
      enabled: false,
      matchers: rule.matchers,
      actions: rule.actions,
      priority: 3,
    });
    const repeatedPreview = await previewDomain(env, result);
    await applyDomain(env, result, repeatedPreview.snapshot, false);
    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('/email/sending/subdomains') &&
          init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });
  it('identifies the failing setup step and releases the lock so a corrected request can be retried', async () => {
    await connectSetup();
    const options = { routingError: 'Permission denied' };
    const { fetch } = mockDomainSetup(options);
    const d = await getDomain(env, domain),
      preview = await previewDomain(env, d);
    await expect(applyDomain(env, d, preview.snapshot, true)).rejects.toThrow(
      'Enabling incoming mail: Permission denied',
    );
    const failed = await getDomain(env, domain);
    expect(failed.last_error).toBe('Enabling incoming mail: Permission denied');
    expect(failed.setup_lock_until).toBe(0);
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes('/email/sending/'),
      ),
    ).toBe(false);
    options.routingError = '';
    const retryPreview = await previewDomain(env, failed);
    expect(
      (await applyDomain(env, failed, retryPreview.snapshot, true))
        .sending_status,
    ).toBe('ready');
  });
  it('reenables an existing disabled native sending domain instead of treating it as configured', async () => {
    await connectSetup();
    const { fetch } = mockDomainSetup({ disabledSender: true });
    const d = await getDomain(env, domain),
      preview = await previewDomain(env, d);
    expect(
      (await applyDomain(env, d, preview.snapshot, true)).sending_status,
    ).toBe('ready');
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/email/sending/subdomains') &&
          init?.method === 'POST',
      ),
    ).toBe(true);
  });
  it('normalises provider-relative DNS names before installation', () => {
    expect(providerDnsName('resend._domainkey', 'example.com')).toBe(
      'resend._domainkey.example.com',
    );
    expect(providerDnsName('send.example.com.', 'example.com')).toBe(
      'send.example.com',
    );
    expect(providerDnsName('@', 'example.com')).toBe('example.com');
  });
  it('previews SPF merging, detects existing mail routes, and requires explicit migration', async () => {
    await putIntegration(env, 'cloudflare', {
      token: 'test-cloudflare-token',
      accountId: 'account',
      workerName: 'yougotmail',
      queueId: 'queue',
    });
    const records = [
      {
        id: 'mx-old',
        type: 'MX',
        name: 'example.com',
        content: 'old.mx.example',
        priority: 10,
      },
      {
        id: 'spf',
        type: 'TXT',
        name: 'example.com',
        content: 'v=spf1 include:existing.example -all',
      },
      {
        id: 'dmarc',
        type: 'TXT',
        name: '_dmarc.example.com',
        content: 'v=DMARC1; p=reject;',
      },
    ];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        return new Response(
          JSON.stringify({
            success: true,
            result: path.endsWith('dns_records')
              ? records
              : path.endsWith('catch_all')
                ? {
                    enabled: true,
                    actions: [{ type: 'forward', value: ['old@example.net'] }],
                  }
                : [
                    {
                      id: 'rule',
                      enabled: true,
                      name: 'Old route',
                      actions: [{ type: 'forward' }],
                    },
                  ],
          }),
        );
      });
    const d = await getDomain(env, domain),
      preview = await previewDomain(env, d);
    expect(preview.needsMigration).toBe(true);
    expect(preview.required.find((r) => r.type === 'TXT')!.content).toBe(
      'v=spf1 include:existing.example include:_spf.mx.cloudflare.net -all',
    );
    expect(preview.existing.find((r) => r.id === 'dmarc')!.content).toBe(
      'v=DMARC1; p=reject;',
    );
    await expect(applyDomain(env, d, preview.snapshot, false)).rejects.toThrow(
      /Confirm migration/,
    );
    expect(fetch.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(
      true,
    );
    records[0].content = 'changed.mx.example';
    await expect(applyDomain(env, d, preview.snapshot, true)).rejects.toThrow(
      /changed since/,
    );
  });
});
