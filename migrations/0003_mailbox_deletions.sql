-- No mailbox foreign key: cleanup must survive deletion of its metadata.
CREATE TABLE mailbox_deletions (
 id TEXT PRIMARY KEY,
 mailbox_id TEXT NOT NULL UNIQUE,
 phase INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
