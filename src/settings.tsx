import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Globe2,
  KeyRound,
  Layers,
  Mail,
  Paintbrush,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  Address,
  Branding,
  Domain,
  Filter,
  Label,
  Mailbox,
  User,
} from '../shared/types';
import {
  api,
  bytes,
  fullDate,
  initials,
  invalidateMail,
  localDateTime,
  queryClient,
  zonedTimestamp,
  type AuthData,
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

export type Progress = {
  domains: Domain[];
  integrations: string[];
  connection: { accountId: string; workerName: string; queueId: string } | null;
  branding: Branding;
  mailboxes: { id: string; name: string; primary_address: string }[];
};
export function useProgress() {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<Progress>('/setup/progress'),
  });
}
export async function refreshSettings() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['setup'] }),
    queryClient.invalidateQueries({ queryKey: ['status'] }),
    queryClient.invalidateQueries({ queryKey: ['admin-mailboxes'] }),
    queryClient.invalidateQueries({ queryKey: ['labels'] }),
    queryClient.invalidateQueries({ queryKey: ['users'] }),
    invalidateMail(),
  ]);
}
function Card({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="settings-card">
      <header className="settings-card-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}
function useTask() {
  const [busy, setBusy] = useState(false),
    toast = useToast();
  async function run<T>(
    fn: () => Promise<T>,
    message?: string,
  ): Promise<T | undefined> {
    setBusy(true);
    try {
      const result = await fn();
      if (message) toast(message);
      return result;
    } catch (e) {
      toast((e as Error).message, true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}
const sections = [
  { id: 'account', name: 'My account', icon: ShieldCheck },
  { id: 'addresses', name: 'Addresses & signatures', icon: Mail },
  { id: 'automation', name: 'Filters & away replies', icon: SlidersHorizontal },
  { id: 'branding', name: 'Your brand', icon: Paintbrush, admin: true },
  { id: 'integrations', name: 'Connections', icon: Cloud, admin: true },
  { id: 'domains', name: 'Domains', icon: Globe2, admin: true },
  { id: 'mailboxes', name: 'Mailboxes', icon: Layers, admin: true },
  { id: 'users', name: 'People & invitations', icon: Users, admin: true },
  { id: 'health', name: 'Health & activity', icon: Activity, admin: true },
];
export function SettingsPage() {
  const { user } = useSession(),
    [section, setSection] = useState('account');
  return (
    <section className="settings-page">
      <div className="page-heading">
        <div>
          <div className="heading-eyebrow">MAKE ROOM FOR YOURSELF</div>
          <h1>
            Your space<span className="heading-dot">.</span>
          </h1>
          <p>A few thoughtful touches. Just the way you like it.</p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav">
          {sections
            .filter((s) => !s.admin || user.role !== 'member')
            .map((s) => (
              <button
                key={s.id}
                className={section === s.id ? 'active' : ''}
                onClick={() => setSection(s.id)}
              >
                <s.icon size={17} />
                {s.name}
              </button>
            ))}
        </nav>
        <div className="settings-panels">
          {section === 'account' ? (
            <AccountSettings />
          ) : section === 'addresses' ? (
            <AddressSettings />
          ) : section === 'automation' ? (
            <AutomationSettings />
          ) : section === 'branding' ? (
            <BrandingSettings />
          ) : section === 'integrations' ? (
            <IntegrationSettings />
          ) : section === 'domains' ? (
            <DomainSettings />
          ) : section === 'mailboxes' ? (
            <MailboxSettings />
          ) : section === 'users' ? (
            <PeopleSettings />
          ) : (
            <HealthSettings />
          )}
        </div>
      </div>
    </section>
  );
}

function AccountSettings() {
  const { user } = useSession(),
    { busy, run } = useTask(),
    [name, setName] = useState(user.name),
    [recovery, setRecovery] = useState(user.recovery_email),
    [timezone, setTimezone] = useState(user.timezone),
    [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [twoFactor, setTwoFactor] = useState(false),
    [secret, setSecret] = useState(''),
    [uri, setUri] = useState(''),
    [codes, setCodes] = useState<string[]>([]),
    [confirmDisable, setConfirmDisable] = useState(false);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () =>
      api<
        {
          id: string;
          current: boolean;
          created_at: number;
          expires_at: number;
        }[]
      >('/auth/sessions'),
  });
  return (
    <>
      <Card
        title="A little about you"
        description="Your login is separate from your email addresses."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/profile', {
                method: 'PATCH',
                body: {
                  name,
                  recovery_email: recovery,
                  timezone,
                  password: current || undefined,
                  code: code || undefined,
                },
              });
              await queryClient.invalidateQueries({ queryKey: ['auth'] });
            }, 'Profile saved.');
          }}
        >
          <div className="form-grid">
            <Field label="Your name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Username">
              <input value={user.username} disabled />
            </Field>
            <Field label="Recovery email">
              <input
                required
                type="email"
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
              />
            </Field>
            <Field label="Timezone">
              <input
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                list="timezones"
              />
              <datalist id="timezones">
                {Intl.supportedValuesOf('timeZone').map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </Field>
          </div>
          {recovery !== user.recovery_email && (
            <div className="form-grid">
              <Field label="Current password">
                <input
                  required
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
              {user.two_factor && (
                <Field label="Authenticator code">
                  <input
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}
          <button className="btn" disabled={busy}>
            Save profile
          </button>
        </form>
      </Card>
      <Card
        title="Keep your space safe"
        description="A good password and an extra layer of protection."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/password', {
                method: 'POST',
                body: { current, password, code: code || undefined },
              });
              setCurrent('');
              setPassword('');
              setCode('');
            }, 'Password changed. Other sessions have been signed out.');
          }}
        >
          <div className="form-grid">
            <Field label="Current password">
              <input
                required
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="New password">
              <input
                required
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {user.two_factor && (
              <Field label="Authenticator or recovery code">
                <input
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
            )}
          </div>
          <button className="btn secondary" disabled={busy}>
            Change password
          </button>
        </form>
        <div className="settings-rule" />
        <div className="setting-line">
          <div>
            <strong>Two-factor authentication</strong>
            <p>
              {user.two_factor
                ? 'Your authenticator adds an extra layer of protection.'
                : 'Use an authenticator app to protect your account.'}
            </p>
          </div>
          <button
            className="btn secondary"
            onClick={() => {
              setCurrent('');
              setCode('');
              user.two_factor ? setConfirmDisable(true) : setTwoFactor(true);
            }}
          >
            {user.two_factor ? 'Disable' : 'Set up'}
          </button>
        </div>
      </Card>
      <Card
        title="Your signed-in devices"
        description="Revoke any session you no longer need."
      >
        {sessions.data?.map((s) => (
          <div className="setting-line" key={s.id}>
            <div>
              <strong>{s.current ? 'This session' : 'Another session'}</strong>
              <p>Signed in {fullDate(s.created_at, user.timezone)}</p>
            </div>
            {!s.current && (
              <button
                className="text-btn danger-text"
                onClick={() =>
                  void run(async () => {
                    await api(`/auth/sessions/${encodeURIComponent(s.id)}`, {
                      method: 'DELETE',
                      body: {},
                    });
                    await sessions.refetch();
                  }, 'Session revoked.')
                }
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </Card>
      {twoFactor && (
        <Modal
          title="An extra layer of calm"
          onClose={() => {
            setTwoFactor(false);
            setSecret('');
            setCodes([]);
          }}
        >
          {codes.length ? (
            <>
              <p className="modal-copy">
                Save these recovery codes somewhere safe. Each works once if you
                lose access to your authenticator.
              </p>
              <div className="recovery-codes">
                {codes.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </div>
              <footer>
                <button
                  className="btn"
                  onClick={() => {
                    setTwoFactor(false);
                    setCodes([]);
                  }}
                >
                  I saved my codes
                </button>
              </footer>
            </>
          ) : secret ? (
            <>
              <p className="modal-copy">
                Add this setup key to your authenticator app, then enter its
                six-digit code.
              </p>
              <div className="secret-display">{secret}</div>
              <a className="text-btn" href={uri}>
                Open authenticator app
              </a>
              <Field label="Authenticator code">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                />
              </Field>
              <footer>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ codes: string[] }>(
                        '/auth/2fa/confirm',
                        { method: 'POST', body: { code } },
                      );
                      setCodes(r.codes);
                      await queryClient.invalidateQueries({
                        queryKey: ['auth'],
                      });
                    })
                  }
                >
                  Verify and enable
                </button>
              </footer>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await api<{ secret: string; uri: string }>(
                    '/auth/2fa/start',
                    { method: 'POST', body: { password: current } },
                  );
                  setSecret(r.secret);
                  setUri(r.uri);
                });
              }}
            >
              <Field label="Confirm your password">
                <input
                  required
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
              <footer>
                <button className="btn" disabled={busy}>
                  Continue
                </button>
              </footer>
            </form>
          )}
        </Modal>
      )}
      {confirmDisable && (
        <Modal
          title="Disable two-factor authentication"
          onClose={() => setConfirmDisable(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/auth/2fa/disable', {
                  method: 'POST',
                  body: { password: current, code },
                });
                await queryClient.invalidateQueries({ queryKey: ['auth'] });
                setConfirmDisable(false);
              }, 'Two-factor authentication disabled.');
            }}
          >
            <Field label="Password">
              <input
                required
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="Authenticator or recovery code">
              <input
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <footer>
              <button className="btn danger" disabled={busy}>
                Disable two-factor
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}

export function BrandingSettings() {
  const progress = useProgress(),
    { branding } = useSession();
  const data = progress.data?.branding || branding;
  return (
    <Card
      title="Make it feel like you"
      description="One consistent identity across your app, login page, and mailboxes."
    >
      <BrandingForm key={JSON.stringify(data)} branding={data} />
      <HostnameForm />
    </Card>
  );
}
function BrandingForm({ branding }: { branding: Branding }) {
  const [value, setValue] = useState(branding),
    { busy, run } = useTask();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api('/setup/branding', { method: 'PATCH', body: value });
          await refreshSettings();
        }, 'Your brand has been saved.');
      }}
    >
      <div className="brand-preview" style={{ borderColor: value.accent }}>
        <span style={{ background: value.accent }}>
          {value.logo ? (
            <img src={value.logo} alt="Logo preview" />
          ) : (
            <Mail size={23} />
          )}
        </span>
        <strong>
          {value.name}
          <i style={{ color: value.accent }}>.</i>
        </strong>
        <small>Your own little corner.</small>
      </div>
      <div className="form-grid">
        <Field label="App name">
          <input
            required
            value={value.name}
            maxLength={100}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </Field>
        <Field label="Accent colour">
          <div className="color-field">
            <input
              type="color"
              value={value.accent}
              onChange={(e) => setValue({ ...value, accent: e.target.value })}
            />
            <input
              required
              pattern="#[0-9a-fA-F]{6}"
              value={value.accent}
              onChange={(e) => setValue({ ...value, accent: e.target.value })}
            />
          </div>
        </Field>
        <Field label="Logo" hint="PNG, JPEG, or WebP, up to 2 MB.">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void run(async () => {
                  const r = await api<{ url: string }>('/branding', {
                    method: 'POST',
                    file,
                  });
                  setValue((v) => ({ ...v, logo: r.url }));
                });
            }}
          />
          {value.logo && (
            <button
              type="button"
              className="text-btn"
              onClick={() => setValue({ ...value, logo: '' })}
            >
              Remove logo
            </button>
          )}
        </Field>
        <Field label="Browser icon" hint="PNG or ICO, up to 2 MB.">
          <input
            type="file"
            accept="image/png,image/x-icon"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void run(async () => {
                  const r = await api<{ url: string }>('/branding', {
                    method: 'POST',
                    file,
                  });
                  setValue((v) => ({ ...v, favicon: r.url }));
                });
            }}
          />
        </Field>
      </div>
      <Field label="Login welcome text">
        <input
          value={value.login_text}
          maxLength={250}
          onChange={(e) => setValue({ ...value, login_text: e.target.value })}
        />
      </Field>
      <Field
        label="App address"
        hint="The HTTPS address used for invitations and password recovery. Leave blank to use the current address."
      >
        <input
          type="url"
          placeholder="https://mail.example.com"
          value={value.app_url}
          onChange={(e) => setValue({ ...value, app_url: e.target.value })}
        />
      </Field>
      <button className="btn" disabled={busy}>
        Save branding
      </button>
    </form>
  );
}
function HostnameForm() {
  const progress = useProgress(),
    { busy, run } = useTask(),
    [hostname, setHostname] = useState(''),
    [zone, setZone] = useState('');
  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: () => api<{ id: string; name: string }[]>('/setup/zones'),
    enabled: !!progress.data?.connection,
  });
  if (!progress.data?.connection) return null;
  return (
    <>
      <div className="settings-rule" />
      <h3>A home on your own domain</h3>
      <p className="subtle">
        Connect a hostname such as mail.example.com to this app.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ url: string }>('/setup/hostname', {
              method: 'POST',
              body: { hostname, zoneId: zone },
            });
            await refreshSettings();
            return r;
          }, 'Your hostname is connected. Allow a little time for its certificate to become ready.');
        }}
      >
        <div className="form-grid">
          <Field label="Domain">
            <select
              required
              value={zone}
              onChange={(e) => setZone(e.target.value)}
            >
              <option value="">Choose a domain</option>
              {zones.data?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="App hostname">
            <input
              required
              placeholder="mail.example.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </Field>
        </div>
        <button className="btn secondary" disabled={busy}>
          Connect hostname
        </button>
      </form>
    </>
  );
}

export function IntegrationSettings() {
  const progress = useProgress(),
    { busy, run } = useTask(),
    [cfToken, setCfToken] = useState(''),
    [account, setAccount] = useState(
      progress.data?.connection?.accountId || '',
    ),
    [worker, setWorker] = useState(
      window.location.hostname.endsWith('.workers.dev')
        ? window.location.hostname.split('.')[0]
        : 'yougotmail',
    ),
    [resendToken, setResendToken] = useState(''),
    [webhook, setWebhook] = useState(''),
    [warning, setWarning] = useState('');
  return (
    <>
      <Card
        title="Connect Cloudflare"
        description="A scoped token lets your setup configure selected domains, routing, and DNS."
      >
        <div className="connection-note">
          <Cloud size={20} />
          <span>
            {progress.data?.integrations.includes('cloudflare')
              ? 'Connected. Enter a new token only when you want to replace it.'
              : 'Your mail stays in your own Cloudflare account.'}
          </span>
        </div>
        <p className="subtle">
          Token permissions: Zone Read, DNS Edit, Email Routing Rules Edit, Zone
          Settings Edit, Email Sending Edit, Workers Scripts Edit, and Queues
          Edit. Restrict it to this account and the zones you want to manage.{' '}
          <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
          >
            Create a token ↗
          </a>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/setup/cloudflare', {
                method: 'POST',
                body: {
                  token: cfToken,
                  accountId: account,
                  workerName: worker,
                },
              });
              setCfToken('');
              await refreshSettings();
              await queryClient.invalidateQueries({ queryKey: ['zones'] });
            }, 'Cloudflare connected.');
          }}
        >
          <Field label="Cloudflare API token">
            <input
              required
              type="password"
              autoComplete="off"
              value={cfToken}
              onChange={(e) => setCfToken(e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field label="Account ID">
              <input
                required
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                pattern="[a-fA-F0-9]{32}"
                placeholder="From your Cloudflare account dashboard"
              />
            </Field>
            <Field label="Deployed Worker name">
              <input
                required
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
                pattern="[a-z0-9-]{1,63}"
              />
            </Field>
          </div>
          <button className="btn" disabled={busy}>
            {busy
              ? 'Connecting…'
              : progress.data?.integrations.includes('cloudflare')
                ? 'Replace connection'
                : 'Connect Cloudflare'}
          </button>
        </form>
      </Card>
      <Card
        title="Resend, when it suits you"
        description="Choose Resend as the sending provider for any of your domains."
      >
        <div className="setting-line">
          <span>Resend connection</span>
          {progress.data?.integrations.includes('resend') && (
            <StatusPill status="ready" />
          )}
        </div>
        <p className="subtle">
          Use a full-access Resend API key to allow domain and webhook setup.{' '}
          <a
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            Create a key ↗
          </a>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const result = await api<{ warning: string }>('/setup/resend', {
                method: 'POST',
                body: { token: resendToken },
              });
              setWarning(result.warning);
              setResendToken('');
              await refreshSettings();
            }, 'Resend connected.');
          }}
        >
          <Field label="Resend API key">
            <input
              required
              type="password"
              autoComplete="off"
              value={resendToken}
              onChange={(e) => setResendToken(e.target.value)}
            />
          </Field>
          {warning && <div className="inline-error">{warning}</div>}
          <button className="btn secondary" disabled={busy}>
            Connect Resend
          </button>
        </form>
        {progress.data?.integrations.includes('resend') && (
          <details className="advanced-settings">
            <summary>Manual webhook verification</summary>
            <p className="subtle">
              If automatic webhook setup failed, create a webhook at Resend
              pointing to {window.location.origin}/api/v1/webhooks/resend and
              save its signing secret here.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api('/setup/resend-webhook', {
                    method: 'POST',
                    body: { secret: webhook },
                  });
                  setWebhook('');
                }, 'Webhook verification saved.');
              }}
            >
              <Field label="Signing secret">
                <input
                  type="password"
                  required
                  value={webhook}
                  onChange={(e) => setWebhook(e.target.value)}
                  placeholder="whsec_…"
                />
              </Field>
              <button className="btn secondary" disabled={busy}>
                Save signing secret
              </button>
            </form>
          </details>
        )}
      </Card>
    </>
  );
}

type Preview = {
  snapshot: string;
  existing: { type: string; name: string; content: string }[];
  required: { type: string; name: string; content: string }[];
  sendingRecords: { type: string; name: string; content: string }[];
  mxConflicts: { content: string }[];
  routingConflict: boolean;
  enabledRules: { name: string }[];
  warning: string;
  needsMigration: boolean;
};
export function DomainSettings() {
  const progress = useProgress(),
    { busy, run } = useTask(),
    toast = useToast(),
    [adding, setAdding] = useState(false),
    [zone, setZone] = useState(''),
    [provider, setProvider] = useState<'cloudflare' | 'resend'>('cloudflare'),
    [preview, setPreview] = useState<{ domain: Domain; data: Preview } | null>(
      null,
    ),
    [migration, setMigration] = useState(false),
    [switching, setSwitching] = useState<{
      domain: Domain;
      provider: string;
    } | null>(null);
  const zones = useQuery({
    queryKey: ['zones'],
    queryFn: () => api<{ id: string; name: string }[]>('/setup/zones'),
    enabled: !!progress.data?.connection,
  });
  return (
    <Card
      title="Every domain, one home"
      description="Receive through Cloudflare. Choose how each domain sends."
      action={
        <button
          className="btn secondary small"
          disabled={!progress.data?.connection}
          onClick={() => setAdding(true)}
        >
          <Plus size={16} />
          Add domain
        </button>
      }
    >
      {!progress.data?.connection && (
        <div className="inline-note">
          Connect Cloudflare first, then select your active domains.
        </div>
      )}
      {progress.isPending ? (
        <Spinner />
      ) : progress.error ? (
        <ErrorState error={progress.error} />
      ) : progress.data?.domains.length ? (
        progress.data.domains.map((d) => (
          <div className="domain-card" key={d.id}>
            <div className="domain-title">
              <span className="domain-icon">
                <Globe2 size={21} />
              </span>
              <div>
                <strong>{d.name}</strong>
                <small>
                  {d.last_checked
                    ? `Checked ${new Date(d.last_checked).toLocaleTimeString()}`
                    : 'Ready for configuration'}
                </small>
              </div>
              <button
                className="icon-btn"
                title={`Check ${d.name}`}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/setup/domains/${d.id}/check`, {
                      method: 'POST',
                      body: {},
                    });
                    await refreshSettings();
                  }, 'Domain checked.')
                }
              >
                <RefreshCw size={16} />
              </button>
            </div>
            <div className="domain-statuses">
              <div>
                <span>Receiving</span>
                <StatusPill status={d.receiving_status} />
              </div>
              <div>
                <span>Sending</span>
                <StatusPill status={d.sending_status} />
              </div>
              <div>
                <span>Provider</span>
                <select
                  aria-label={`Sending provider for ${d.name}`}
                  value={d.provider}
                  onChange={(e) =>
                    setSwitching({ domain: d, provider: e.target.value })
                  }
                >
                  <option value="cloudflare">Cloudflare</option>
                  <option value="resend">Resend</option>
                </select>
              </div>
            </div>
            {d.last_error && <div className="inline-error">{d.last_error}</div>}
            <div className="domain-controls">
              <button
                className="btn secondary small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api<Preview>(
                      `/setup/domains/${d.id}/preview`,
                      { method: 'POST', body: {} },
                    );
                    setMigration(false);
                    setPreview({ domain: d, data: p });
                  })
                }
              >
                Review setup
              </button>
              <label className="catchall-field">
                Unmatched addresses
                <select
                  aria-label={`Catch-all mailbox for ${d.name}`}
                  value={d.catch_all_mailbox || ''}
                  onChange={(e) =>
                    void run(async () => {
                      await api(`/setup/domains/${d.id}`, {
                        method: 'PATCH',
                        body: { catchAllMailbox: e.target.value || null },
                      });
                      await refreshSettings();
                    }, 'Catch-all preference saved.')
                  }
                >
                  <option value="">Reject unknown recipients</option>
                  {progress.data!.mailboxes.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))
      ) : (
        <div className="small-empty">
          <Globe2 size={26} />
          <p>Your domains will feel right at home here.</p>
        </div>
      )}
      {adding && (
        <Modal
          title="Give another domain a home"
          onClose={() => setAdding(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/setup/domains', {
                  method: 'POST',
                  body: { zoneId: zone, provider },
                });
                await refreshSettings();
                setAdding(false);
                setZone('');
              }, 'Domain added. Review its setup to configure mail.');
            }}
          >
            <Field label="Cloudflare domain">
              <select
                required
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              >
                <option value="">Choose an active domain</option>
                {zones.data
                  ?.filter(
                    (z) =>
                      !progress.data?.domains.some((d) => d.zone_id === z.id),
                  )
                  .map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Sending provider">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as typeof provider)}
              >
                <option value="cloudflare">Cloudflare Email Sending</option>
                <option value="resend">Resend</option>
              </select>
            </Field>
            <p className="modal-copy subtle">
              Cloudflare sending requires Workers Paid and Email Sending access.
              Resend requires a connected API key. Your choice can be changed
              later.
            </p>
            <footer>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button className="btn" disabled={busy}>
                Add domain
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal
          title={`Mail setup for ${preview.domain.name}`}
          wide
          onClose={() => setPreview(null)}
        >
          <p className="modal-copy">
            Review the records and routing changes before applying them.
          </p>
          <div className="dns-preview">
            <h3>Receiving records</h3>
            {preview.data.required.map((r, i) => (
              <div key={i}>
                <span>{r.type}</span>
                <strong>{r.name}</strong>
                <code>{r.content}</code>
              </div>
            ))}
            {preview.data.sendingRecords.length > 0 && (
              <>
                <h3>Sending records</h3>
                {preview.data.sendingRecords.map((r, i) => (
                  <div key={i}>
                    <span>{r.type}</span>
                    <strong>{r.name}</strong>
                    <code>{r.content}</code>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="inline-note">{preview.data.warning}</div>
          <p className="modal-copy subtle">
            Incoming mail will route to this app’s Worker. Existing DMARC policy
            and unrelated DNS records are preserved. SPF is merged with existing
            permissions.
          </p>
          {preview.data.needsMigration && (
            <div className="migration-warning">
              <h3>Your existing mail routing will change</h3>
              {preview.data.mxConflicts.length > 0 && (
                <p>
                  Replace MX records pointing to{' '}
                  {preview.data.mxConflicts.map((r) => r.content).join(', ')}.
                </p>
              )}
              {preview.data.routingConflict && (
                <p>Replace the current catch-all destination.</p>
              )}
              {preview.data.enabledRules.length > 0 && (
                <p>
                  Disable {preview.data.enabledRules.length} existing forwarding
                  rules so registered addresses reach this app.
                </p>
              )}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={migration}
                  onChange={(e) => setMigration(e.target.checked)}
                />
                <span>
                  I understand that incoming mail will move to this app and have
                  arranged any existing mailbox migration.
                </span>
              </label>
            </div>
          )}
          <footer>
            <button className="btn secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={busy || (preview.data.needsMigration && !migration)}
              onClick={() =>
                void run(async () => {
                  await api(`/setup/domains/${preview.domain.id}/apply`, {
                    method: 'POST',
                    body: {
                      snapshot: preview.data.snapshot,
                      confirmMigration: migration,
                    },
                  });
                  await refreshSettings();
                  setPreview(null);
                }, 'Configuration applied. Check again after DNS propagates.')
              }
            >
              {busy ? 'Applying…' : 'Apply DNS & routing'}
            </button>
          </footer>
        </Modal>
      )}
      {switching && (
        <Confirm
          title="Change sending provider?"
          message={`New messages from ${switching.domain.name} will use ${switching.provider}. Finish or cancel pending sends first, then review the domain setup to verify the new provider.`}
          onClose={() => setSwitching(null)}
          onConfirm={async () => {
            await api(`/setup/domains/${switching.domain.id}`, {
              method: 'PATCH',
              body: { provider: switching.provider },
            });
            await refreshSettings();
          }}
        />
      )}
    </Card>
  );
}

type AdminMailbox = Mailbox & {
  members: { id: string; name: string; username: string }[];
};
export function MailboxSettings() {
  const progress = useProgress(),
    boxes = useQuery({
      queryKey: ['admin-mailboxes'],
      queryFn: () => api<AdminMailbox[]>('/admin/mailboxes'),
    }),
    users = useQuery({
      queryKey: ['users'],
      queryFn: () => api<(User & { disabled: boolean })[]>('/admin/users'),
    }),
    { user } = useSession(),
    { busy, run } = useTask();
  const [create, setCreate] = useState(false),
    [name, setName] = useState(''),
    [kind, setKind] = useState<'private' | 'shared'>('private'),
    [domain, setDomain] = useState(''),
    [local, setLocal] = useState(''),
    [members, setMembers] = useState<string[]>([user.id]),
    [quota, setQuota] = useState('1'),
    [alias, setAlias] = useState<AdminMailbox | null>(null),
    [editing, setEditing] = useState<AdminMailbox | null>(null),
    [memberBox, setMemberBox] = useState<AdminMailbox | null>(null),
    [deleting, setDeleting] = useState<AdminMailbox | null>(null),
    [deleteConfirmation, setDeleteConfirmation] = useState(''),
    [expanded, setExpanded] = useState('');
  const chooseMember = (id: string, checked: boolean) =>
    setMembers((old) =>
      kind === 'private'
        ? [id]
        : checked
          ? [...old, id]
          : old.filter((v) => v !== id),
    );
  return (
    <Card
      title="A place for every address"
      description="Private mailboxes belong to one person. Shared mailboxes bring people together."
      action={
        <button
          className="btn secondary small"
          disabled={!progress.data?.domains.length}
          onClick={() => {
            setName('');
            setLocal('');
            setKind('private');
            setMembers([user.id]);
            setDomain(progress.data?.domains[0]?.id || '');
            setQuota('1');
            setCreate(true);
          }}
        >
          <Plus size={16} />
          New mailbox
        </button>
      }
    >
      {boxes.isPending ? (
        <Spinner />
      ) : boxes.error ? (
        <ErrorState error={boxes.error} />
      ) : boxes.data?.length ? (
        boxes.data.map((b) => (
          <div className="admin-mailbox" key={b.id}>
            <div className="admin-mailbox-heading">
              <span className="mailbox-symbol">
                {initials(b.name).slice(0, 1)}
              </span>
              <button
                onClick={() => setExpanded(expanded === b.id ? '' : b.id)}
              >
                <strong>{b.name}</strong>
                <small>{b.primary_address}</small>
              </button>
              <span className="mailbox-type">{b.kind}</span>
              <button
                className="icon-btn"
                title={`Edit ${b.name}`}
                onClick={() => {
                  setEditing(b);
                  setName(b.name);
                  setQuota(String(b.quota_bytes / 1024 ** 3));
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-btn"
                title={`Expand ${b.name}`}
                onClick={() => setExpanded(expanded === b.id ? '' : b.id)}
              >
                {expanded === b.id ? (
                  <ChevronUp size={17} />
                ) : (
                  <ChevronDown size={17} />
                )}
              </button>
            </div>
            <div className="mailbox-summary">
              <span>{b.members.map((m) => m.name).join(', ')}</span>
              <small>
                {bytes(b.used_bytes)} of {bytes(b.quota_bytes)}
              </small>
            </div>
            {expanded === b.id && (
              <div className="address-list">
                {b.addresses.map((a) => (
                  <div key={a.id}>
                    <span>
                      <Mail size={15} />
                      {a.email}
                      {a.email === b.primary_address && <small>Primary</small>}
                      {!a.active && <small>Disabled</small>}
                    </span>
                    <div>
                      {a.email !== b.primary_address && a.active && (
                        <button
                          className="text-btn"
                          onClick={() =>
                            void run(async () => {
                              await api(`/admin/addresses/${a.id}`, {
                                method: 'PATCH',
                                body: { primary: true },
                              });
                              await refreshSettings();
                            }, 'Primary address updated.')
                          }
                        >
                          Make primary
                        </button>
                      )}
                      {a.email !== b.primary_address && (
                        <button
                          className="text-btn"
                          onClick={() =>
                            void run(async () => {
                              await api(`/admin/addresses/${a.id}`, {
                                method: 'PATCH',
                                body: { active: !a.active },
                              });
                              await refreshSettings();
                            }, 'Address updated.')
                          }
                        >
                          {a.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="mailbox-buttons">
                  <button
                    className="btn secondary small"
                    onClick={() => {
                      setAlias(b);
                      setDomain(progress.data?.domains[0]?.id || '');
                      setLocal('');
                      setName(b.name);
                    }}
                  >
                    Add alias
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={() => {
                      setMemberBox(b);
                      setKind(b.kind);
                      setMembers(b.members.map((m) => m.id));
                    }}
                  >
                    Manage members
                  </button>
                  <button
                    className="btn danger small"
                    onClick={() => {
                      setDeleting(b);
                      setDeleteConfirmation('');
                    }}
                  >
                    <Trash2 size={15} />
                    Delete mailbox
                  </button>
                </div>
              </div>
            )}
          </div>
        ))
      ) : (
        <div className="small-empty">
          <Layers size={28} />
          <p>Add a domain, then create your first mailbox.</p>
        </div>
      )}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => !busy && setDeleting(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || deleteConfirmation !== deleting.name) return;
              void run(async () => {
                await api(`/admin/mailboxes/${deleting.id}`, {
                  method: 'DELETE',
                  body: { confirmation: deleteConfirmation },
                });
                setDeleting(null);
                setExpanded('');
                await refreshSettings();
              }, 'Mailbox deleted. Stored files are being removed.');
            }}
          >
            <p className="modal-copy">
              Permanently delete this mailbox, all its messages, drafts,
              attachments, addresses and aliases, labels, and filters. Queued
              and scheduled emails will be cancelled. Any domain using this
              mailbox for catch-all will have catch-all disabled. This cannot be
              undone.
            </p>
            <p className="modal-copy">User accounts and domains will remain.</p>
            <Field label={`Type ${deleting.name} to confirm`}>
              <input
                autoFocus
                required
                autoComplete="off"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
              />
            </Field>
            <footer>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={busy || deleteConfirmation !== deleting.name}
              >
                {busy ? 'Deleting…' : 'Delete permanently'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {(create || alias) && (
        <Modal
          title={alias ? 'Another address, same mailbox' : 'A new mailbox'}
          onClose={() => {
            setCreate(false);
            setAlias(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                async () => {
                  if (alias)
                    await api(`/admin/mailboxes/${alias.id}/addresses`, {
                      method: 'POST',
                      body: { domainId: domain, localPart: local, name },
                    });
                  else
                    await api('/admin/mailboxes', {
                      method: 'POST',
                      body: {
                        name,
                        kind,
                        domainId: domain,
                        localPart: local,
                        memberIds: members,
                        quotaBytes: Math.round(Number(quota) * 1024 ** 3),
                      },
                    });
                  await refreshSettings();
                  setCreate(false);
                  setAlias(null);
                },
                alias ? 'Alias added.' : 'Mailbox created.',
              );
            }}
          >
            <Field label={alias ? 'Sender name' : 'Mailbox name'}>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="Email name">
                <input
                  required
                  placeholder="alex"
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                />
              </Field>
              <Field label="Domain">
                <select
                  required
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                >
                  {progress.data?.domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      @{d.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!alias && (
              <>
                <div className="form-grid">
                  <Field label="Mailbox type">
                    <select
                      value={kind}
                      onChange={(e) => {
                        setKind(e.target.value as typeof kind);
                        setMembers([user.id]);
                      }}
                    >
                      <option value="private">Private — one member</option>
                      <option value="shared">
                        Shared — equal access for all members
                      </option>
                    </select>
                  </Field>
                  <Field label="Storage quota (GB)">
                    <input
                      required
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="100"
                      value={quota}
                      onChange={(e) => setQuota(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="member-options">
                  <strong>
                    {kind === 'private' ? 'Mailbox owner' : 'Mailbox members'}
                  </strong>
                  {users.data
                    ?.filter((u) => !u.disabled)
                    .map((u) => (
                      <label className="checkbox-field" key={u.id}>
                        <input
                          type={kind === 'private' ? 'radio' : 'checkbox'}
                          name="members"
                          checked={members.includes(u.id)}
                          onChange={(e) => chooseMember(u.id, e.target.checked)}
                        />
                        {u.name}
                        <small>{u.username}</small>
                      </label>
                    ))}
                </div>
              </>
            )}
            <footer>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setCreate(false);
                  setAlias(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn"
                disabled={busy || (!alias && !members.length)}
              >
                {alias ? 'Add alias' : 'Create mailbox'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title="Mailbox details" onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(`/admin/mailboxes/${editing.id}`, {
                  method: 'PATCH',
                  body: {
                    name,
                    quotaBytes: Math.round(Number(quota) * 1024 ** 3),
                  },
                });
                await refreshSettings();
                setEditing(null);
              }, 'Mailbox updated.');
            }}
          >
            <Field label="Name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Storage quota (GB)">
              <input
                required
                type="number"
                step="0.1"
                min="0.1"
                max="100"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </Field>
            <footer>
              <button className="btn" disabled={busy}>
                Save changes
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {memberBox && (
        <Modal
          title={`Members of ${memberBox.name}`}
          onClose={() => setMemberBox(null)}
        >
          <p className="modal-copy">
            {kind === 'shared'
              ? 'All members can read, send, edit drafts, and manage conversations.'
              : 'This private mailbox has one member.'}
          </p>
          <div className="member-options">
            {users.data
              ?.filter((u) => !u.disabled)
              .map((u) => (
                <label className="checkbox-field" key={u.id}>
                  <input
                    type={kind === 'private' ? 'radio' : 'checkbox'}
                    name="members"
                    checked={members.includes(u.id)}
                    onChange={(e) => chooseMember(u.id, e.target.checked)}
                  />
                  {u.name}
                </label>
              ))}
          </div>
          <footer>
            <button
              className="btn secondary"
              onClick={() => setMemberBox(null)}
            >
              Cancel
            </button>
            <button
              className="btn"
              disabled={busy || !members.length}
              onClick={() =>
                void run(async () => {
                  await api(`/admin/mailboxes/${memberBox.id}/members`, {
                    method: 'PUT',
                    body: { userIds: members },
                  });
                  await refreshSettings();
                  setMemberBox(null);
                }, 'Members updated.')
              }
            >
              Save members
            </button>
          </footer>
        </Modal>
      )}
    </Card>
  );
}

function PeopleSettings() {
  const { user } = useSession(),
    { busy, run } = useTask(),
    users = useQuery({
      queryKey: ['users'],
      queryFn: () => api<(User & { disabled: boolean })[]>('/admin/users'),
    }),
    invites = useQuery({
      queryKey: ['invitations'],
      queryFn: () =>
        api<
          {
            id: string;
            email: string;
            name: string;
            role: string;
            expires_at: number;
            used_at: number | null;
          }[]
        >('/admin/invitations'),
    }),
    [invite, setInvite] = useState(false),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('member'),
    [send, setSend] = useState(true),
    [result, setResult] = useState<{ url: string; warning: string } | null>(
      null,
    );
  return (
    <>
      <Card
        title="The people in your space"
        description="Invite people you trust. Give each their own login and mailboxes."
        action={
          <button
            className="btn secondary small"
            onClick={() => {
              setInvite(true);
              setResult(null);
            }}
          >
            <Plus size={16} />
            Invite someone
          </button>
        }
      >
        {users.data?.map((u) => (
          <div className="person-row" key={u.id}>
            <span className="sender-avatar">{initials(u.name)}</span>
            <div>
              <strong>{u.name}</strong>
              <small>
                {u.username} · {u.recovery_email}
              </small>
            </div>
            {u.role === 'owner' ? (
              <span className="role-caption">Owner</span>
            ) : (
              <>
                <select
                  aria-label={`Role for ${u.name}`}
                  disabled={user.role !== 'owner' || busy}
                  value={u.role}
                  onChange={(e) =>
                    void run(async () => {
                      await api(`/admin/users/${u.id}`, {
                        method: 'PATCH',
                        body: { role: e.target.value },
                      });
                      await users.refetch();
                    }, 'Role updated.')
                  }
                >
                  <option value="member">Member</option>
                  <option value="admin">Administrator</option>
                </select>
                <button
                  className="text-btn"
                  disabled={
                    busy ||
                    u.id === user.id ||
                    (user.role !== 'owner' && u.role === 'admin')
                  }
                  onClick={() =>
                    void run(
                      async () => {
                        await api(`/admin/users/${u.id}`, {
                          method: 'PATCH',
                          body: { disabled: !u.disabled },
                        });
                        await users.refetch();
                      },
                      u.disabled
                        ? 'User enabled.'
                        : 'User disabled and signed out.',
                    )
                  }
                >
                  {u.disabled ? 'Enable' : 'Disable'}
                </button>
              </>
            )}
          </div>
        ))}
      </Card>
      <Card
        title="Invitations"
        description="An invitation expires after seven days and can be used once."
      >
        {invites.data?.length ? (
          invites.data.map((i) => (
            <div className="setting-line" key={i.id}>
              <div>
                <strong>{i.name}</strong>
                <p>{i.email}</p>
              </div>
              <StatusPill
                status={
                  i.used_at
                    ? 'accepted'
                    : i.expires_at < Date.now()
                      ? 'expired'
                      : 'pending'
                }
              />
              {!i.used_at && (
                <button
                  className="text-btn danger-text"
                  onClick={() =>
                    void run(async () => {
                      await api(`/admin/invitations/${i.id}`, {
                        method: 'DELETE',
                        body: {},
                      });
                      await invites.refetch();
                    }, 'Invitation revoked.')
                  }
                >
                  Revoke
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="subtle">No invitations yet.</p>
        )}
      </Card>
      {invite && (
        <Modal
          title={
            result
              ? 'An invitation, ready to share'
              : 'Bring someone into your space'
          }
          onClose={() => setInvite(false)}
        >
          {result ? (
            <>
              <p className="modal-copy">
                This link is private and works once. Send it to the person you
                invited.
              </p>
              <div className="invitation-url">{result.url}</div>
              {result.warning && (
                <div className="inline-error">{result.warning}</div>
              )}
              <footer>
                <button
                  className="btn secondary"
                  onClick={() => void navigator.clipboard.writeText(result.url)}
                >
                  Copy link
                  <Copy size={15} />
                </button>
                <button className="btn" onClick={() => setInvite(false)}>
                  Done
                </button>
              </footer>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await api<{ url: string; warning: string }>(
                    '/admin/invitations',
                    {
                      method: 'POST',
                      body: { name, email, role, send, mailboxIds: [] },
                    },
                  );
                  setResult(r);
                  await invites.refetch();
                });
              }}
            >
              <Field label="Name">
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Existing email address">
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="member">Member</option>
                  {user.role === 'owner' && (
                    <option value="admin">Administrator</option>
                  )}
                </select>
              </Field>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={send}
                  onChange={(e) => setSend(e.target.checked)}
                />
                Email the invitation
              </label>
              <footer>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setInvite(false)}
                >
                  Cancel
                </button>
                <button className="btn" disabled={busy}>
                  {send ? 'Create & email invitation' : 'Create invitation'}
                </button>
              </footer>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}

function AddressSettings() {
  const { mailboxes } = useSession();
  return (
    <Card
      title="Every address has a voice"
      description="Choose the sender name and signature for each address you can use."
    >
      {mailboxes
        .flatMap((b) => b.addresses.filter((a) => a.active))
        .map((a) => (
          <SignatureForm key={a.id} address={a} />
        ))}
      {!mailboxes.length && (
        <p className="subtle">
          Your addresses will appear here when a mailbox is assigned to you.
        </p>
      )}
    </Card>
  );
}
function SignatureForm({ address }: { address: Address }) {
  const element = document.createElement('div');
  element.innerHTML = address.signature;
  const [name, setName] = useState(address.name),
    [signature, setSignature] = useState(element.textContent || ''),
    { busy, run } = useTask();
  return (
    <form
      className="signature-form"
      onSubmit={(e) => {
        e.preventDefault();
        const escape = (v: string) =>
          v.replace(
            /[&<>]/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!,
          );
        void run(async () => {
          await api(`/preferences/addresses/${address.id}`, {
            method: 'PATCH',
            body: {
              name,
              signature: signature
                ? `<p>${escape(signature).replace(/\n/g, '<br>')}</p>`
                : '',
            },
          });
          await invalidateMail();
        }, 'Signature saved.');
      }}
    >
      <h3>{address.email}</h3>
      <Field label="Sender name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Signature">
        <textarea
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder="A few words to sign off with."
          rows={3}
        />
      </Field>
      <button className="btn secondary small" disabled={busy}>
        Save signature
      </button>
    </form>
  );
}

function AutomationSettings() {
  const { mailboxes, selectedMailbox } = useSession(),
    [mailbox, setMailbox] = useState(selectedMailbox || mailboxes[0]?.id || '');
  if (!mailboxes.length)
    return (
      <Card title="A little help behind the scenes">
        <p className="subtle">
          Add a mailbox to set up filters and away replies.
        </p>
      </Card>
    );
  return (
    <>
      <Card
        title="Which mailbox?"
        description="Filters and away replies are shared with everyone in this mailbox."
      >
        <select value={mailbox} onChange={(e) => setMailbox(e.target.value)}>
          {mailboxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} — {b.primary_address}
            </option>
          ))}
        </select>
      </Card>
      {mailbox && (
        <>
          <FiltersPanel key={`f:${mailbox}`} mailbox={mailbox} />
          <BlockedPanel key={`b:${mailbox}`} mailbox={mailbox} />
          <VacationPanel key={`v:${mailbox}`} mailbox={mailbox} />
        </>
      )}
    </>
  );
}
function FiltersPanel({ mailbox }: { mailbox: string }) {
  const query = useQuery({
      queryKey: ['filters', mailbox],
      queryFn: () => api<Filter[]>(`/preferences/filters/${mailbox}`),
    }),
    labels = useQuery({
      queryKey: ['labels'],
      queryFn: () => api<Label[]>('/mail/labels'),
    }),
    { busy, run } = useTask();
  const [editing, setEditing] = useState<Partial<Filter> | null>(null),
    [name, setName] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [subject, setSubject] = useState(''),
    [text, setText] = useState(''),
    [hasAttachment, setHasAttachment] = useState(false),
    [actions, setActions] = useState<Filter['actions']>({});
  function edit(f?: Filter) {
    setEditing(f || {});
    setName(f?.name || '');
    setFrom(f?.conditions.from || '');
    setTo(f?.conditions.to || '');
    setSubject(f?.conditions.subject || '');
    setText(f?.conditions.text || '');
    setHasAttachment(f?.conditions.hasAttachment || false);
    setActions(f?.actions || {});
  }
  return (
    <Card
      title="Let the little things sort themselves"
      description="Matching incoming messages follow these rules, in order."
      action={
        <button className="btn secondary small" onClick={() => edit()}>
          <Plus size={15} />
          New filter
        </button>
      }
    >
      {query.data?.length ? (
        query.data.map((f, index) => (
          <div className="filter-row" key={f.id}>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={!!f.enabled}
                onChange={(e) =>
                  void run(async () => {
                    await api(`/preferences/filters/${mailbox}/${f.id}`, {
                      method: 'PATCH',
                      body: { ...f, enabled: e.target.checked },
                    });
                    await query.refetch();
                  })
                }
              />
            </label>
            <div>
              <strong>{f.name}</strong>
              <small>
                {Object.entries(f.conditions)
                  .filter(([, v]) => !!v)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ') || 'All incoming messages'}
              </small>
            </div>
            <button
              className="icon-btn"
              title="Move filter up"
              disabled={index === 0 || busy}
              onClick={() =>
                void run(async () => {
                  const other = query.data![index - 1];
                  await api(`/preferences/filters/${mailbox}/${f.id}`, {
                    method: 'PATCH',
                    body: { ...f, position: index - 1, enabled: !!f.enabled },
                  });
                  await api(`/preferences/filters/${mailbox}/${other.id}`, {
                    method: 'PATCH',
                    body: {
                      ...other,
                      position: index,
                      enabled: !!other.enabled,
                    },
                  });
                  await query.refetch();
                })
              }
            >
              <ChevronUp size={16} />
            </button>
            <button
              className="icon-btn"
              title="Edit filter"
              onClick={() => edit(f)}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-btn"
              title="Delete filter"
              onClick={() =>
                void run(async () => {
                  await api(`/preferences/filters/${mailbox}/${f.id}`, {
                    method: 'DELETE',
                    body: {},
                  });
                  await query.refetch();
                }, 'Filter removed.')
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))
      ) : (
        <p className="subtle">
          Your inbox can stay simple. Add a rule when you need one.
        </p>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit filter' : 'A little automatic organisation'}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(
                  `/preferences/filters/${mailbox}${editing.id ? `/${editing.id}` : ''}`,
                  {
                    method: editing.id ? 'PATCH' : 'POST',
                    body: {
                      name,
                      position: editing.position ?? query.data?.length ?? 0,
                      enabled:
                        editing.enabled === undefined
                          ? true
                          : !!editing.enabled,
                      conditions: {
                        ...(from ? { from } : {}),
                        ...(to ? { to } : {}),
                        ...(subject ? { subject } : {}),
                        ...(text ? { text } : {}),
                        hasAttachment,
                      },
                      actions,
                    },
                  },
                );
                await query.refetch();
                setEditing(null);
              }, 'Filter saved.');
            }}
          >
            <Field label="Filter name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="From contains">
                <input value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To contains">
                <input value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="Subject contains">
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
              <Field label="Body contains">
                <input value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={hasAttachment}
                onChange={(e) => setHasAttachment(e.target.checked)}
              />
              Has an attachment
            </label>
            <h3>When it matches</h3>
            {[
              ['archive', 'Archive it'],
              ['star', 'Star it'],
              ['markRead', 'Mark it read'],
              ['spam', 'Move it to Spam'],
            ].map(([key, label]) => (
              <label className="checkbox-field" key={key}>
                <input
                  type="checkbox"
                  checked={!!actions[key as keyof typeof actions]}
                  onChange={(e) =>
                    setActions({ ...actions, [key]: e.target.checked })
                  }
                />
                {label}
              </label>
            ))}
            <Field label="Apply a label">
              <select
                value={actions.labelId || ''}
                onChange={(e) =>
                  setActions({
                    ...actions,
                    labelId: e.target.value || undefined,
                  })
                }
              >
                <option value="">No label</option>
                {labels.data
                  ?.filter((l) => l.mailbox_id === mailbox)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </Field>
            <footer>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="btn" disabled={busy}>
                Save filter
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </Card>
  );
}
function BlockedPanel({ mailbox }: { mailbox: string }) {
  const query = useQuery({
      queryKey: ['blocked', mailbox],
      queryFn: () =>
        api<{ sender: string }[]>(`/preferences/blocked/${mailbox}`),
    }),
    [sender, setSender] = useState(''),
    { busy, run } = useTask();
  return (
    <Card
      title="Leave the noise at the door"
      description="Messages from blocked senders go straight to Spam."
    >
      {query.data?.map((b) => (
        <div className="setting-line" key={b.sender}>
          <span>{b.sender}</span>
          <button
            className="text-btn"
            onClick={() =>
              void run(async () => {
                await api(`/preferences/blocked/${mailbox}`, {
                  method: 'DELETE',
                  body: { sender: b.sender },
                });
                await query.refetch();
              })
            }
          >
            Unblock
          </button>
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/preferences/blocked/${mailbox}`, {
              method: 'POST',
              body: { sender },
            });
            setSender('');
            await query.refetch();
          }, 'Sender blocked.');
        }}
      >
        <input
          required
          aria-label="Sender to block"
          placeholder="sender@example.com or @example.com"
          value={sender}
          onChange={(e) => setSender(e.target.value)}
        />
        <button className="btn secondary" disabled={busy}>
          Block sender
        </button>
      </form>
    </Card>
  );
}
function VacationPanel({ mailbox }: { mailbox: string }) {
  const { user } = useSession(),
    query = useQuery({
      queryKey: ['vacation', mailbox],
      queryFn: () =>
        api<{
          enabled: boolean;
          start: number;
          end: number;
          subject: string;
          text: string;
        }>(`/preferences/vacation/${mailbox}`),
    }),
    { busy, run } = useTask(),
    [enabled, setEnabled] = useState(false),
    [start, setStart] = useState(localDateTime(Date.now(), user.timezone)),
    [end, setEnd] = useState(
      localDateTime(Date.now() + 7 * 86400_000, user.timezone),
    ),
    [subject, setSubject] = useState('Out of office'),
    [text, setText] = useState('');
  useEffect(() => {
    if (query.data) {
      setEnabled(!!query.data.enabled);
      if (query.data.start)
        setStart(localDateTime(query.data.start, user.timezone));
      if (query.data.end) setEnd(localDateTime(query.data.end, user.timezone));
      setSubject(query.data.subject || 'Out of office');
      setText(query.data.text || '');
    }
  }, [query.data]);
  return (
    <Card
      title="Take a little time for yourself"
      description="Reply automatically while you’re away. Each sender hears from you at most once a day."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/preferences/vacation/${mailbox}`, {
              method: 'PUT',
              body: {
                enabled,
                start: zonedTimestamp(start, user.timezone),
                end: zonedTimestamp(end, user.timezone),
                subject,
                text,
              },
            });
            await query.refetch();
          }, 'Away reply saved.');
        }}
      >
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable away replies
        </label>
        <div className="form-grid">
          <Field label={`Starts (${user.timezone})`}>
            <input
              type="datetime-local"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="Ends">
            <input
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Subject">
          <input
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
        <Field label="Your reply">
          <textarea
            required={enabled}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <button className="btn" disabled={busy}>
          Save away reply
        </button>
      </form>
    </Card>
  );
}

function HealthSettings() {
  const query = useQuery({
      queryKey: ['health'],
      queryFn: () =>
        api<{
          version: string;
          schema: string;
          jobs: { status: string; count: number }[];
          ingestions: { status: string; count: number }[];
          failures: {
            id: string;
            status: string;
            last_error: string;
            provider: string;
            created_at: number;
          }[];
          processing: { id: string; error: string }[];
          storage: { mailboxes: number; bytes: number };
          bindings: Record<string, boolean>;
        }>('/admin/health'),
      refetchInterval: 30_000,
    }),
    audit = useQuery({
      queryKey: ['audit'],
      queryFn: () =>
        api<
          {
            id: string;
            action: string;
            actor: string;
            created_at: number;
            detail: string;
          }[]
        >('/admin/audit'),
    }),
    { user } = useSession(),
    { busy, run } = useTask(),
    [retry, setRetry] = useState<{ id: string; status: string } | null>(null);
  return (
    <>
      {query.isPending ? (
        <Spinner />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="health-stats">
            <div>
              <span>MAILBOXES</span>
              <strong>{query.data!.storage.mailboxes}</strong>
            </div>
            <div>
              <span>MAIL STORED</span>
              <strong>{bytes(query.data!.storage.bytes)}</strong>
            </div>
            <div>
              <span>VERSION</span>
              <strong>{query.data!.version}</strong>
            </div>
          </div>
          <Card
            title="Behind the scenes"
            description={`Database migration: ${query.data!.schema}`}
            action={
              <button
                className="icon-btn"
                title="Refresh health"
                onClick={() => void query.refetch()}
              >
                <RefreshCw size={17} />
              </button>
            }
          >
            <div className="binding-list">
              {Object.entries(query.data!.bindings).map(([name, ready]) => (
                <div key={name}>
                  <span>{name}</span>
                  <StatusPill status={ready ? 'ready' : 'missing'} />
                </div>
              ))}
            </div>
            <h3>Outbound messages</h3>
            <div className="health-counters">
              {query.data!.jobs.map((v) => (
                <span key={v.status}>
                  {v.status.replace(/_/g, ' ')} <strong>{v.count}</strong>
                </span>
              ))}
            </div>
            <h3>Inbound processing</h3>
            <div className="health-counters">
              {query.data!.ingestions.map((v) => (
                <span key={v.status}>
                  {v.status} <strong>{v.count}</strong>
                </span>
              ))}
            </div>
          </Card>
          <Card title="Messages needing attention">
            {query.data!.failures.length || query.data!.processing.length ? (
              <>
                {query.data!.failures.map((j) => (
                  <div className="failure-row" key={j.id}>
                    <div>
                      <StatusPill status={j.status} />
                      <small>
                        {j.provider} · {fullDate(j.created_at, user.timezone)}
                      </small>
                      <p>
                        {j.last_error ||
                          'The recipient server reported a delivery problem.'}
                      </p>
                    </div>
                    {['failed', 'uncertain'].includes(j.status) && (
                      <button
                        className="btn secondary small"
                        onClick={() => setRetry(j)}
                      >
                        Review retry
                      </button>
                    )}
                  </div>
                ))}
                {query.data!.processing.map((i) => (
                  <div className="failure-row" key={i.id}>
                    <div>
                      <strong>Inbound processing</strong>
                      <p>{i.error}</p>
                    </div>
                    <button
                      className="btn secondary small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`/admin/ingestions/${i.id}/retry`, {
                            method: 'POST',
                            body: {},
                          });
                          await query.refetch();
                        }, 'Processing retry queued.')
                      }
                    >
                      Retry processing
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <div className="all-clear">
                <ShieldCheck size={23} />
                <span>Everything has a little room to breathe.</span>
              </div>
            )}
          </Card>
        </>
      )}
      <Card
        title="Recent activity"
        description="Administrative changes and security events. Email bodies and credentials are never logged."
      >
        <div className="audit-list">
          {audit.data?.map((a) => (
            <div key={a.id}>
              <span>{a.action.replaceAll('.', ' · ')}</span>
              <small>
                {a.actor || 'System'} · {fullDate(a.created_at, user.timezone)}
              </small>
            </div>
          ))}
        </div>
      </Card>
      {retry && (
        <Confirm
          title={
            retry.status === 'uncertain'
              ? 'Retry a message with uncertain delivery?'
              : 'Retry this failed send?'
          }
          message={
            retry.status === 'uncertain'
              ? 'The provider may already have delivered this message. Check its provider activity first. Confirming a retry may send a duplicate.'
              : 'The message was rejected before acceptance. Confirm to retry with the current connection.'
          }
          onClose={() => setRetry(null)}
          onConfirm={async () => {
            await api(`/admin/jobs/${retry.id}/retry`, {
              method: 'POST',
              body: { acknowledgeDuplicate: retry.status === 'uncertain' },
            });
            await query.refetch();
          }}
        />
      )}
    </>
  );
}
