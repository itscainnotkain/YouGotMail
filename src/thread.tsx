import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Download,
  Eye,
  Forward,
  Mail,
  MoreHorizontal,
  Reply,
  ReplyAll,
  ChevronDown,
  ChevronUp,
  Paperclip,
} from 'lucide-react';
import type { Message, Thread } from '../shared/types';
import { api, bytes, fullDate, initials, invalidateMail } from './api';
import { useSession } from './app';
import { ErrorState, Spinner, StatusPill, useToast } from './ui';

export function ThreadView({ threadId }: { threadId: string }) {
  const { user, compose } = useSession(),
    toast = useToast();
  const query = useInfiniteQuery({
    queryKey: ['thread', threadId],
    queryFn: ({ pageParam }) =>
      api<{ thread: Thread; messages: Message[]; cursor: string | null }>(
        `/mail/threads/${threadId}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '' as string,
    getNextPageParam: (p) => p.cursor || undefined,
  });
  useEffect(() => {
    api('/mail/threads/actions', {
      method: 'POST',
      body: { ids: [threadId], action: 'read' },
    })
      .then(() => invalidateMail())
      .catch(() => {});
  }, [threadId]);
  const messages =
      query.data?.pages
        .slice()
        .reverse()
        .flatMap((p) => p.messages) || [],
    thread = query.data?.pages[0].thread;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === 'r' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !(e.target as HTMLElement).closest(
          'input,textarea,[contenteditable="true"]',
        ) &&
        messages.length
      ) {
        e.preventDefault();
        void compose({ message: messages.at(-1), kind: 'reply' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [messages, compose]);
  if (query.isPending) return <Spinner label="Opening the conversation…" />;
  if (query.error)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    );
  return (
    <div className="conversation">
      <header className="conversation-heading">
        <h2>{thread?.subject || '(no subject)'}</h2>
        <div>
          {thread?.labels.map((l) => (
            <span
              className="message-label"
              key={l.id}
              style={{ color: l.color }}
            >
              {l.name}
            </span>
          ))}
          {thread?.snoozed_until && (
            <small>
              Snoozed until {fullDate(thread.snoozed_until, user.timezone)}
            </small>
          )}
        </div>
      </header>
      {query.hasNextPage && (
        <button
          className="load-more"
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Show earlier messages'}
        </button>
      )}
      {messages.map((message, index) => (
        <MessageCard
          key={message.id}
          message={message}
          last={index === messages.length - 1}
        />
      ))}
      <footer className="conversation-reply">
        <button
          className="btn secondary"
          onClick={() =>
            void compose({ message: messages.at(-1), kind: 'reply' })
          }
        >
          <Reply size={17} />
          Reply
        </button>
        <button
          className="btn secondary"
          onClick={() =>
            void compose({ message: messages.at(-1), kind: 'reply-all' })
          }
        >
          <ReplyAll size={17} />
          Reply all
        </button>
        <button
          className="btn secondary"
          onClick={() =>
            void compose({ message: messages.at(-1), kind: 'forward' })
          }
        >
          <Forward size={17} />
          Forward
        </button>
      </footer>
    </div>
  );
}
function MessageCard({ message, last }: { message: Message; last: boolean }) {
  const { user, compose } = useSession();
  const [open, setOpen] = useState(last),
    [details, setDetails] = useState(false),
    [remote, setRemote] = useState(false);
  useEffect(() => {
    if (last) setOpen(true);
  }, [last]);
  const remoteImages = /<img[^>]+src=["']https?:/i.test(message.html);
  return (
    <article className={`message-card ${open ? 'expanded' : ''}`}>
      <header>
        <span className="sender-avatar">
          {initials(message.from_name || message.from_address)}
        </span>
        <button className="message-sender" onClick={() => setOpen(!open)}>
          <strong>
            {message.from_name || message.from_address}
            <small>&lt;{message.from_address}&gt;</small>
          </strong>
          <span>
            {open
              ? `to ${message.to.map((p) => p.name || p.address).join(', ')}`
              : message.text.slice(0, 140)}
          </span>
        </button>
        <div className="message-actions">
          <time>{fullDate(message.date, user.timezone)}</time>
          <button
            className="icon-btn"
            title="Message details"
            onClick={() => {
              setDetails(!details);
              setOpen(true);
            }}
          >
            {details ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
          </button>
          <button
            className="icon-btn"
            title="Reply"
            onClick={() => void compose({ message, kind: 'reply' })}
          >
            <Reply size={18} />
          </button>
        </div>
      </header>
      {open && (
        <div className="message-content">
          {details && (
            <div className="message-details">
              <div>
                <span>From</span>
                {message.from_name} &lt;{message.from_address}&gt;
              </div>
              <div>
                <span>To</span>
                {message.to.map((p) => p.address).join(', ')}
              </div>
              {message.cc.length > 0 && (
                <div>
                  <span>CC</span>
                  {message.cc.map((p) => p.address).join(', ')}
                </div>
              )}
              {message.direction === 'outgoing' && message.bcc.length > 0 && (
                <div>
                  <span>BCC</span>
                  {message.bcc.map((p) => p.address).join(', ')}
                </div>
              )}
              <div>
                <span>Date</span>
                {fullDate(message.date, user.timezone)} · {user.timezone}
              </div>
              <div>
                <span>Message ID</span>
                {message.internet_id || 'Not supplied'}
              </div>
              <a href={`/api/v1/mail/messages/${message.id}/source`}>
                <Download size={14} /> Download original email
              </a>
            </div>
          )}
          {message.parse_error && (
            <div className="inline-error">{message.parse_error}</div>
          )}
          {remoteImages && !remote && (
            <div className="remote-images">
              <Eye size={15} />
              <span>External images are hidden for your privacy.</span>
              <button onClick={() => setRemote(true)}>Show images</button>
            </div>
          )}
          {message.html ? (
            <iframe
              className="email-frame"
              title={`Message from ${message.from_name || message.from_address}`}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              src={`/api/v1/mail/messages/${message.id}/render${remote ? '?images=1' : ''}`}
              style={{
                height: Math.max(
                  150,
                  Math.min(600, message.text.split('\n').length * 22 + 50),
                ),
              }}
            />
          ) : (
            <div className="plain-message">{message.text}</div>
          )}
          {message.attachments.filter((a) => !a.inline).length > 0 && (
            <div className="attachments-grid">
              {message.attachments
                .filter((a) => !a.inline)
                .map((a) => (
                  <a
                    className="attachment-card"
                    key={a.id}
                    href={`/api/v1/mail/attachments/${a.id}`}
                  >
                    <span>
                      <Paperclip size={20} />
                    </span>
                    <div>
                      <strong>{a.filename}</strong>
                      <small>{bytes(a.size)}</small>
                    </div>
                    <Download size={15} />
                  </a>
                ))}
            </div>
          )}
          {message.delivery_status && (
            <div className="delivery-line">
              <StatusPill status={message.delivery_status} />
              {message.deliveries
                ?.filter((d) => !['accepted', 'delivered'].includes(d.status))
                .map((d) => (
                  <small key={d.recipient}>
                    {d.recipient}: {d.status} {d.detail}
                  </small>
                ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
