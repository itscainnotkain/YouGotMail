import type { Env, Task } from './env';
import { now, notifyMailbox } from './lib';
import { dispatchSend, cloudflareEvent, materializeSent } from './sending';
import { processIngestion } from './receiving';

export async function queueHandler(batch: MessageBatch<unknown>, env: Env) {
  for (const message of batch.messages) {
    try {
      const body = message.body as Task;
      if (batch.queue.endsWith('-dead')) {
        if (body.kind === 'ingest')
          await env.DB.prepare(
            "UPDATE ingestions SET status='failed',lease_until=NULL,error='Automatic processing retries were exhausted. Retry from the health page.' WHERE id=? AND status<>'done'",
          )
            .bind(body.id)
            .run();
        if (body.kind === 'send')
          await env.DB.prepare(
            "UPDATE send_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'failed' END,lease_until=NULL,last_error='Automatic retries were exhausted. Review from the health page.' WHERE id=? AND status NOT IN ('accepted','delivered','delivery_failed','cancelled')",
          )
            .bind(body.id)
            .run();
      } else if (body.kind === 'ingest') await processIngestion(env, body.id);
      else if (body.kind === 'send') await dispatchSend(env, body.id);
      else await cloudflareEvent(env, message.body);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
export async function scheduledHandler(env: Env) {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE drafts SET send_lock=NULL WHERE send_lock IS NOT NULL AND updated_at<? AND NOT EXISTS(SELECT 1 FROM send_jobs j WHERE j.draft_id=drafts.id)',
    ).bind(timestamp - 10 * 60_000),
    env.DB.prepare(
      "UPDATE ingestions SET status='pending',lease_until=NULL WHERE status='processing' AND lease_until<?",
    ).bind(timestamp),
    env.DB.prepare(
      "UPDATE send_jobs SET status='uncertain',lease_until=NULL,last_error='Sending was interrupted. Delivery may have occurred; review before retrying.' WHERE status='sending' AND lease_until<?",
    ).bind(timestamp),
  ]);
  const tasks: Task[] = [];
  for (const row of (
    await env.DB.prepare(
      "SELECT id FROM ingestions WHERE status='pending' ORDER BY created_at LIMIT 20",
    ).all<{ id: string }>()
  ).results)
    tasks.push({ kind: 'ingest', id: row.id });
  for (const row of (
    await env.DB.prepare(
      "SELECT id FROM send_jobs WHERE status IN ('pending','queued') AND due_at<=? ORDER BY due_at LIMIT 20",
    )
      .bind(timestamp)
      .all<{ id: string }>()
  ).results)
    tasks.push({ kind: 'send', id: row.id });
  if (tasks.length) await env.JOBS.sendBatch(tasks.map((body) => ({ body })));
  const unmaterialized = (
    await env.DB.prepare(
      "SELECT * FROM send_jobs WHERE status IN ('accepted','delivered','delivery_failed') AND message_id IS NULL LIMIT 5",
    ).all()
  ).results;
  for (const job of unmaterialized)
    try {
      await materializeSent(
        env,
        job as unknown as Parameters<typeof materializeSent>[1],
      );
    } catch {
      /* Keep the accepted send job for recovery on the next tick. */
    }
  const snoozed = (
    await env.DB.prepare(
      'SELECT DISTINCT mailbox_id FROM threads WHERE snoozed_until<=?',
    )
      .bind(timestamp)
      .all<{ mailbox_id: string }>()
  ).results;
  await env.DB.prepare(
    'UPDATE threads SET snoozed_until=NULL WHERE snoozed_until<=?',
  )
    .bind(timestamp)
    .run();
  for (const mailbox of snoozed) await notifyMailbox(env, mailbox.mailbox_id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(timestamp),
    env.DB.prepare('DELETE FROM recovery_tokens WHERE expires_at<?').bind(
      timestamp,
    ),
    env.DB.prepare('DELETE FROM invitations WHERE expires_at<?').bind(
      timestamp - 7 * 86400_000,
    ),
    env.DB.prepare('DELETE FROM events WHERE created_at<?').bind(
      timestamp - 30 * 86400_000,
    ),
    env.DB.prepare('DELETE FROM pending_events WHERE created_at<?').bind(
      timestamp - 7 * 86400_000,
    ),
  ]);
  const expired = (
    await env.DB.prepare(
      "SELECT id,mailbox_id FROM threads WHERE folder IN ('trash','spam') AND COALESCE(deleted_at,updated_at)<? LIMIT 10",
    )
      .bind(timestamp - 30 * 86400_000)
      .all<{ id: string; mailbox_id: string }>()
  ).results;
  for (const thread of expired)
    await deleteThread(env, thread.id, thread.mailbox_id);
  const abandoned = (
    await env.DB.prepare(
      'SELECT id,object_key FROM attachments WHERE message_id IS NULL AND draft_id IS NULL AND job_id IS NULL AND created_at<? LIMIT 25',
    )
      .bind(timestamp - 2 * 86400_000)
      .all<{ id: string; object_key: string }>()
  ).results;
  for (const a of abandoned) {
    await env.FILES.delete(a.object_key);
    await env.DB.prepare('DELETE FROM attachments WHERE id=?').bind(a.id).run();
  }
  // Recover orphan objects after a DB failure during streaming upload. Paginated cleanup resumes on each cron tick.
  await cleanupOrphans(env, timestamp);
}
export async function deleteThread(
  env: Env,
  threadId: string,
  mailboxId: string,
) {
  const messages = (
    await env.DB.prepare(
      'SELECT id,body_key,raw_key,size FROM messages WHERE thread_id=? AND mailbox_id=?',
    )
      .bind(threadId, mailboxId)
      .all<{ id: string; body_key: string; raw_key: string; size: number }>()
  ).results;
  const attachments = (
    await env.DB.prepare(
      'SELECT object_key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)',
    )
      .bind(threadId)
      .all<{ object_key: string }>()
  ).results;
  const ingestions = (
    await env.DB.prepare(
      "SELECT id FROM ingestions WHERE raw_key IN (SELECT raw_key FROM messages WHERE thread_id=? AND raw_key<>'')",
    )
      .bind(threadId)
      .all<{ id: string }>()
  ).results;
  const jobs = (
    await env.DB.prepare(
      'SELECT id,payload_key FROM send_jobs WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)',
    )
      .bind(threadId)
      .all<{ id: string; payload_key: string }>()
  ).results;
  const statements = [
    env.DB.prepare(
      'DELETE FROM search_chunks WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)',
    ).bind(threadId),
    env.DB.prepare('DELETE FROM threads WHERE id=? AND mailbox_id=?').bind(
      threadId,
      mailboxId,
    ),
    env.DB.prepare(
      'UPDATE mailboxes SET used_bytes=MAX(0,used_bytes-?) WHERE id=?',
    ).bind(
      messages.reduce((sum, m) => sum + m.size, 0),
      mailboxId,
    ),
  ];
  for (const job of jobs)
    statements.push(
      env.DB.prepare('DELETE FROM send_jobs WHERE id=?').bind(job.id),
    );
  for (const ingestion of ingestions)
    statements.push(
      env.DB.prepare('DELETE FROM ingestions WHERE id=?').bind(ingestion.id),
    );
  await env.DB.batch(statements);
  const keys = [
    ...messages.flatMap((m) => [m.body_key, m.raw_key]),
    ...attachments.map((a) => a.object_key),
    ...jobs.map((j) => j.payload_key),
  ].filter(Boolean);
  for (const key of new Set(keys)) await env.FILES.delete(key);
  await notifyMailbox(env, mailboxId);
}
async function cleanupOrphans(env: Env, timestamp: number) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='cleanup_cursor'",
  ).first<{ value: string }>();
  const listed = await env.FILES.list({
    limit: 20,
    ...(row?.value ? { cursor: row.value } : {}),
  });
  for (const object of listed.objects) {
    if (
      object.uploaded.getTime() > timestamp - 2 * 86400_000 ||
      object.key.startsWith('branding/')
    )
      continue;
    const exists = await env.DB.prepare(
      'SELECT 1 FROM attachments WHERE object_key=? UNION ALL SELECT 1 FROM messages WHERE body_key=? OR raw_key=? UNION ALL SELECT 1 FROM ingestions WHERE raw_key=? UNION ALL SELECT 1 FROM send_jobs WHERE payload_key=? LIMIT 1',
    )
      .bind(object.key, object.key, object.key, object.key, object.key)
      .first();
    if (!exists) await env.FILES.delete(object.key);
  }
  await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES('cleanup_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(listed.truncated ? listed.cursor : '')
    .run();
}
