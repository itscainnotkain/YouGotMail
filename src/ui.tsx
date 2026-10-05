import { createContext, useContext, useState, type ReactNode } from 'react';
import { X, Check, AlertCircle, LoaderCircle, Mail } from 'lucide-react';
import type { Branding } from '../shared/types';

type Toast = {
  id: number;
  message: string;
  error?: boolean;
  action?: { label: string; run: () => void };
};
const ToastContext = createContext<
  (message: string, error?: boolean, action?: Toast['action']) => void
>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = (message: string, error = false, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, message, error, action }]);
    setTimeout(
      () => setToasts((t) => t.filter((v) => v.id !== id)),
      action ? 10_000 : 5000,
    );
  };
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.error ? 'error' : ''}`} key={t.id}>
            {t.error ? <AlertCircle size={18} /> : <Check size={18} />}
            <span>{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((v) => v.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              className="icon-btn"
              aria-label="Dismiss notification"
              onClick={() => setToasts((v) => v.filter((x) => x.id !== t.id))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
export function Brand({
  branding,
  large = false,
}: {
  branding?: Branding;
  large?: boolean;
}) {
  return (
    <div className={`brand ${large ? 'large' : ''}`}>
      {branding?.logo ? (
        <img src={branding.logo} alt="" />
      ) : (
        <span className="brand-mark">
          <Mail size={large ? 25 : 20} strokeWidth={1.6} />
        </span>
      )}
      <span>
        {branding?.name || 'YouGotMail'}
        <span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="empty-state">
      <AlertCircle size={28} />
      <h3>Something needs attention</h3>
      <p>
        {error instanceof Error
          ? error.message
          : 'This request could not be completed.'}
      </p>
      {retry && (
        <button className="btn secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`status-pill ${['ready', 'delivered', 'done', 'accepted'].includes(status) ? 'good' : ['failed', 'uncertain', 'delivery_failed', 'disabled'].includes(status) ? 'bad' : ''}`}
    >
      <i />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
export function Confirm({
  title,
  message,
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string;
  message: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    toast = useToast();
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-copy">{message}</p>
      <footer>
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className={`btn ${danger ? 'danger' : ''}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : 'Confirm'}
        </button>
      </footer>
    </Modal>
  );
}
