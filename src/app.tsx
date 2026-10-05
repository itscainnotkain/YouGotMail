import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Clock3,
  ContactRound,
  FilePenLine,
  Inbox,
  Layers,
  Leaf,
  LogOut,
  Mail,
  Menu,
  Moon,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Sun,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Branding,
  Draft,
  Mailbox,
  Message,
  User,
  Label,
  Participant,
} from '../shared/types';
import {
  api,
  bytes,
  clearAuth,
  initials,
  invalidateMail,
  primaryMailbox,
  queryClient,
  type AuthData,
  type Status,
} from './api';
import { AuthPage } from './auth';
import { Brand, ErrorState, Field, Modal, Spinner, useToast } from './ui';
import { InboxPage } from './inbox';
const Composer = lazy(() =>
  import('./composer').then((module) => ({ default: module.Composer })),
);
import { ContactsPage } from './contacts';
import { SettingsPage } from './settings';
import { SetupPage } from './setup';

type ComposeOptions = {
  recipient?: Participant;
  message?: Message;
  kind?: 'reply' | 'reply-all' | 'forward';
  draftId?: string;
  mailboxId?: string;
};
type Session = {
  user: User;
  branding: Branding;
  mailboxes: Mailbox[];
  selectedMailbox: string;
  compose: (options?: ComposeOptions) => Promise<void>;
};
const SessionContext = createContext<Session>(null!);
export const useSession = () => useContext(SessionContext);

export default function App() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<Status>('/setup/status'),
  });
  const auth = useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthData>('/auth/me'),
  });
  useEffect(() => {
    if (status.data) {
      document.title = status.data.branding.name;
      document.documentElement.style.setProperty(
        '--accent',
        status.data.branding.accent,
      );
      if (status.data.branding.favicon) {
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (link) link.href = status.data.branding.favicon;
      }
    }
  }, [status.data]);
  if (status.isPending) return <Spinner label="Opening your space…" />;
  if (status.error)
    return (
      <ErrorState error={status.error} retry={() => void status.refetch()} />
    );
  const protectedPage = (children: ReactNode) =>
    auth.isPending ? (
      <Spinner />
    ) : !auth.data ? (
      <Navigate to="/login" replace />
    ) : (
      <SessionShell user={auth.data.user} branding={status.data!.branding}>
        {children}
      </SessionShell>
    );
  return (
    <Routes>
      <Route
        path="/login"
        element={
          !status.data!.hasOwner ? (
            <Navigate to="/setup" replace />
          ) : auth.data ? (
            <Navigate to="/mail/inbox" replace />
          ) : (
            <AuthPage />
          )
        }
      />
      <Route path="/invite/:token" element={<AuthPage mode="invite" />} />
      <Route path="/reset" element={<AuthPage mode="reset" />} />
      <Route
        path="/setup"
        element={
          !status.data!.hasOwner ? (
            <AuthPage mode="claim" />
          ) : (
            protectedPage(<SetupPage />)
          )
        }
      />
      <Route path="/mail/:folder" element={protectedPage(<InboxPage />)} />
      <Route path="/contacts" element={protectedPage(<ContactsPage />)} />
      <Route path="/settings/*" element={protectedPage(<SettingsPage />)} />
      <Route
        path="*"
        element={
          <Navigate
            to={!status.data!.hasOwner ? '/setup' : '/mail/inbox'}
            replace
          />
        }
      />
    </Routes>
  );
}
const navItems = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'snoozed', label: 'Snoozed', icon: Clock3 },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FilePenLine },
  { id: 'scheduled', label: 'Outbox', icon: Clock3 },
  { id: 'all', label: 'All mail', icon: Layers },
  { id: 'spam', label: 'Spam', icon: ShieldAlert },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];
function SessionShell({
  user,
  branding,
  children,
}: {
  user: User;
  branding: Branding;
  children: ReactNode;
}) {
  const navigate = useNavigate(),
    location = useLocation(),
    [search, setSearch] = useSearchParams(),
    selectedMailbox = search.get('mailbox') || '',
    toast = useToast();
  const boxes = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => api<Mailbox[]>('/mail/mailboxes'),
  });
  const labels = useQuery({
    queryKey: ['labels'],
    queryFn: () => api<Label[]>('/mail/labels'),
  });
  const counts = useQuery({
    queryKey: ['counts', selectedMailbox],
    queryFn: () =>
      api<{
        folders: { folder: string; count: number; unread: number }[];
        drafts: number;
        scheduled: number;
      }>(`/mail/counts?mailbox=${selectedMailbox}`),
  });
  const [draft, setDraft] = useState<Draft | null>(null),
    [searchText, setSearchText] = useState(search.get('q') || ''),
    [mobile, setMobile] = useState(false),
    [profile, setProfile] = useState(false),
    [labelModal, setLabelModal] = useState(false),
    [help, setHelp] = useState(false),
    [labelName, setLabelName] = useState(''),
    [labelBox, setLabelBox] = useState(''),
    [theme, setTheme] = useState(localStorage.getItem('ygm-theme') || 'light'),
    [composing, setComposing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null),
    mailboxes = boxes.data || [];
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ygm-theme', theme);
  }, [theme]);
  useEffect(() => setSearchText(search.get('q') || ''), [search.get('q')]);
  useEffect(() => {
    setMobile(false);
    setProfile(false);
  }, [location.pathname, selectedMailbox]);
  useEffect(() => {
    const sockets = mailboxes.map((box) => {
      const socket = new WebSocket(
        `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/v1/mail/live/${box.id}`,
      );
      socket.onmessage = (e) => {
        if (e.data !== 'pong') void invalidateMail();
      };
      return socket;
    });
    const poll = setInterval(() => void invalidateMail(), 60_000);
    return () => {
      sockets.forEach((s) => s.close());
      clearInterval(poll);
    };
  }, [mailboxes.map((b) => b.id).join('|')]);
  useEffect(() => {
    const handler = (e: Event) => {
      void api<Draft>(`/mail/drafts/${(e as CustomEvent<string>).detail}`)
        .then(setDraft)
        .catch((err) => toast(err.message, true));
    };
    window.addEventListener('ygm:open-draft', handler);
    return () => window.removeEventListener('ygm:open-draft', handler);
  }, []);
  async function compose(options: ComposeOptions = {}) {
    if (draft) {
      toast('Finish or close your open draft first.');
      return;
    }
    setComposing(true);
    try {
      if (options.draftId) {
        setDraft(await api<Draft>(`/mail/drafts/${options.draftId}`));
        return;
      }
      const box = primaryMailbox(
        mailboxes,
        options.mailboxId || options.message?.mailbox_id || selectedMailbox,
      );
      if (!box) {
        toast(
          'Create a mailbox and address in Settings to start composing.',
          true,
        );
        return;
      }
      const address =
        box.addresses.find(
          (a) => a.email === box.primary_address && a.active,
        ) || box.addresses.find((a) => a.active)!;
      const own = new Set(box.addresses.map((a) => a.email)),
        m = options.message,
        kind = options.kind || 'reply';
      let to: Participant[] = options.recipient ? [options.recipient] : [],
        cc: Participant[] = [],
        subject = '',
        html = address.signature || '',
        text = '',
        refs: string[] = [],
        inReplyTo = '',
        threadId: string | null = null;
      if (m) {
        subject =
          kind === 'forward'
            ? /^fwd?:/i.test(m.subject)
              ? m.subject
              : `Fwd: ${m.subject}`
            : /^re:/i.test(m.subject)
              ? m.subject
              : `Re: ${m.subject}`;
        if (kind !== 'forward') {
          to = own.has(m.from_address)
            ? m.to.filter((p) => !own.has(p.address))
            : m.reply_to?.length
              ? m.reply_to
              : [{ address: m.from_address, name: m.from_name }];
          if (kind === 'reply-all') {
            to = [...to, ...m.to.filter((p) => !own.has(p.address))];
            cc = m.cc.filter((p) => !own.has(p.address));
          }
          to = [...new Map(to.map((p) => [p.address, p])).values()];
          cc = cc.filter((p) => !to.some((t) => t.address === p.address));
          refs = [
            ...m.references,
            ...(m.internet_id ? [m.internet_id] : []),
          ].slice(-100);
          inReplyTo = m.internet_id;
          threadId = m.thread_id;
        }
        const escape = (s: string) =>
          s.replace(
            /[&<>]/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!,
          );
        html = `<p></p>${address.signature}<p></p><blockquote><p>${kind === 'forward' ? 'Forwarded message' : 'On ' + new Date(m.date).toLocaleString() + ', ' + escape(m.from_name || m.from_address) + ' wrote:'}</p>${m.html || `<pre>${escape(m.text)}</pre>`}</blockquote>`;
      }
      const result = await api<Draft>('/mail/drafts', {
        method: 'POST',
        body: {
          mailbox_id: box.id,
          address_id: address.id,
          thread_id: threadId,
          to,
          cc,
          bcc: [],
          subject,
          html,
          text,
          in_reply_to: inReplyTo,
          references: refs,
        },
      });
      if (m)
        for (const attachment of m.attachments.filter(
          (a) => kind === 'forward' || a.inline,
        )) {
          const response = await fetch(
            `/api/v1/mail/attachments/${attachment.id}`,
          );
          if (!response.ok) throw new Error('Could not copy an attachment');
          const file = new File([await response.blob()], attachment.filename, {
              type: attachment.content_type,
            }),
            inline =
              !!attachment.inline &&
              ['image/png', 'image/jpeg', 'image/webp'].includes(
                attachment.content_type,
              );
          const uploaded = await api<Draft['attachments'][number]>(
            `/mail/drafts/${result.id}/attachments?filename=${encodeURIComponent(attachment.filename)}${inline ? '&inline=1' : ''}`,
            { method: 'POST', file },
          );
          result.attachments.push(uploaded);
          if (inline && attachment.cid)
            result.html = result.html.replaceAll(
              `cid:${attachment.cid}`,
              `cid:${uploaded.cid}`,
            );
        }
      if (result.html !== html) {
        const saved = await api<{ revision: number }>(
          `/mail/drafts/${result.id}`,
          { method: 'PATCH', body: { ...result, revision: result.revision } },
        );
        result.revision = saved.revision;
      }
      setDraft(result);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setComposing(false);
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
      if (e.key === 'c') {
        e.preventDefault();
        void compose();
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === '?') {
        setHelp(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  const activeFolder = location.pathname.split('/')[2],
    box = mailboxes.find((b) => b.id === selectedMailbox),
    used = box?.used_bytes || mailboxes.reduce((s, b) => s + b.used_bytes, 0),
    quota =
      box?.quota_bytes || mailboxes.reduce((s, b) => s + b.quota_bytes, 0);
  function routeFolder(folder: string, mailbox = selectedMailbox) {
    navigate(`/mail/${folder}${mailbox ? `?mailbox=${mailbox}` : ''}`);
  }
  return (
    <SessionContext.Provider
      value={{ user, branding, mailboxes, selectedMailbox, compose }}
    >
      <div className="app-shell">
        {mobile && (
          <div className="sidebar-scrim" onClick={() => setMobile(false)} />
        )}
        <aside className={`sidebar ${mobile ? 'open' : ''}`}>
          <Link to="/mail/inbox" className="brand-link">
            <Brand branding={branding} />
          </Link>
          <button
            className="compose-btn"
            onClick={() => void compose()}
            disabled={composing}
          >
            <Plus size={21} />
            <span>{composing ? 'Opening…' : 'Compose'}</span>
            <kbd>C</kbd>
          </button>
          <nav className="mail-nav" aria-label="Mail folders">
            {navItems.map((item) => {
              const Icon = item.icon,
                count =
                  item.id === 'drafts'
                    ? counts.data?.drafts
                    : item.id === 'scheduled'
                      ? counts.data?.scheduled
                      : item.id === 'inbox'
                        ? counts.data?.folders.find((f) => f.folder === 'inbox')
                            ?.unread
                        : undefined;
              return (
                <button
                  key={item.id}
                  className={`nav-item ${activeFolder === item.id && !search.get('label') ? 'active' : ''}`}
                  onClick={() => routeFolder(item.id)}
                >
                  <Icon size={18} strokeWidth={1.7} />
                  <span>{item.label}</span>
                  {!!count && <span className="nav-count">{count}</span>}
                </button>
              );
            })}
          </nav>
          <div className="sidebar-section">
            <div className="section-label">YOUR MAILBOXES</div>
            <button
              className={`mailbox-item ${!selectedMailbox ? 'selected' : ''}`}
              onClick={() => routeFolder('inbox', '')}
            >
              <span className="mailbox-symbol unified">
                <Layers size={14} />
              </span>
              <span>Unified inbox</span>
              <span className="mailbox-qty">{mailboxes.length}</span>
            </button>
            {mailboxes.map((b, i) => (
              <button
                className={`mailbox-item ${selectedMailbox === b.id ? 'selected' : ''}`}
                key={b.id}
                onClick={() => routeFolder('inbox', b.id)}
              >
                <span className={`mailbox-symbol tone-${i % 4}`}>
                  {initials(b.name).slice(0, 1)}
                </span>
                <span>
                  <strong>{b.name}</strong>
                  <small>{b.primary_address}</small>
                </span>
                {b.kind === 'shared' && (
                  <span className="shared-dot" title="Shared mailbox" />
                )}
              </button>
            ))}
          </div>
          <div className="sidebar-section labels-section">
            <div className="section-label">
              LABELS
              <button
                className="icon-btn small"
                title="Create label"
                onClick={() => {
                  setLabelBox(
                    selectedMailbox || primaryMailbox(mailboxes, '')?.id || '',
                  );
                  setLabelModal(true);
                }}
              >
                <Plus size={15} />
              </button>
            </div>
            {(labels.data || [])
              .filter(
                (l) => !selectedMailbox || l.mailbox_id === selectedMailbox,
              )
              .map((l) => (
                <button
                  className={`label-nav ${search.get('label') === l.id ? 'active' : ''}`}
                  key={l.id}
                  onClick={() =>
                    navigate(`/mail/all?mailbox=${l.mailbox_id}&label=${l.id}`)
                  }
                >
                  <span style={{ background: l.color }} />
                  {l.name}
                </button>
              ))}
            {!labels.data?.length && (
              <small className="label-empty">
                A little organisation goes a long way.
              </small>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className={`nav-item ${location.pathname === '/contacts' ? 'active' : ''}`}
              onClick={() => navigate('/contacts')}
            >
              <ContactRound size={18} />
              <span>Contacts</span>
            </button>
            <button
              className={`nav-item ${location.pathname.startsWith('/settings') ? 'active' : ''}`}
              onClick={() => navigate('/settings')}
            >
              <Settings2 size={18} />
              <span>Settings</span>
            </button>
            <div className="storage-caption">
              <span>
                <Leaf size={13} /> Your space
              </span>
              <small>
                {bytes(used)} of {bytes(quota)}
              </small>
            </div>
            <div className="storage-meter">
              <i
                style={{
                  width: `${quota ? Math.min(100, (used / quota) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        </aside>
        <div className="app-workspace">
          <header className="app-header">
            <button
              className="icon-btn mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <form
              className="search-form"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(
                  `/mail/all?${new URLSearchParams({ ...(selectedMailbox ? { mailbox: selectedMailbox } : {}), q: searchText })}`,
                );
              }}
            >
              <Search size={19} />
              <input
                ref={searchRef}
                aria-label="Search mail"
                placeholder="Search your mail"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
              {searchText ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearchText('');
                    setSearch((p) => {
                      p.delete('q');
                      return p;
                    });
                  }}
                >
                  <X size={16} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </form>
            <div className="header-actions">
              <button
                className="icon-btn"
                aria-label="Keyboard shortcuts"
                onClick={() => setHelp(true)}
              >
                <CircleHelp size={20} />
              </button>
              <button
                className="icon-btn"
                aria-label={
                  theme === 'light' ? 'Use dark theme' : 'Use light theme'
                }
                onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? <Moon size={19} /> : <Sun size={19} />}
              </button>
              <div className="profile-wrap">
                <button
                  className="profile-avatar"
                  aria-label="Account menu"
                  onClick={() => setProfile(!profile)}
                >
                  {initials(user.name)}
                </button>
                {profile && (
                  <div className="profile-menu">
                    <strong>{user.name}</strong>
                    <small>{user.username}</small>
                    <span className="role-caption">{user.role}</span>
                    <button onClick={() => navigate('/settings')}>
                      <Settings2 size={15} /> Account settings
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await api('/auth/logout', {
                            method: 'POST',
                            body: {},
                          });
                          clearAuth();
                          navigate('/login');
                        } catch (e) {
                          toast((e as Error).message, true);
                        }
                      }}
                    >
                      <LogOut size={15} /> Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>
          {!branding.setup_complete &&
            location.pathname !== '/setup' &&
            user.role !== 'member' && (
              <div className="setup-reminder">
                <span>
                  <Mail size={16} /> Your space is ready for its finishing
                  touches.
                </span>
                <Link to="/setup">
                  Finish setup <ArrowUpRight size={14} />
                </Link>
              </div>
            )}
          <main className="main-content">
            {boxes.error ? (
              <ErrorState
                error={boxes.error}
                retry={() => void boxes.refetch()}
              />
            ) : (
              children
            )}
          </main>
          <div className="workspace-footer">
            <span>Less noise. More room.</span>
            <span>
              <span className="connection-dot" /> Your own little corner of the
              internet
            </span>
          </div>
        </div>
        {draft && (
          <Suspense fallback={<Spinner label="Opening your draft…" />}>
            <Composer
              key={draft.id}
              draft={draft}
              onClose={() => {
                setDraft(null);
                void invalidateMail();
              }}
              onSent={(job) => {
                setDraft(null);
                void invalidateMail();
                toast('Your message is queued.', false, {
                  label: 'Undo',
                  run: async () => {
                    try {
                      const result = await api<{ draftId: string }>(
                        `/mail/jobs/${job.id}/cancel`,
                        { method: 'POST', body: {} },
                      );
                      void invalidateMail();
                      setDraft(
                        await api<Draft>(`/mail/drafts/${result.draftId}`),
                      );
                      toast('Send cancelled. Your draft is back.');
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  },
                });
              }}
            />
          </Suspense>
        )}
        {labelModal && (
          <Modal
            title="A place for the good stuff"
            onClose={() => setLabelModal(false)}
          >
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api('/mail/labels', {
                    method: 'POST',
                    body: {
                      mailboxId: labelBox,
                      name: labelName,
                      color: '#b78d5a',
                    },
                  });
                  await queryClient.invalidateQueries({ queryKey: ['labels'] });
                  setLabelModal(false);
                  setLabelName('');
                  toast('Label created.');
                } catch (err) {
                  toast((err as Error).message, true);
                }
              }}
            >
              <Field label="Mailbox">
                <select
                  required
                  value={labelBox}
                  onChange={(e) => setLabelBox(e.target.value)}
                >
                  {mailboxes.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Label name">
                <input
                  required
                  autoFocus
                  value={labelName}
                  onChange={(e) => setLabelName(e.target.value)}
                  maxLength={100}
                />
              </Field>
              <footer>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setLabelModal(false)}
                >
                  Cancel
                </button>
                <button className="btn">Create label</button>
              </footer>
            </form>
          </Modal>
        )}
        {help && (
          <Modal title="A few handy shortcuts" onClose={() => setHelp(false)}>
            <div className="shortcut-list">
              {[
                ['C', 'Compose a message'],
                ['/', 'Search your mail'],
                ['E', 'Archive selected conversations'],
                ['#', 'Move selection to Trash'],
                ['R', 'Reply to the open conversation'],
                ['J / K', 'Move through the inbox'],
                ['?', 'Open this guide'],
              ].map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
            <p className="modal-copy subtle">
              Search supports from:, to:, subject:, label:, is:unread,
              has:attachment, before:, and after:.
            </p>
          </Modal>
        )}
      </div>
    </SessionContext.Provider>
  );
}
