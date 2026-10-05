import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Inbox,
  Leaf,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  ShieldAlert,
  Star,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import type { Draft, Thread, Message, Label } from '../shared/types';
import {
  api,
  dateLabel,
  fullDate,
  initials,
  invalidateMail,
  localDateTime,
  zonedTimestamp,
} from './api';
import { useSession } from './app';
import {
  Confirm,
  ErrorState,
  Field,
  Modal,
  Spinner,
  StatusPill,
  useToast,
} from './ui';
import { ThreadView } from './thread';

export function InboxPage() {
  const { folder = 'inbox' } = useParams(),
    [params, setParams] = useSearchParams(),
    { mailboxes, selectedMailbox, user, compose } = useSession(),
    toast = useToast();
  const q = params.get('q') || '',
    label = params.get('label') || '',
    threadId = params.get('thread') || '';
  const [selected, setSelected] = useState<string[]>([]),
    [snooze, setSnooze] = useState(false),
    [snoozeAt, setSnoozeAt] = useState(''),
    [labelMenu, setLabelMenu] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [focus, setFocus] = useState(0),
    [busy, setBusy] = useState(false);
  const labels = useQuery({
    queryKey: ['labels'],
    queryFn: () => api<Label[]>('/mail/labels'),
  });
  const list = useInfiniteQuery({
    queryKey: ['threads', folder, selectedMailbox, q, label],
    queryFn: ({ pageParam }) =>
      api<{ items: Thread[]; cursor: string | null }>(
        `/mail/threads?${new URLSearchParams({ folder, mailbox: selectedMailbox, q, label, ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    initialPageParam: '' as string,
    getNextPageParam: (r) => r.cursor || undefined,
    enabled: !['drafts', 'scheduled'].includes(folder),
  });
  const drafts = useQuery({
    queryKey: ['drafts', selectedMailbox],
    queryFn: () => api<Draft[]>(`/mail/drafts?mailbox=${selectedMailbox}`),
    enabled: folder === 'drafts',
  });
  const jobs = useQuery({
    queryKey: ['jobs', selectedMailbox],
    queryFn: () =>
      api<
        {
          id: string;
          mailbox_id: string;
          subject: string;
          to: { address: string }[];
          status: string;
          due_at: number;
          last_error: string;
        }[]
      >(`/mail/jobs?mailbox=${selectedMailbox}`),
    enabled: folder === 'scheduled',
  });
  const threads = list.data?.pages.flatMap((p) => p.items) || [],
    box = mailboxes.find((b) => b.id === selectedMailbox),
    activeLabel = labels.data?.find((l) => l.id === label);
  useEffect(() => {
    setSelected([]);
    setFocus(0);
  }, [folder, selectedMailbox, q, label]);
  useEffect(() => {
    const visible = new Set(threads.map((t) => t.id));
    setSelected((s) => s.filter((v) => visible.has(v)));
  }, [list.data]);
  function open(id: string) {
    setParams((p) => {
      p.set('thread', id);
      return p;
    });
  }
  function close() {
    setParams((p) => {
      p.delete('thread');
      return p;
    });
  }
  const actionIds = threadId ? [threadId] : selected;
  async function action(action: string, extra: Record<string, unknown> = {}) {
    if (!actionIds.length) return;
    setBusy(true);
    try {
      await api('/mail/threads/actions', {
        method: 'POST',
        body: { ids: actionIds, action, ...extra },
      });
      await invalidateMail();
      setSelected([]);
      if (['archive', 'trash', 'spam', 'delete', 'snooze'].includes(action))
        close();
      toast(
        action === 'archive'
          ? 'Conversation archived.'
          : action === 'trash'
            ? 'Moved to Trash.'
            : action === 'snooze'
              ? 'We’ll bring this back when you’re ready.'
              : 'Updated.',
      );
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,[contenteditable="true"]',
        ) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (e.key === 'e' && actionIds.length) {
        e.preventDefault();
        void action('archive');
      }
      if (e.key === '#' && actionIds.length) {
        e.preventDefault();
        void action('trash');
      }
      if (!threadId && ['j', 'k'].includes(e.key) && threads.length) {
        e.preventDefault();
        const next = Math.max(
          0,
          Math.min(threads.length - 1, focus + (e.key === 'j' ? 1 : -1)),
        );
        setFocus(next);
        document
          .querySelector<HTMLButtonElement>(`[data-thread-index="${next}"]`)
          ?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  const title = q
    ? 'Search results'
    : activeLabel?.name ||
      (
        {
          inbox: 'Inbox',
          starred: 'Starred',
          snoozed: 'Snoozed',
          sent: 'Sent',
          drafts: 'Drafts',
          scheduled: 'Outbox',
          all: 'All mail',
          spam: 'Spam',
          trash: 'Trash',
        } as Record<string, string>
      )[folder] ||
      'Inbox';
  const subtitle = q
    ? `A little clarity for “${q}”.`
    : folder === 'inbox'
      ? 'A fresh start. One message at a time.'
      : folder === 'drafts'
        ? 'Good things take a little thought.'
        : folder === 'scheduled'
          ? 'On their way, in their own time.'
          : folder === 'snoozed'
            ? 'For when you have a little more room.'
            : box
              ? box.primary_address
              : 'All your conversations, in one place.';
  return (
    <section className="mail-page">
      <div className="page-heading">
        <div>
          <div className="heading-eyebrow">
            {box ? box.name.toUpperCase() : 'YOUR MAIL, TOGETHER'}
            {box?.kind === 'shared' && (
              <span className="shared-caption">SHARED</span>
            )}
          </div>
          <h1>
            {title}
            <span className="heading-dot">.</span>
          </h1>
          <p>{subtitle}</p>
        </div>
        <div className="heading-right">
          <span className="today-label">
            {new Intl.DateTimeFormat('en-GB', {
              timeZone: user.timezone,
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            }).format(Date.now())}
          </span>
          <button
            className="icon-btn"
            title="Refresh mail"
            onClick={() => void invalidateMail()}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>
      <div className="mail-card">
        <div className="mail-toolbar">
          <div className="toolbar-left">
            {threadId ? (
              <button
                className="icon-btn"
                title="Back to inbox"
                onClick={close}
              >
                <ArrowLeft size={19} />
              </button>
            ) : (
              !['drafts', 'scheduled'].includes(folder) && (
                <label className="select-all" title="Select this page">
                  <input
                    type="checkbox"
                    aria-label="Select all visible conversations"
                    checked={
                      !!threads.length && selected.length === threads.length
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? threads.map((t) => t.id) : [],
                      )
                    }
                  />
                  <ChevronDown size={13} />
                </label>
              )
            )}
            {actionIds.length > 0 ? (
              <>
                <span className="toolbar-divider" />
                <button
                  className="icon-btn"
                  title="Archive"
                  disabled={busy}
                  onClick={() => void action('archive')}
                >
                  <Archive size={18} />
                </button>
                <button
                  className="icon-btn"
                  title="Move to Trash"
                  disabled={busy}
                  onClick={() => void action('trash')}
                >
                  <Trash2 size={18} />
                </button>
                <button
                  className="icon-btn"
                  title="Mark unread"
                  onClick={() => void action('unread')}
                >
                  <Mail size={18} />
                </button>
                <button
                  className="icon-btn"
                  title="Mark read"
                  onClick={() => void action('read')}
                >
                  <MailOpen size={18} />
                </button>
                <button
                  className="icon-btn"
                  title="Snooze"
                  onClick={() => {
                    setSnoozeAt(
                      localDateTime(Date.now() + 86400_000, user.timezone),
                    );
                    setSnooze(true);
                  }}
                >
                  <Clock3 size={18} />
                </button>
                <button
                  className="icon-btn"
                  title="Apply label"
                  onClick={() => setLabelMenu(!labelMenu)}
                >
                  <Tags size={18} />
                </button>
                <button
                  className="icon-btn"
                  title={folder === 'spam' ? 'Move to Inbox' : 'Mark as spam'}
                  onClick={() =>
                    void action(folder === 'spam' ? 'inbox' : 'spam')
                  }
                >
                  <ShieldAlert size={18} />
                </button>
                {['trash', 'spam'].includes(folder) && (
                  <button
                    className="text-btn danger-text"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete forever
                  </button>
                )}
              </>
            ) : (
              <span className="toolbar-caption">
                {['drafts', 'scheduled'].includes(folder)
                  ? 'Saved safely. Ready when you are.'
                  : q
                    ? 'Find what matters.'
                    : 'All conversations'}
              </span>
            )}
          </div>
          <div className="toolbar-right">
            {selected.length > 0 ? (
              <span>{selected.length} selected</span>
            ) : (
              <span>
                {folder === 'drafts'
                  ? drafts.data?.length || 0
                  : folder === 'scheduled'
                    ? jobs.data?.length || 0
                    : threads.length}{' '}
                conversations
              </span>
            )}
          </div>
          {labelMenu && (
            <div className="label-popover">
              <strong>Apply a label</strong>
              {(labels.data || [])
                .filter((l) => {
                  const boxes = new Set(
                    threads
                      .filter((t) => actionIds.includes(t.id))
                      .map((t) => t.mailbox_id),
                  );
                  return (
                    threadId || (boxes.size === 1 && boxes.has(l.mailbox_id))
                  );
                })
                .map((l) => (
                  <button
                    key={l.id}
                    onClick={() => {
                      void action('label', { labelId: l.id });
                      setLabelMenu(false);
                    }}
                  >
                    <i style={{ background: l.color }} />
                    {l.name}
                  </button>
                ))}
              <button onClick={() => setLabelMenu(false)}>Close</button>
            </div>
          )}
        </div>
        {threadId ? (
          <ThreadView threadId={threadId} />
        ) : folder === 'drafts' ? (
          drafts.isPending ? (
            <Spinner />
          ) : drafts.error ? (
            <ErrorState error={drafts.error} />
          ) : drafts.data?.length ? (
            <div>
              {drafts.data.map((d) => (
                <button
                  className="draft-row"
                  key={d.id}
                  onClick={() => void compose({ draftId: d.id })}
                >
                  <span className="sender-avatar draft-avatar">
                    <FileDraftIcon />
                  </span>
                  <div>
                    <strong>{d.subject || '(no subject)'}</strong>
                    <span>
                      {d.to.length
                        ? d.to.map((p) => p.name || p.address).join(', ')
                        : 'No recipients yet'}
                      <span className="draft-tag">Draft</span>
                    </span>
                  </div>
                  <time>{dateLabel(d.updated_at, user.timezone)}</time>
                </button>
              ))}
            </div>
          ) : (
            <Empty folder={folder} />
          )
        ) : folder === 'scheduled' ? (
          jobs.isPending ? (
            <Spinner />
          ) : jobs.error ? (
            <ErrorState error={jobs.error} />
          ) : jobs.data?.length ? (
            <div>
              {jobs.data.map((job) => (
                <div className="job-row" key={job.id}>
                  <span className="sender-avatar">
                    <Clock3 size={18} />
                  </span>
                  <div>
                    <strong>{job.subject || '(no subject)'}</strong>
                    <p>{job.to.map((p) => p.address).join(', ')}</p>
                    <small>
                      {fullDate(job.due_at, user.timezone)} · {user.timezone}
                    </small>
                    {job.last_error && (
                      <p className="danger-text">{job.last_error}</p>
                    )}
                  </div>
                  <StatusPill status={job.status} />
                  {['pending', 'queued', 'failed'].includes(job.status) && (
                    <button
                      className="btn secondary small"
                      onClick={async () => {
                        try {
                          const r = await api<{ draftId: string }>(
                            `/mail/jobs/${job.id}/cancel`,
                            { method: 'POST', body: {} },
                          );
                          await invalidateMail();
                          void compose({ draftId: r.draftId });
                        } catch (e) {
                          toast((e as Error).message, true);
                        }
                      }}
                    >
                      Back to draft
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty folder={folder} />
          )
        ) : list.isPending ? (
          <Spinner label="Gathering your conversations…" />
        ) : list.error ? (
          <ErrorState error={list.error} retry={() => void list.refetch()} />
        ) : threads.length ? (
          <>
            <div className="thread-list">
              {threads.map((t, index) => (
                <div
                  key={t.id}
                  className={`mail-row ${t.unread ? 'unread' : ''} ${selected.includes(t.id) ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.subject}`}
                    checked={selected.includes(t.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, t.id]
                          : s.filter((v) => v !== t.id),
                      )
                    }
                  />
                  <button
                    className={`star-btn ${t.starred ? 'starred' : ''}`}
                    aria-label={`${t.starred ? 'Unstar' : 'Star'} ${t.subject}`}
                    onClick={async () => {
                      try {
                        await api('/mail/threads/actions', {
                          method: 'POST',
                          body: {
                            ids: [t.id],
                            action: t.starred ? 'unstar' : 'star',
                          },
                        });
                        void invalidateMail();
                      } catch (e) {
                        toast((e as Error).message, true);
                      }
                    }}
                  >
                    <Star
                      size={17}
                      fill={t.starred ? 'currentColor' : 'none'}
                    />
                  </button>
                  <span className={`sender-avatar tone-${index % 5}`}>
                    {initials(
                      t.participants[0]?.name ||
                        t.participants[0]?.address ||
                        'Mail',
                    )}
                  </span>
                  <button
                    className="row-content"
                    data-thread-index={index}
                    onClick={() => open(t.id)}
                  >
                    <span className="row-sender">
                      {t.participants
                        .slice(0, 2)
                        .map((p) => p.name || p.address.split('@')[0])
                        .join(', ')}
                      {t.count > 1 && <small>{t.count}</small>}
                      <span className="mobile-subject">{t.subject}</span>
                    </span>
                    <span className="row-preview">
                      <span className="row-subject">
                        {t.subject || '(no subject)'}
                      </span>
                      {t.labels.map((l) => (
                        <span
                          className="message-label"
                          style={{ color: l.color }}
                          key={l.id}
                        >
                          {l.name}
                        </span>
                      ))}
                      {!selectedMailbox &&
                        t.mailbox_name &&
                        mailboxes.length > 1 && (
                          <span className="mailbox-tag">{t.mailbox_name}</span>
                        )}
                      <span className="row-snippet">{t.snippet}</span>
                    </span>
                    <span className="row-date">
                      {t.has_attachments ? <Paperclip size={14} /> : null}
                      {dateLabel(t.updated_at, user.timezone)}
                    </span>
                  </button>
                  <div className="row-hover-actions">
                    <button
                      className="icon-btn"
                      title="Archive"
                      onClick={async () => {
                        try {
                          await api('/mail/threads/actions', {
                            method: 'POST',
                            body: { ids: [t.id], action: 'archive' },
                          });
                          void invalidateMail();
                        } catch (e) {
                          toast((e as Error).message, true);
                        }
                      }}
                    >
                      <Archive size={17} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {list.hasNextPage && (
              <button
                className="load-more"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'A little more mail'}
                <ArrowRight size={15} />
              </button>
            )}
            <div className="inbox-end">
              <Leaf size={14} />
              <span>You’re right where you need to be.</span>
            </div>
          </>
        ) : (
          <Empty folder={folder} search={q} />
        )}
      </div>
      {snooze && (
        <Modal title="A little later is fine" onClose={() => setSnooze(false)}>
          <p className="modal-copy">
            This conversation will return to your inbox at the time you choose.
          </p>
          <Field label={`Return at (${user.timezone})`}>
            <input
              type="datetime-local"
              value={snoozeAt}
              onChange={(e) => setSnoozeAt(e.target.value)}
            />
          </Field>
          <footer>
            <button className="btn secondary" onClick={() => setSnooze(false)}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await action('snooze', {
                    until: zonedTimestamp(snoozeAt, user.timezone),
                  });
                  setSnooze(false);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Snooze
            </button>
          </footer>
        </Modal>
      )}
      {confirmDelete && (
        <Confirm
          title="Delete permanently?"
          message="These conversations and their attachments will be permanently removed. This cannot be undone."
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => action('delete')}
        />
      )}
    </section>
  );
}
function FileDraftIcon() {
  return <Mail size={17} />;
}
function Empty({ folder, search }: { folder: string; search?: string }) {
  const { user } = useSession();
  return (
    <div className="empty-state">
      <div className="empty-illustration">
        <Inbox size={40} strokeWidth={1.1} />
        <span>
          <Leaf size={17} />
        </span>
      </div>
      <span className="eyebrow">A LITTLE ROOM TO BREATHE</span>
      <h2>
        {search
          ? 'Nothing here just yet.'
          : folder === 'inbox'
            ? 'A beautifully clear inbox.'
            : folder === 'drafts'
              ? 'A blank page, whenever you’re ready.'
              : folder === 'spam'
                ? 'Nothing unwanted here.'
                : 'There’s nothing here yet.'}
      </h2>
      <p>
        {search
          ? 'Try a different search or check another mailbox.'
          : folder === 'inbox'
            ? 'New conversations will find their way here. Until then, enjoy a little quiet.'
            : 'Your conversations will appear here when you need them.'}
      </p>
      {folder === 'inbox' && user.role !== 'member' && (
        <Link className="btn secondary" to="/setup">
          Check your mail setup <ArrowRight size={15} />
        </Link>
      )}
    </div>
  );
}
