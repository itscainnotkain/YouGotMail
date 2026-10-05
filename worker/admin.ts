import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { AppError } from './env';
import { authenticate } from './auth';
import {
  admin as requireAdmin,
  audit,
  body,
  branding,
  emailSchema,
  id,
  json,
  nameSchema,
  notifyMailbox,
  now,
  publicUser,
} from './lib';
import { digest, token } from './crypto';
import { sendSystemEmail } from './sending';
import { deleteMailbox } from './mailbox-deletion';

export const administration = new Hono<AppEnv>();
administration.use('*', authenticate);
administration.use('*', async (c, next) => {
  requireAdmin(c);
  await next();
});
administration.get('/users', async (c) =>
  c.json(
    (
      await c.env.DB.prepare('SELECT * FROM users ORDER BY created_at').all<
        Record<string, unknown>
      >()
    ).results.map((row) => ({
      ...publicUser(row),
      disabled: !!row.disabled,
      created_at: row.created_at,
    })),
  ),
);
administration.patch('/users/:id', async (c) => {
  const data = await body(
      c,
      z.object({
        name: nameSchema.optional(),
        role: z.enum(['admin', 'member']).optional(),
        disabled: z.boolean().optional(),
      }),
    ),
    userId = c.req.param('id');
  const user = await c.env.DB.prepare('SELECT role FROM users WHERE id=?')
    .bind(userId)
    .first<{ role: string }>();
  if (!user) throw new AppError(404, 'User not found');
  if (user.role === 'owner')
    throw new AppError(403, 'The owner cannot be disabled or demoted');
  if (userId === c.get('user').id && data.disabled)
    throw new AppError(400, 'You cannot disable yourself');
  if (c.get('user').role !== 'owner' && (data.role || user.role === 'admin'))
    throw new AppError(403, 'Only the owner can manage administrators');
  const statements = [];
  if (data.name)
    statements.push(
      c.env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(
        data.name,
        userId,
      ),
    );
  if (data.role)
    statements.push(
      c.env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(
        data.role,
        userId,
      ),
    );
  if (data.disabled !== undefined) {
    statements.push(
      c.env.DB.prepare('UPDATE users SET disabled=? WHERE id=?').bind(
        data.disabled ? 1 : 0,
        userId,
      ),
    );
    if (data.disabled)
      statements.push(
        c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId),
      );
  }
  if (statements.length) await c.env.DB.batch(statements);
  await audit(
    c.env,
    c.get('user').id,
    'user.update',
    userId,
    JSON.stringify(data),
  );
  return c.json({ ok: true });
});
administration.get('/invitations', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT id,email,name,role,expires_at,used_at FROM invitations ORDER BY created_at DESC LIMIT 100',
      ).all()
    ).results,
  ),
);
administration.post('/invitations', async (c) => {
  const data = await body(
    c,
    z.object({
      email: emailSchema,
      name: nameSchema,
      role: z.enum(['admin', 'member']).default('member'),
      mailboxIds: z.array(z.string().uuid()).max(50).default([]),
      send: z.boolean().default(false),
    }),
  );
  if (data.role === 'admin' && c.get('user').role !== 'owner')
    throw new AppError(403, 'Only the owner can invite administrators');
  for (const mailboxId of data.mailboxIds) {
    const box = await c.env.DB.prepare('SELECT kind FROM mailboxes WHERE id=?')
      .bind(mailboxId)
      .first<{ kind: string }>();
    if (!box || box.kind !== 'shared')
      throw new AppError(
        400,
        'Invite new users to shared mailboxes. Create their private mailbox after they join.',
      );
  }
  const raw = token(),
    invitationId = id(),
    config = await branding(c.env),
    url = `${config.app_url || new URL(c.req.url).origin}/invite/${raw}`;
  await c.env.DB.prepare(
    'INSERT INTO invitations(id,token_hash,email,name,role,mailbox_ids,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      invitationId,
      await digest(raw),
      data.email,
      data.name,
      data.role,
      JSON.stringify(data.mailboxIds),
      now() + 7 * 86400_000,
      now(),
    )
    .run();
  let warning = '';
  if (data.send) {
    try {
      await sendSystemEmail(
        c.env,
        data.email,
        `You are invited to ${config.name}`,
        `${data.name}, join ${config.name} by opening this invitation link:\n${url}\n\nThe link expires in seven days.`,
      );
    } catch {
      warning =
        'The invitation was created, but email sending is not available. Copy the invitation link instead.';
    }
  }
  await audit(c.env, c.get('user').id, 'invitation.create', invitationId);
  return c.json({ id: invitationId, url, warning }, 201);
});
administration.delete('/invitations/:id', async (c) => {
  await c.env.DB.prepare(
    'DELETE FROM invitations WHERE id=? AND used_at IS NULL',
  )
    .bind(c.req.param('id'))
    .run();
  await audit(c.env, c.get('user').id, 'invitation.revoke', c.req.param('id'));
  return c.json({ ok: true });
});
administration.get('/mailboxes', async (c) => {
  const boxes = (
    await c.env.DB.prepare(
      'SELECT id,name,kind,primary_address,quota_bytes,used_bytes FROM mailboxes ORDER BY name',
    ).all()
  ).results;
  const members = (
    await c.env.DB.prepare(
      'SELECT mm.mailbox_id,u.id,u.name,u.username FROM mailbox_members mm JOIN users u ON u.id=mm.user_id',
    ).all()
  ).results;
  const addresses = (
    await c.env.DB.prepare(
      'SELECT a.*,d.provider,d.sending_status FROM addresses a JOIN domains d ON d.id=a.domain_id ORDER BY a.email',
    ).all()
  ).results;
  return c.json(
    boxes.map((b) => ({
      ...b,
      members: members.filter((m) => m.mailbox_id === b.id),
      addresses: addresses.filter((a) => a.mailbox_id === b.id),
    })),
  );
});
const localPart = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}$/,
    'Use a valid email local part',
  )
  .refine(
    (v) => !v.startsWith('.') && !v.endsWith('.') && !v.includes('..'),
    'Invalid local part',
  );
administration.post('/mailboxes', async (c) => {
  const data = await body(
    c,
    z.object({
      name: nameSchema,
      kind: z.enum(['private', 'shared']),
      domainId: z.string().uuid(),
      localPart,
      memberIds: z.array(z.string().uuid()).min(1).max(50),
      quotaBytes: z
        .number()
        .int()
        .min(10 * 1024 * 1024)
        .max(100 * 1024 * 1024 * 1024)
        .default(1024 * 1024 * 1024),
    }),
  );
  if (data.kind === 'private' && new Set(data.memberIds).size !== 1)
    throw new AppError(400, 'A private mailbox has one member');
  const domain = await c.env.DB.prepare('SELECT name FROM domains WHERE id=?')
    .bind(data.domainId)
    .first<{ name: string }>();
  if (!domain) throw new AppError(400, 'Choose a domain');
  for (const userId of new Set(data.memberIds))
    if (
      !(await c.env.DB.prepare('SELECT 1 FROM users WHERE id=? AND disabled=0')
        .bind(userId)
        .first())
    )
      throw new AppError(400, 'Choose active users');
  const mailboxId = id(),
    addressId = id(),
    email = `${data.localPart}@${domain.name}`;
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO mailboxes(id,name,kind,primary_address,quota_bytes,created_at) VALUES(?,?,?,?,?,?)',
    ).bind(mailboxId, data.name, data.kind, email, data.quotaBytes, now()),
    c.env.DB.prepare(
      'INSERT INTO addresses(id,mailbox_id,domain_id,email,name) VALUES(?,?,?,?,?)',
    ).bind(addressId, mailboxId, data.domainId, email, data.name),
  ];
  for (const userId of new Set(data.memberIds))
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO mailbox_members(mailbox_id,user_id) VALUES(?,?)',
      ).bind(mailboxId, userId),
    );
  await c.env.DB.batch(statements);
  await audit(c.env, c.get('user').id, 'mailbox.create', mailboxId, email);
  return c.json({ id: mailboxId, addressId, email }, 201);
});
administration.delete('/mailboxes/:id', async (c) => {
  const mailboxId = z.string().uuid().parse(c.req.param('id'));
  const { confirmation } = await body(
    c,
    z.object({ confirmation: z.string().min(1).max(100) }),
  );
  const deletionId = await deleteMailbox(
    c.env,
    c.get('user').id,
    mailboxId,
    confirmation,
  );
  c.executionCtx.waitUntil(
    Promise.allSettled([
      c.env.JOBS.send({ kind: 'purge-mailbox', id: deletionId }),
      notifyMailbox(c.env, mailboxId),
    ]),
  );
  return c.json({ ok: true }, 202);
});
administration.patch('/mailboxes/:id', async (c) => {
  const data = await body(
    c,
    z.object({
      name: nameSchema,
      quotaBytes: z
        .number()
        .int()
        .min(10 * 1024 * 1024)
        .max(100 * 1024 * 1024 * 1024),
    }),
  );
  const result = await c.env.DB.prepare(
    'UPDATE mailboxes SET name=?,quota_bytes=? WHERE id=? AND used_bytes<=?',
  )
    .bind(data.name, data.quotaBytes, c.req.param('id'), data.quotaBytes)
    .run();
  if (!result.meta.changes)
    throw new AppError(400, 'Mailbox not found or quota is below current use');
  await audit(c.env, c.get('user').id, 'mailbox.update', c.req.param('id'));
  return c.json({ ok: true });
});
administration.put('/mailboxes/:id/members', async (c) => {
  const { userIds } = await body(
      c,
      z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }),
    ),
    mailboxId = c.req.param('id');
  const box = await c.env.DB.prepare('SELECT kind FROM mailboxes WHERE id=?')
    .bind(mailboxId)
    .first<{ kind: string }>();
  if (!box) throw new AppError(404, 'Mailbox not found');
  if (box.kind === 'private' && new Set(userIds).size !== 1)
    throw new AppError(400, 'A private mailbox has one member');
  for (const userId of new Set(userIds))
    if (
      !(await c.env.DB.prepare('SELECT 1 FROM users WHERE id=? AND disabled=0')
        .bind(userId)
        .first())
    )
      throw new AppError(400, 'Choose active users');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mailbox_members WHERE mailbox_id=?').bind(
      mailboxId,
    ),
    ...Array.from(new Set(userIds)).map((userId) =>
      c.env.DB.prepare(
        'INSERT INTO mailbox_members(mailbox_id,user_id) VALUES(?,?)',
      ).bind(mailboxId, userId),
    ),
  ]);
  await audit(
    c.env,
    c.get('user').id,
    'mailbox.members',
    mailboxId,
    JSON.stringify(userIds),
  );
  return c.json({ ok: true });
});
administration.post('/mailboxes/:id/addresses', async (c) => {
  const data = await body(
      c,
      z.object({
        domainId: z.string().uuid(),
        localPart,
        name: z.string().max(100).default(''),
      }),
    ),
    mailboxId = c.req.param('id');
  const domain = await c.env.DB.prepare('SELECT name FROM domains WHERE id=?')
    .bind(data.domainId)
    .first<{ name: string }>();
  if (
    !domain ||
    !(await c.env.DB.prepare('SELECT 1 FROM mailboxes WHERE id=?')
      .bind(mailboxId)
      .first())
  )
    throw new AppError(400, 'Mailbox or domain not found');
  const addressId = id(),
    email = `${data.localPart}@${domain.name}`;
  await c.env.DB.prepare(
    'INSERT INTO addresses(id,mailbox_id,domain_id,email,name) VALUES(?,?,?,?,?)',
  )
    .bind(addressId, mailboxId, data.domainId, email, data.name)
    .run();
  await audit(c.env, c.get('user').id, 'address.create', addressId, email);
  return c.json({ id: addressId, email }, 201);
});
administration.patch('/addresses/:id', async (c) => {
  const { active, primary } = await body(
    c,
    z.object({
      active: z.boolean().optional(),
      primary: z.boolean().optional(),
    }),
  );
  const address = await c.env.DB.prepare(
    'SELECT a.*,m.primary_address FROM addresses a JOIN mailboxes m ON m.id=a.mailbox_id WHERE a.id=?',
  )
    .bind(c.req.param('id'))
    .first<{
      mailbox_id: string;
      email: string;
      primary_address: string;
      active: number;
    }>();
  if (!address) throw new AppError(404, 'Address not found');
  if (active === false && address.email === address.primary_address)
    throw new AppError(
      400,
      'Choose a different primary address before disabling this one',
    );
  if (primary && active === false)
    throw new AppError(400, 'A primary address must be active');
  if (active !== undefined)
    await c.env.DB.prepare('UPDATE addresses SET active=? WHERE id=?')
      .bind(active ? 1 : 0, c.req.param('id'))
      .run();
  if (primary && (active || address.active))
    await c.env.DB.prepare('UPDATE mailboxes SET primary_address=? WHERE id=?')
      .bind(address.email, address.mailbox_id)
      .run();
  await audit(c.env, c.get('user').id, 'address.update', c.req.param('id'));
  return c.json({ ok: true });
});
administration.get('/health', async (c) => {
  const jobs = (
    await c.env.DB.prepare(
      'SELECT status,COUNT(*) count FROM send_jobs GROUP BY status',
    ).all()
  ).results;
  const ingestions = (
    await c.env.DB.prepare(
      'SELECT status,COUNT(*) count FROM ingestions GROUP BY status',
    ).all()
  ).results;
  const failures = (
    await c.env.DB.prepare(
      "SELECT id,status,last_error,created_at,provider,mailbox_id FROM send_jobs WHERE status IN ('failed','uncertain','delivery_failed') ORDER BY created_at DESC LIMIT 30",
    ).all()
  ).results;
  const processing = (
    await c.env.DB.prepare(
      "SELECT id,status,error,created_at,mailbox_id FROM ingestions WHERE status='failed' ORDER BY created_at DESC LIMIT 30",
    ).all()
  ).results;
  const storage = await c.env.DB.prepare(
    'SELECT COUNT(*) mailboxes,COALESCE(SUM(used_bytes),0) bytes FROM mailboxes',
  ).first();
  const schema =
    (
      await c.env.DB.prepare(
        'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1',
      ).first<{ name: string }>()
    )?.name || 'unknown';
  return c.json({
    version: '0.1.0',
    schema,
    jobs,
    ingestions,
    failures,
    processing,
    storage,
    bindings: {
      database: !!c.env.DB,
      storage: !!c.env.FILES,
      queue: !!c.env.JOBS,
      email: !!c.env.EMAIL,
      live: !!c.env.LIVE,
    },
  });
});
administration.post('/jobs/:id/retry', async (c) => {
  const data = await body(
    c,
    z.object({ acknowledgeDuplicate: z.boolean().default(false) }),
  );
  const job = await c.env.DB.prepare('SELECT status FROM send_jobs WHERE id=?')
    .bind(c.req.param('id'))
    .first<{ status: string }>();
  if (!job || !['failed', 'uncertain'].includes(job.status))
    throw new AppError(400, 'Only failed or uncertain sends can be retried');
  if (job.status === 'uncertain' && !data.acknowledgeDuplicate)
    throw new AppError(
      409,
      'This email may already have been delivered. Confirm that retrying may create a duplicate.',
      'DUPLICATE_RISK',
    );
  const update = await c.env.DB.prepare(
    "UPDATE send_jobs SET status='pending',due_at=?,lease_until=NULL,attempts=0,started_at=NULL,last_error='' WHERE id=? AND status=?",
  )
    .bind(now(), c.req.param('id'), job.status)
    .run();
  if (!update.meta.changes)
    throw new AppError(409, 'Send status changed; refresh and review it again');
  await c.env.JOBS.send({ kind: 'send', id: c.req.param('id') });
  await audit(
    c.env,
    c.get('user').id,
    'send.retry',
    c.req.param('id'),
    data.acknowledgeDuplicate
      ? 'Duplicate risk acknowledged'
      : 'Confirmed failure',
  );
  return c.json({ ok: true });
});
administration.post('/ingestions/:id/retry', async (c) => {
  const update = await c.env.DB.prepare(
    "UPDATE ingestions SET status='pending',attempts=0,lease_until=NULL,error='' WHERE id=? AND status='failed'",
  )
    .bind(c.req.param('id'))
    .run();
  if (!update.meta.changes)
    throw new AppError(400, 'Only failed ingestions can be retried');
  await c.env.JOBS.send({ kind: 'ingest', id: c.req.param('id') });
  await audit(c.env, c.get('user').id, 'ingestion.retry', c.req.param('id'));
  return c.json({ ok: true });
});
administration.get('/audit', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT a.*,u.name actor FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200',
      ).all()
    ).results,
  ),
);
