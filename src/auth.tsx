import { useState, type FormEvent } from 'react';
import {
  useNavigate,
  useParams,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Leaf, ShieldCheck, Layers, Mail } from 'lucide-react';
import { api, ApiException, setAuth, type AuthData, type Status } from './api';
import { Brand, Field, Spinner } from './ui';

export function AuthPage({
  mode = 'login',
}: {
  mode?: 'login' | 'invite' | 'reset' | 'claim';
}) {
  const navigate = useNavigate(),
    params = useParams(),
    [search] = useSearchParams();
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: () => api<Status>('/setup/status'),
  });
  const invitation = useQuery({
    queryKey: ['invitation', params.token],
    queryFn: () =>
      api<{ name: string; email: string }>(`/auth/invite/${params.token}`),
    enabled: mode === 'invite',
  });
  const [username, setUsername] = useState(''),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [setupToken, setSetupToken] = useState(''),
    [code, setCode] = useState(''),
    [twoFactor, setTwoFactor] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [forgot, setForgot] = useState(false),
    [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (forgot) {
        const r = await api<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: { username },
        });
        setMessage(r.message);
        return;
      }
      if (mode === 'reset') {
        await api('/auth/reset-password', {
          method: 'POST',
          body: {
            token: search.get('token') || '',
            password,
            code: code || undefined,
          },
        });
        setMessage('Your password has been reset. You can sign in now.');
        return;
      }
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data =
        mode === 'claim'
          ? await api<AuthData>('/setup/claim', {
              method: 'POST',
              body: {
                setupToken,
                username,
                name,
                recoveryEmail: email,
                password,
                timezone,
              },
            })
          : mode === 'invite'
            ? await api<AuthData>('/auth/accept-invite', {
                method: 'POST',
                body: {
                  token: params.token,
                  username,
                  name: name || invitation.data?.name,
                  password,
                  timezone,
                },
              })
            : await api<AuthData>('/auth/login', {
                method: 'POST',
                body: { username, password, code: code || undefined },
              });
      setAuth(data);
      navigate(mode === 'claim' ? '/setup' : '/mail/inbox');
    } catch (e) {
      if (e instanceof ApiException && e.code === 'TWO_FACTOR')
        setTwoFactor(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = forgot
    ? 'A fresh start.'
    : mode === 'claim'
      ? 'Make yourself at home.'
      : mode === 'invite'
        ? 'You’re invited.'
        : mode === 'reset'
          ? 'A new password.'
          : 'Welcome back.';
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Brand branding={status?.branding} large />
        <div className="auth-story-content">
          <span className="eyebrow">
            <Leaf size={15} /> A CALMER KIND OF EMAIL
          </span>
          <h1>
            A little less noise.
            <br />
            <span>A little more you.</span>
          </h1>
          <p>
            Your mail, your domains, your space.
            <br />
            Everything you need. Room to breathe.
          </p>
          <div className="auth-features">
            <span>
              <Layers size={17} /> Every address, together
            </span>
            <span>
              <ShieldCheck size={17} /> A space you own
            </span>
          </div>
        </div>
        <div className="auth-story-footer">
          Thoughtfully simple. Entirely yours.
        </div>
        <div className="auth-decoration">
          <Mail size={160} strokeWidth={0.5} />
        </div>
      </aside>
      <main className="auth-form-side">
        <div className="auth-mobile-brand">
          <Brand branding={status?.branding} />
        </div>
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">
            {mode === 'claim'
              ? 'FIRST THINGS FIRST'
              : mode === 'invite'
                ? 'YOUR NEW MAILBOX'
                : 'YOUR OWN LITTLE CORNER'}
          </span>
          <h2>{title}</h2>
          <p className="subtle">
            {forgot
              ? 'Enter your username to request a recovery link.'
              : mode === 'claim'
                ? 'Unlock this instance and create your owner account.'
                : mode === 'invite'
                  ? `Join ${status?.branding.name || 'YouGotMail'}${invitation.data ? ` as ${invitation.data.email}` : ''}.`
                  : mode === 'reset'
                    ? 'Choose a password with at least 12 characters.'
                    : status?.branding.login_text ||
                      'Sign in and pick up where you left off.'}
          </p>
          {mode === 'invite' && invitation.isPending ? (
            <Spinner />
          ) : invitation.error ? (
            <div className="inline-error">{invitation.error.message}</div>
          ) : (
            <>
              {mode === 'claim' && (
                <Field
                  label="Setup key"
                  hint="The unique SETUP_TOKEN you supplied when deploying."
                >
                  <input
                    required
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              )}
              {(mode === 'claim' || mode === 'invite') && (
                <Field label="Your name">
                  <input
                    required
                    value={
                      name ||
                      (mode === 'invite' ? invitation.data?.name || '' : '')
                    }
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </Field>
              )}
              {mode !== 'reset' && (
                <Field label="Username">
                  <input
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    placeholder="e.g. alex"
                    pattern={
                      mode === 'login' || forgot
                        ? undefined
                        : '[a-zA-Z0-9._@-]{3,100}'
                    }
                  />
                </Field>
              )}
              {mode === 'claim' && (
                <Field
                  label="Recovery email"
                  hint="Use an existing email address you can already access."
                >
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </Field>
              )}
              {!forgot && (
                <Field
                  label={mode === 'reset' ? 'New password' : 'Password'}
                  hint={
                    mode === 'claim' || mode === 'invite'
                      ? 'At least 12 characters. A passphrase works nicely.'
                      : undefined
                  }
                >
                  <input
                    required
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={mode === 'login' ? undefined : 12}
                    maxLength={256}
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                  />
                </Field>
              )}
              {(twoFactor || mode === 'reset') && !forgot && (
                <Field
                  label={
                    mode === 'reset'
                      ? 'Authenticator or recovery code (if enabled)'
                      : 'Authenticator or recovery code'
                  }
                >
                  <input
                    required={twoFactor}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="one-time-code"
                  />
                </Field>
              )}
              {error && (
                <div className="inline-error" role="alert">
                  {error}
                </div>
              )}
              {message && <div className="inline-success">{message}</div>}
              {!message || forgot ? (
                <button className="btn auth-submit" disabled={busy}>
                  {busy
                    ? 'Just a moment…'
                    : forgot
                      ? 'Send recovery link'
                      : mode === 'claim'
                        ? 'Create my space'
                        : mode === 'invite'
                          ? 'Create account'
                          : mode === 'reset'
                            ? 'Reset password'
                            : 'Sign in'}
                  {!busy && <ArrowRight size={18} />}
                </button>
              ) : (
                <Link className="btn auth-submit" to="/login">
                  Sign in
                  <ArrowRight size={18} />
                </Link>
              )}
              {mode === 'login' && (
                <button
                  type="button"
                  className="text-btn forgot"
                  onClick={() => {
                    setForgot(!forgot);
                    setError('');
                    setMessage('');
                  }}
                >
                  {forgot ? 'Back to sign in' : 'Forgot your password?'}
                </button>
              )}
            </>
          )}
          <div className="auth-footnote">
            <ShieldCheck size={14} />
            <span>
              Private by invitation. Hosted in your own Cloudflare account.
            </span>
          </div>
        </form>
      </main>
    </div>
  );
}
