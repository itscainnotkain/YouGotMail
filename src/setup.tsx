import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Globe2,
  Leaf,
  Mail,
  Paintbrush,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useSession } from './app';
import { api, queryClient } from './api';
import {
  BrandingSettings,
  DomainSettings,
  IntegrationSettings,
  MailboxSettings,
  refreshSettings,
  useProgress,
} from './settings';
import { ErrorState, Field, Spinner, StatusPill, useToast } from './ui';

const steps = [
  {
    name: 'Make it yours',
    detail: 'A name, a colour, a little personality.',
    icon: Paintbrush,
  },
  {
    name: 'Connect your account',
    detail: 'Your Cloudflare account, safely connected.',
    icon: Cloud,
  },
  {
    name: 'Bring your domains',
    detail: 'Give every address a home.',
    icon: Globe2,
  },
  {
    name: 'Create your mailboxes',
    detail: 'A space for you and your people.',
    icon: Mail,
  },
  {
    name: 'Say your first hello',
    detail: 'Make sure mail flows both ways.',
    icon: Send,
  },
];
export function SetupPage() {
  const { user, branding } = useSession(),
    progress = useProgress(),
    navigate = useNavigate(),
    [step, setStep] = useState(0);
  useEffect(() => {
    if (progress.data) {
      if (progress.data.branding.setup_complete) return;
      const initial = progress.data.mailboxes.length
        ? 4
        : progress.data.domains.length
          ? 3
          : progress.data.connection
            ? 2
            : 0;
      setStep(initial);
    }
  }, [!!progress.data]);
  if (user.role === 'member')
    return (
      <ErrorState
        error={new Error('An administrator needs to configure this space.')}
      />
    );
  return (
    <section className="setup-page">
      <div className="page-heading">
        <div>
          <div className="heading-eyebrow">A GOOD PLACE TO START</div>
          <h1>
            Welcome to your space<span className="heading-dot">.</span>
          </h1>
          <p>A few simple steps, and your mail will feel right at home.</p>
        </div>
        <span className="setup-owned">
          <ShieldCheck size={16} /> Your account. Your mail.
        </span>
      </div>
      <div className="setup-layout">
        <aside className="setup-steps">
          {steps.map((s, i) => (
            <button
              key={s.name}
              className={`${step === i ? 'current' : ''} ${step > i ? 'done' : ''}`}
              onClick={() => setStep(i)}
            >
              <span className="step-number">
                {step > i ? <Check size={15} /> : i + 1}
              </span>
              <div>
                <strong>{s.name}</strong>
                <small>{s.detail}</small>
              </div>
            </button>
          ))}
          <div className="setup-note">
            <Leaf size={20} />
            <p>
              Everything lives in your own Cloudflare account. A little
              independence feels good.
            </p>
          </div>
        </aside>
        <div className="setup-panel">
          {progress.isPending ? (
            <Spinner />
          ) : progress.error ? (
            <ErrorState error={progress.error} />
          ) : step === 0 ? (
            <BrandingSettings />
          ) : step === 1 ? (
            <IntegrationSettings />
          ) : step === 2 ? (
            <DomainSettings />
          ) : step === 3 ? (
            <MailboxSettings />
          ) : (
            <SetupTest onComplete={() => navigate('/mail/inbox')} />
          )}
          <div className="setup-navigation">
            {step > 0 ? (
              <button
                className="btn secondary"
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeft size={16} />
                Back
              </button>
            ) : (
              <span />
            )}
            {step < 4 && (
              <button
                className="btn"
                disabled={
                  (step === 1 && !progress.data?.connection) ||
                  (step === 2 && !progress.data?.domains.length) ||
                  (step === 3 && !progress.data?.mailboxes.length)
                }
                onClick={() => setStep(step + 1)}
              >
                Continue
                <ArrowRight size={16} />
              </button>
            )}
            {branding.setup_complete && (
              <Link to="/mail/inbox" className="text-btn">
                Back to your inbox
                <ArrowRight size={15} />
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
function SetupTest({ onComplete }: { onComplete: () => void }) {
  const { mailboxes, user } = useSession(),
    toast = useToast(),
    [address, setAddress] = useState(
      mailboxes
        .flatMap((b) => b.addresses)
        .find((a) => a.sending_status === 'ready' && a.active)?.id || '',
    ),
    [recipient, setRecipient] = useState(user.recovery_email),
    [busy, setBusy] = useState(false);
  const test = useQuery({
    queryKey: ['setup-test'],
    queryFn: () =>
      api<{
        outbound: boolean;
        inbound: boolean;
        status?: string;
        error?: string;
        address?: string;
      }>('/setup/test'),
    refetchInterval: 5000,
  });
  async function send() {
    setBusy(true);
    try {
      await api('/setup/test', {
        method: 'POST',
        body: { recipient, addressId: address },
      });
      await test.refetch();
      toast(
        'Your test is queued. Check your existing inbox, then send a reply.',
      );
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <header className="settings-card-heading">
        <div>
          <h2>Your first hello</h2>
          <p>Send a real test, then reply to it from your existing inbox.</p>
        </div>
      </header>
      <div className="settings-card-body">
        <div className="setup-test-icon">
          <Mail size={31} strokeWidth={1.4} />
        </div>
        <Field label="Send from">
          <select value={address} onChange={(e) => setAddress(e.target.value)}>
            <option value="">Choose a verified address</option>
            {mailboxes
              .flatMap((b) =>
                b.addresses.filter(
                  (a) => a.active && a.sending_status === 'ready',
                ),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Send to your existing email">
          <input
            type="email"
            required
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </Field>
        <button
          className="btn secondary"
          disabled={busy || !address || !recipient}
          onClick={() => void send()}
        >
          <Send size={16} />
          {busy ? 'Sending…' : 'Send test message'}
        </button>
        {test.data?.address && (
          <p className="test-instruction">
            Once it arrives, reply from your existing inbox to{' '}
            <strong>{test.data.address}</strong>. We’ll detect the incoming
            message automatically.
          </p>
        )}
        <div className="setup-test-status">
          <div>
            <span>
              <Send size={17} /> Outbound sending
            </span>
            <StatusPill
              status={
                test.data?.outbound ? 'ready' : test.data?.status || 'waiting'
              }
            />
          </div>
          <div>
            <span>
              <Mail size={17} /> Inbound receiving
            </span>
            <StatusPill status={test.data?.inbound ? 'ready' : 'waiting'} />
          </div>
        </div>
        {test.data?.error && (
          <div className="inline-error">{test.data.error}</div>
        )}
        <button
          className="btn complete-setup"
          disabled={busy || !test.data?.outbound || !test.data?.inbound}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/setup/complete', { method: 'POST', body: {} });
              await refreshSettings();
              onComplete();
              toast('Your space is ready. Welcome home.');
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Everything’s ready. Take me home.
          <ArrowRight size={17} />
        </button>
        <p className="setup-footnote">
          Both checks must pass before setup is complete. You can come back
          while DNS changes settle.
        </p>
      </div>
    </section>
  );
}
