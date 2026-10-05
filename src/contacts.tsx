import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ContactRound, Mail, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Contact } from '../shared/types';
import { api, initials, queryClient } from './api';
import { Confirm, ErrorState, Field, Modal, Spinner, useToast } from './ui';
import { useSession } from './app';

export function ContactsPage() {
  const query = useQuery({
      queryKey: ['contacts'],
      queryFn: () => api<Contact[]>('/preferences/contacts'),
    }),
    { compose } = useSession(),
    toast = useToast();
  const [search, setSearch] = useState(''),
    [editing, setEditing] = useState<Partial<Contact> | null>(null),
    [deleting, setDeleting] = useState<Contact | null>(null),
    [busy, setBusy] = useState(false);
  const contacts =
    query.data?.filter((c) =>
      `${c.name} ${c.email}`.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  return (
    <section className="settings-page">
      <div className="page-heading">
        <div>
          <div className="heading-eyebrow">THE PEOPLE IN YOUR CORNER</div>
          <h1>
            Contacts<span className="heading-dot">.</span>
          </h1>
          <p>Good conversations start with good company.</p>
        </div>
        <button
          className="btn"
          onClick={() => setEditing({ name: '', email: '', notes: '' })}
        >
          <Plus size={17} />
          New contact
        </button>
      </div>
      <div className="settings-card">
        <div className="contacts-toolbar">
          <Search size={17} />
          <input
            aria-label="Search contacts"
            placeholder="Find someone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span>{contacts.length} contacts</span>
        </div>
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : contacts.length ? (
          <div className="contacts-list">
            {contacts.map((c, i) => (
              <div className="contact-row" key={c.id}>
                <span className={`sender-avatar tone-${i % 5}`}>
                  {initials(c.name)}
                </span>
                <div>
                  <strong>{c.name}</strong>
                  <span>{c.email}</span>
                  {c.notes && <small>{c.notes}</small>}
                </div>
                <button
                  className="icon-btn"
                  title={`Email ${c.name}`}
                  onClick={async () => {
                    await compose({
                      recipient: { address: c.email, name: c.name },
                    });
                  }}
                >
                  <Mail size={18} />
                </button>
                <button
                  className="icon-btn"
                  title={`Edit ${c.name}`}
                  onClick={() => setEditing(c)}
                >
                  <Pencil size={17} />
                </button>
                <button
                  className="icon-btn"
                  title={`Delete ${c.name}`}
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <ContactRound size={35} strokeWidth={1.3} />
            <h2>A little good company.</h2>
            <p>Add the people you email to keep them close at hand.</p>
          </div>
        )}
      </div>
      {editing && (
        <Modal
          title={editing.id ? 'Edit contact' : 'Add a familiar face'}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  `/preferences/contacts${editing.id ? `/${editing.id}` : ''}`,
                  {
                    method: editing.id ? 'PATCH' : 'POST',
                    body: {
                      name: editing.name,
                      email: editing.email,
                      notes: editing.notes || '',
                    },
                  },
                );
                await queryClient.invalidateQueries({ queryKey: ['contacts'] });
                setEditing(null);
                toast('Contact saved.');
              } catch (err) {
                toast((err as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Name">
              <input
                required
                value={editing.name || ''}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </Field>
            <Field label="Email">
              <input
                required
                type="email"
                value={editing.email || ''}
                onChange={(e) =>
                  setEditing({ ...editing, email: e.target.value })
                }
              />
            </Field>
            <Field label="Notes">
              <textarea
                value={editing.notes || ''}
                onChange={(e) =>
                  setEditing({ ...editing, notes: e.target.value })
                }
              />
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
                {busy ? 'Saving…' : 'Save contact'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="Remove this contact?"
          message={`${deleting.name} will be removed from your contacts. Their email conversations will stay in your mailbox.`}
          onClose={() => setDeleting(null)}
          danger
          onConfirm={async () => {
            await api(`/preferences/contacts/${deleting.id}`, {
              method: 'DELETE',
              body: {},
            });
            await queryClient.invalidateQueries({ queryKey: ['contacts'] });
          }}
        />
      )}
    </section>
  );
}
