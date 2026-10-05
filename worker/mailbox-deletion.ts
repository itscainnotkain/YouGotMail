import { AppError, type Env } from './env';
import { id, now } from './lib';

export async function deleteMailbox(
  env: Env,
  userId: string,
  mailboxId: string,
  confirmation: string,
) {
  const mailbox = await env.DB.prepare('SELECT name FROM mailboxes WHERE id=?')
    .bind(mailboxId)
    .first<{ name: string }>();
  if (!mailbox) throw new AppError(404, 'Mailbox not found');
  if (confirmation !== mailbox.name)
    throw new AppError(
      400,
      'Type the mailbox name exactly to confirm deletion',
    );

  const deletionId = id();
  // The claim and all metadata removal share a transaction. Sending/ingestion
  // claims serialize against this check, so active processing cannot be deleted.
  const gate = 'EXISTS(SELECT 1 FROM mailbox_deletions WHERE id=?)';
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mailbox_deletions(id,mailbox_id,created_at)
       SELECT ?,id,? FROM mailboxes WHERE id=? AND name=?
       AND NOT EXISTS(SELECT 1 FROM send_jobs WHERE mailbox_id=mailboxes.id AND status='sending')
       AND NOT EXISTS(SELECT 1 FROM ingestions WHERE mailbox_id=mailboxes.id AND status='processing')
       AND NOT EXISTS(SELECT 1 FROM drafts WHERE mailbox_id=mailboxes.id AND send_lock IS NOT NULL)`,
    ).bind(deletionId, now(), mailboxId, confirmation),
    env.DB.prepare(
      `DELETE FROM search_chunks WHERE mailbox_id=? AND ${gate}`,
    ).bind(mailboxId, deletionId),
    env.DB.prepare(
      `UPDATE domains SET catch_all_mailbox=NULL WHERE catch_all_mailbox=? AND ${gate}`,
    ).bind(mailboxId, deletionId),
    env.DB.prepare(
      `UPDATE invitations SET mailbox_ids=(SELECT json_group_array(value) FROM json_each(invitations.mailbox_ids) WHERE value<>?)
       WHERE ${gate} AND EXISTS(SELECT 1 FROM json_each(invitations.mailbox_ids) WHERE value=?)`,
    ).bind(mailboxId, deletionId, mailboxId),
    env.DB.prepare(`DELETE FROM drafts WHERE mailbox_id=? AND ${gate}`).bind(
      mailboxId,
      deletionId,
    ),
    env.DB.prepare(
      `INSERT INTO audit(id,user_id,action,target,detail,created_at)
       SELECT ?,?,'mailbox.delete',?,?,? WHERE ${gate}`,
    ).bind(
      id(),
      userId,
      mailboxId,
      JSON.stringify({ name: mailbox.name }),
      now(),
      deletionId,
    ),
    env.DB.prepare(`DELETE FROM mailboxes WHERE id=? AND ${gate}`).bind(
      mailboxId,
      deletionId,
    ),
  ]);
  if (!result[0].meta.changes)
    throw new AppError(
      409,
      'The mailbox changed or is processing mail. Wait a moment, refresh, and try again.',
    );
  return deletionId;
}

const prefixes = ['raw', 'bodies', 'attachments', 'outbox'];

export async function purgeMailboxFiles(env: Env, deletionId: string) {
  // Bounded batches fit Worker limits. Persisted deletion records are retried
  // by cron even if queue publication or object deletion fails.
  for (let page = 0; page < 4; page++) {
    const deletion = await env.DB.prepare(
      'SELECT mailbox_id,phase FROM mailbox_deletions WHERE id=?',
    )
      .bind(deletionId)
      .first<{ mailbox_id: string; phase: number }>();
    if (!deletion) return;
    if (deletion.phase >= prefixes.length) {
      await env.DB.prepare('DELETE FROM mailbox_deletions WHERE id=?')
        .bind(deletionId)
        .run();
      return;
    }
    const objects = await env.FILES.list({
      prefix: `${prefixes[deletion.phase]}/${deletion.mailbox_id}/`,
      limit: 100,
    });
    if (objects.objects.length)
      await env.FILES.delete(objects.objects.map((object) => object.key));
    // Always list from the beginning: deleted pages need no cursor and retries
    // cannot skip files. Phase updates are safe with duplicate queue deliveries.
    if (!objects.truncated)
      await env.DB.prepare(
        'UPDATE mailbox_deletions SET phase=phase+1 WHERE id=? AND phase=?',
      )
        .bind(deletionId, deletion.phase)
        .run();
  }
  await env.DB.prepare('DELETE FROM mailbox_deletions WHERE id=? AND phase>=?')
    .bind(deletionId, prefixes.length)
    .run();
}
