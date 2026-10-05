import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './env';
import { AppError } from './env';
import { authenticate } from './auth';
import {
  body,
  emailSchema,
  id,
  json,
  mailboxAccess,
  nameSchema,
  notifyMailbox,
} from './lib';
import { cleanHtml } from './content';

export const preferences = new Hono<AppEnv>();
preferences.use('*', authenticate);
preferences.get('/contacts', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT id,name,email,notes FROM contacts WHERE user_id=? ORDER BY name COLLATE NOCASE LIMIT 2000',
      )
        .bind(c.get('user').id)
        .all()
    ).results,
  ),
);
const contact = z.object({
  name: nameSchema,
  email: emailSchema,
  notes: z.string().max(2000).default(''),
});
preferences.post('/contacts', async (c) => {
  const data = await body(c, contact),
    contactId = id();
  await c.env.DB.prepare(
    'INSERT INTO contacts(id,user_id,name,email,notes) VALUES(?,?,?,?,?)',
  )
    .bind(contactId, c.get('user').id, data.name, data.email, data.notes)
    .run();
  return c.json({ id: contactId, ...data }, 201);
});
preferences.patch('/contacts/:id', async (c) => {
  const data = await body(c, contact);
  const update = await c.env.DB.prepare(
    'UPDATE contacts SET name=?,email=?,notes=? WHERE id=? AND user_id=?',
  )
    .bind(
      data.name,
      data.email,
      data.notes,
      c.req.param('id'),
      c.get('user').id,
    )
    .run();
  if (!update.meta.changes) throw new AppError(404, 'Contact not found');
  return c.json({ ok: true });
});
preferences.delete('/contacts/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM contacts WHERE id=? AND user_id=?')
    .bind(c.req.param('id'), c.get('user').id)
    .run();
  return c.json({ ok: true });
});
preferences.get('/filters/:mailbox', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  return c.json(
    (
      await c.env.DB.prepare(
        'SELECT * FROM filters WHERE mailbox_id=? ORDER BY position,id',
      )
        .bind(c.req.param('mailbox'))
        .all()
    ).results.map((f) => ({
      ...f,
      conditions: json(String(f.conditions), {}),
      actions: json(String(f.actions), {}),
    })),
  );
});
const filter = z.object({
  name: nameSchema,
  position: z.number().int().min(0).max(1000).default(0),
  enabled: z.boolean().default(true),
  conditions: z.object({
    from: z.string().max(254).optional(),
    to: z.string().max(254).optional(),
    subject: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
    hasAttachment: z.boolean().optional(),
  }),
  actions: z.object({
    labelId: z.string().uuid().optional(),
    archive: z.boolean().optional(),
    star: z.boolean().optional(),
    markRead: z.boolean().optional(),
    spam: z.boolean().optional(),
  }),
});
preferences.post('/filters/:mailbox', async (c) => {
  const mailbox = c.req.param('mailbox');
  await mailboxAccess(c.env, c.get('user'), mailbox);
  const data = await body(c, filter),
    filterId = id();
  if (
    data.actions.labelId &&
    !(await c.env.DB.prepare('SELECT 1 FROM labels WHERE id=? AND mailbox_id=?')
      .bind(data.actions.labelId, mailbox)
      .first())
  )
    throw new AppError(400, 'Choose a label from this mailbox');
  await c.env.DB.prepare(
    'INSERT INTO filters(id,mailbox_id,name,position,enabled,conditions,actions) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(
      filterId,
      mailbox,
      data.name,
      data.position,
      data.enabled ? 1 : 0,
      JSON.stringify(data.conditions),
      JSON.stringify(data.actions),
    )
    .run();
  return c.json({ id: filterId, ...data }, 201);
});
preferences.patch('/filters/:mailbox/:id', async (c) => {
  const mailbox = c.req.param('mailbox');
  await mailboxAccess(c.env, c.get('user'), mailbox);
  const data = await body(c, filter);
  if (
    data.actions.labelId &&
    !(await c.env.DB.prepare('SELECT 1 FROM labels WHERE id=? AND mailbox_id=?')
      .bind(data.actions.labelId, mailbox)
      .first())
  )
    throw new AppError(400, 'Choose a label from this mailbox');
  await c.env.DB.prepare(
    'UPDATE filters SET name=?,position=?,enabled=?,conditions=?,actions=? WHERE id=? AND mailbox_id=?',
  )
    .bind(
      data.name,
      data.position,
      data.enabled ? 1 : 0,
      JSON.stringify(data.conditions),
      JSON.stringify(data.actions),
      c.req.param('id'),
      mailbox,
    )
    .run();
  return c.json({ ok: true });
});
preferences.delete('/filters/:mailbox/:id', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  await c.env.DB.prepare('DELETE FROM filters WHERE id=? AND mailbox_id=?')
    .bind(c.req.param('id'), c.req.param('mailbox'))
    .run();
  return c.json({ ok: true });
});
preferences.get('/blocked/:mailbox', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  return c.json(
    (
      await c.env.DB.prepare(
        'SELECT sender FROM blocked_senders WHERE mailbox_id=? ORDER BY sender',
      )
        .bind(c.req.param('mailbox'))
        .all()
    ).results,
  );
});
preferences.post('/blocked/:mailbox', async (c) => {
  const mailbox = c.req.param('mailbox');
  await mailboxAccess(c.env, c.get('user'), mailbox);
  const { sender } = await body(
    c,
    z.object({
      sender: z
        .string()
        .trim()
        .toLowerCase()
        .max(254)
        .refine(
          (v) =>
            /^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ||
            emailSchema.safeParse(v).success,
          'Use an email address or @domain.com',
        ),
    }),
  );
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO blocked_senders(mailbox_id,sender) VALUES(?,?)',
  )
    .bind(mailbox, sender)
    .run();
  return c.json({ ok: true });
});
preferences.delete('/blocked/:mailbox', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  const { sender } = await body(c, z.object({ sender: z.string().max(254) }));
  await c.env.DB.prepare(
    'DELETE FROM blocked_senders WHERE mailbox_id=? AND sender=?',
  )
    .bind(c.req.param('mailbox'), sender)
    .run();
  return c.json({ ok: true });
});
preferences.get('/vacation/:mailbox', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  const row = await c.env.DB.prepare(
    'SELECT vacation FROM mailboxes WHERE id=?',
  )
    .bind(c.req.param('mailbox'))
    .first<{ vacation: string }>();
  return c.json(
    json(row?.vacation, {
      enabled: false,
      start: 0,
      end: 0,
      subject: 'Out of office',
      text: '',
    }),
  );
});
preferences.put('/vacation/:mailbox', async (c) => {
  await mailboxAccess(c.env, c.get('user'), c.req.param('mailbox'));
  const data = await body(
    c,
    z
      .object({
        enabled: z.boolean(),
        start: z.number().int(),
        end: z.number().int(),
        subject: z.string().max(200),
        text: z.string().max(10000),
      })
      .refine(
        (v) => !v.enabled || v.end > v.start,
        'The end date must be after the start date',
      ),
  );
  await c.env.DB.prepare('UPDATE mailboxes SET vacation=? WHERE id=?')
    .bind(JSON.stringify(data), c.req.param('mailbox'))
    .run();
  return c.json({ ok: true });
});
preferences.patch('/addresses/:id', async (c) => {
  const data = await body(
      c,
      z.object({ name: z.string().max(100), signature: z.string().max(10000) }),
    ),
    address = await c.env.DB.prepare(
      'SELECT mailbox_id FROM addresses WHERE id=?',
    )
      .bind(c.req.param('id'))
      .first<{ mailbox_id: string }>();
  if (!address) throw new AppError(404, 'Address not found');
  await mailboxAccess(c.env, c.get('user'), address.mailbox_id);
  await c.env.DB.prepare('UPDATE addresses SET name=?,signature=? WHERE id=?')
    .bind(data.name, cleanHtml(data.signature), c.req.param('id'))
    .run();
  await notifyMailbox(c.env, address.mailbox_id);
  return c.json({ ok: true });
});
