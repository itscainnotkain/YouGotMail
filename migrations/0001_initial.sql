PRAGMA foreign_keys = ON;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('branding', '{"name":"YouGotMail","accent":"#365c45","login_text":"A little less noise. A little more you.","logo":"","favicon":"","app_url":"","setup_complete":false}');
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL,
 recovery_email TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
 timezone TEXT NOT NULL DEFAULT 'UTC', totp_secret TEXT, totp_pending TEXT, totp_last_step INTEGER NOT NULL DEFAULT 0,
 recovery_codes TEXT NOT NULL DEFAULT '[]', disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX only_one_owner ON users(role) WHERE role='owner';
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invitations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, mailbox_ids TEXT NOT NULL DEFAULT '[]', expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE recovery_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE integrations (name TEXT PRIMARY KEY, encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE domains (
 id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, zone_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('cloudflare','resend')),
 receiving_status TEXT NOT NULL DEFAULT 'pending', sending_status TEXT NOT NULL DEFAULT 'pending',
 catch_all_mailbox TEXT, provider_domain_id TEXT NOT NULL DEFAULT '', event_subscription_id TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', last_checked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE mailboxes (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','shared')), primary_address TEXT NOT NULL DEFAULT '',
 quota_bytes INTEGER NOT NULL DEFAULT 1073741824, used_bytes INTEGER NOT NULL DEFAULT 0,
 vacation TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE mailbox_members (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(mailbox_id,user_id));
CREATE INDEX memberships_user ON mailbox_members(user_id,mailbox_id);
CREATE TABLE addresses (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, domain_id TEXT NOT NULL REFERENCES domains(id),
 email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX addresses_mailbox ON addresses(mailbox_id);
CREATE TABLE threads (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, subject TEXT NOT NULL,
 snippet TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
 unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL DEFAULT 'inbox', snoozed_until INTEGER, deleted_at INTEGER,
 count INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_list ON threads(mailbox_id,folder,updated_at DESC,id DESC);
CREATE INDEX threads_snooze ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE TABLE messages (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 direction TEXT NOT NULL, from_address TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '',
 to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]', reply_to_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL, date INTEGER NOT NULL,
 internet_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]',
 raw_key TEXT NOT NULL DEFAULT '', body_key TEXT NOT NULL, parse_error TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
 fingerprint TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '', UNIQUE(mailbox_id,fingerprint)
);
CREATE INDEX messages_thread ON messages(thread_id,date,id);
CREATE INDEX messages_internet ON messages(mailbox_id,internet_id);
CREATE INDEX messages_provider ON messages(provider_id);
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, draft_id TEXT, job_id TEXT,
 filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, object_key TEXT NOT NULL, cid TEXT NOT NULL DEFAULT '', inline INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX attachments_draft ON attachments(draft_id);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE TABLE labels (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#365c45', UNIQUE(mailbox_id,name));
CREATE TABLE thread_labels (thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY(thread_id,label_id));
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, address_id TEXT NOT NULL REFERENCES addresses(id), thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
 subject TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
 html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),
 in_reply_to TEXT NOT NULL DEFAULT '', references_json TEXT NOT NULL DEFAULT '[]', send_lock TEXT
);
CREATE TABLE send_jobs (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 draft_id TEXT, provider TEXT NOT NULL, domain_id TEXT NOT NULL REFERENCES domains(id), payload_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, started_at INTEGER,
 provider_id TEXT NOT NULL DEFAULT '', message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX jobs_due ON send_jobs(status,due_at);
CREATE TABLE deliveries (job_id TEXT NOT NULL REFERENCES send_jobs(id) ON DELETE CASCADE, recipient TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY(job_id,recipient));
CREATE TABLE events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE pending_events (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX pending_provider ON pending_events(provider_id);
CREATE TABLE ingestions (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, envelope_from TEXT NOT NULL, envelope_to TEXT NOT NULL, raw_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, error TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(mailbox_id,fingerprint)
);
CREATE INDEX ingestion_status ON ingestions(status,created_at);
CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, email TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', UNIQUE(user_id,email));
CREATE TABLE filters (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, conditions TEXT NOT NULL, actions TEXT NOT NULL);
CREATE TABLE blocked_senders (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, sender TEXT NOT NULL, PRIMARY KEY(mailbox_id,sender));
CREATE TABLE vacation_replies (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, sender TEXT NOT NULL, last_sent INTEGER NOT NULL, PRIMARY KEY(mailbox_id,sender));
CREATE TABLE audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX audit_date ON audit(created_at DESC);
CREATE VIRTUAL TABLE search_chunks USING fts5(message_id UNINDEXED, mailbox_id UNINDEXED, subject, participants, body, tokenize='unicode61');
