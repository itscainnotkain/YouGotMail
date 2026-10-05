import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { useQuery } from '@tanstack/react-query';
import {
  Bold,
  ChevronDown,
  Clock3,
  ImagePlus,
  Italic,
  Link2,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Send,
  Trash2,
  Underline,
  X,
} from 'lucide-react';
import type { Attachment, Contact, Draft, Participant } from '../shared/types';
import {
  api,
  bytes,
  invalidateMail,
  localDateTime,
  zonedTimestamp,
} from './api';
import { useSession } from './app';
import { Confirm, Field, Modal, useToast } from './ui';

export function parseRecipients(value: string): Participant[] {
  const chunks: string[] = [];
  let current = '',
    quoted = false,
    inAngle = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === '<') inAngle = true;
    if (char === '>') inAngle = false;
    if ((char === ',' || char === ';') && !quoted && !inAngle) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.map((chunk) => {
    const match = chunk.match(/^(.*?)<([^>]+)>$/),
      address = (match ? match[2] : chunk).trim().toLowerCase(),
      name = match ? match[1].trim().replace(/^"|"$/g, '') : '';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))
      throw new Error(`Finish entering a valid email address: ${chunk}`);
    return { address, ...(name ? { name } : {}) };
  });
}
function renderRecipients(p: Participant[]) {
  return p
    .map((v) =>
      v.name ? `"${v.name.replace(/"/g, '')}" <${v.address}>` : v.address,
    )
    .join(', ');
}
type Model = {
  address_id: string;
  subject: string;
  toRaw: string;
  ccRaw: string;
  bccRaw: string;
  html: string;
  text: string;
};
export function Composer({
  draft,
  onClose,
  onSent,
}: {
  draft: Draft;
  onClose: () => void;
  onSent: (job: { id: string }) => void;
}) {
  const { mailboxes, user } = useSession(),
    box = mailboxes.find((b) => b.id === draft.mailbox_id),
    toast = useToast();
  const [model, setModel] = useState<Model>({
    address_id: draft.address_id,
    subject: draft.subject,
    toRaw: renderRecipients(draft.to),
    ccRaw: renderRecipients(draft.cc),
    bccRaw: renderRecipients(draft.bcc),
    html: draft.html,
    text: draft.text,
  });
  const modelRef = useRef(model),
    revision = useRef(draft.revision),
    saveQueue = useRef<Promise<unknown>>(Promise.resolve()),
    lastSaved = useRef(''),
    attachmentsRef = useRef(draft.attachments),
    sendKey = useRef(crypto.randomUUID());
  const [attachments, setAttachments] = useState(draft.attachments),
    [saveStatus, setSaveStatus] = useState('Saved to Drafts'),
    [conflict, setConflict] = useState(false),
    [showCc, setShowCc] = useState(draft.cc.length > 0),
    [showBcc, setShowBcc] = useState(draft.bcc.length > 0),
    [minimised, setMinimised] = useState(false),
    [full, setFull] = useState(false),
    [sending, setSending] = useState(false),
    [uploading, setUploading] = useState(false),
    [schedule, setSchedule] = useState(false),
    [scheduleAt, setScheduleAt] = useState(
      localDateTime(Date.now() + 86400_000, user.timezone),
    ),
    [discard, setDiscard] = useState(false),
    [linkModal, setLinkModal] = useState(false),
    [linkUrl, setLinkUrl] = useState('');
  const files = useRef<HTMLInputElement>(null),
    images = useRef<HTMLInputElement>(null),
    sendBusy = useRef(false);
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api<Contact[]>('/preferences/contacts'),
  });
  function update(change: Partial<Model>) {
    setModel((old) => {
      const next = { ...old, ...change };
      modelRef.current = next;
      return next;
    });
    setSaveStatus('Unsaved changes');
  }
  const previewHtml = (html: string) =>
    html.replace(/cid:([^"'\s>]+)/g, (_m, cid) => {
      const attachment = attachmentsRef.current.find((a) => a.cid === cid);
      return attachment
        ? `/api/v1/mail/attachments/${attachment.id}?inline=1`
        : '';
    });
  const serializeHtml = (html: string) => {
    for (const a of attachmentsRef.current.filter((v) => v.inline && v.cid)) {
      html = html.replaceAll(
        `/api/v1/mail/attachments/${a.id}?inline=1`,
        `cid:${a.cid}`,
      );
    }
    return html;
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        link: { openOnClick: false },
      }),
      Image.configure({ inline: false }),
    ],
    content: previewHtml(draft.html || '<p></p>'),
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'compose-editor', 'aria-label': 'Message body' },
    },
    onUpdate: ({ editor }) =>
      update({ html: serializeHtml(editor.getHTML()), text: editor.getText() }),
  });
  function payload() {
    const v = modelRef.current;
    return {
      mailbox_id: draft.mailbox_id,
      address_id: v.address_id,
      thread_id: draft.thread_id,
      subject: v.subject,
      to: parseRecipients(v.toRaw),
      cc: parseRecipients(v.ccRaw),
      bcc: parseRecipients(v.bccRaw),
      html: v.html,
      text: v.text,
      in_reply_to: draft.in_reply_to,
      references: draft.references,
    };
  }
  const saveNow = useCallback(() => {
    const task = saveQueue.current
      .catch(() => {})
      .then(async () => {
        const data = payload(),
          signature = JSON.stringify(data);
        if (signature === lastSaved.current) return;
        if (conflict)
          throw new Error(
            'This draft changed in another window. Save a new copy to keep your version.',
          );
        setSaveStatus('Saving…');
        try {
          const result = await api<{ revision: number; updated_at: number }>(
            `/mail/drafts/${draft.id}`,
            { method: 'PATCH', body: { ...data, revision: revision.current } },
          );
          revision.current = result.revision;
          lastSaved.current = signature;
          setSaveStatus('Saved to Drafts');
        } catch (e) {
          if ((e as { code?: string }).code === 'DRAFT_CONFLICT')
            setConflict(true);
          setSaveStatus((e as Error).message);
          throw e;
        }
      });
    saveQueue.current = task;
    return task;
  }, [draft.id, conflict]);
  useEffect(() => {
    if (!lastSaved.current)
      try {
        lastSaved.current = JSON.stringify(payload());
      } catch {
        /* Invalid imported recipients remain editable. */
      }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      void saveNow().catch((e) => setSaveStatus((e as Error).message));
    }, 900);
    return () => clearTimeout(timer);
  }, [model, saveNow]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      try {
        if (JSON.stringify(payload()) === lastSaved.current) return;
      } catch {}
      event.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);
  async function close() {
    try {
      await saveNow();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function send(dueAt?: number) {
    if (sendBusy.current) return;
    sendBusy.current = true;
    setSending(true);
    try {
      await saveNow();
      const data = payload();
      if (!data.to.length) throw new Error('Add at least one To recipient.');
      const job = await api<{ id: string }>(`/mail/drafts/${draft.id}/send`, {
        method: 'POST',
        body: {
          revision: revision.current,
          key: sendKey.current,
          ...(dueAt ? { dueAt } : {}),
        },
      });
      setSchedule(false);
      onSent(job);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSending(false);
      sendBusy.current = false;
    }
  }
  async function upload(fileList: FileList | null, inline = false) {
    if (!fileList?.length) return;
    setUploading(true);
    try {
      await saveNow();
      for (const file of Array.from(fileList)) {
        const a = await api<Attachment>(
          `/mail/drafts/${draft.id}/attachments?filename=${encodeURIComponent(file.name)}${inline ? '&inline=1' : ''}`,
          { method: 'POST', file },
        );
        attachmentsRef.current = [...attachmentsRef.current, a];
        setAttachments(attachmentsRef.current);
        if (inline)
          editor
            ?.chain()
            .focus()
            .setImage({
              src: `/api/v1/mail/attachments/${a.id}?inline=1`,
              alt: a.filename,
            })
            .run();
      }
      toast(inline ? 'Image added.' : 'Attachment added.');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setUploading(false);
      if (files.current) files.current.value = '';
      if (images.current) images.current.value = '';
    }
  }
  const address = box?.addresses.find((a) => a.id === model.address_id),
    estimatedSize =
      new TextEncoder().encode(model.html + model.text).length +
      4096 +
      attachments.reduce(
        (s, a) => s + Math.ceil(a.size / 3) * 4 * 1.03 + 512,
        0,
      ),
    max =
      address?.provider === 'cloudflare' ? 5 * 1024 * 1024 : 25 * 1024 * 1024;
  return (
    <>
      <section
        className={`composer ${minimised ? 'minimised' : ''} ${full ? 'full' : ''}`}
        role="dialog"
        aria-label="Compose message"
      >
        <header className="composer-header">
          <strong>{model.subject || 'A new conversation'}</strong>
          <div>
            <button
              className="icon-btn"
              title={minimised ? 'Restore' : 'Minimise'}
              onClick={() => setMinimised(!minimised)}
            >
              <Minus size={17} />
            </button>
            <button
              className="icon-btn"
              title={full ? 'Restore size' : 'Expand'}
              onClick={() => {
                setFull(!full);
                setMinimised(false);
              }}
            >
              {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              className="icon-btn"
              aria-label="Save and close draft"
              onClick={() => void close()}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        {!minimised && (
          <>
            <div className="composer-fields">
              <label>
                <span>From</span>
                <select
                  aria-label="Sending address"
                  value={model.address_id}
                  onChange={(e) => update({ address_id: e.target.value })}
                >
                  {box?.addresses
                    .filter((a) => a.active)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name ? `${a.name} <${a.email}>` : a.email}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>To</span>
                <input
                  aria-label="To recipients"
                  list="contact-options"
                  value={model.toRaw}
                  onChange={(e) => update({ toRaw: e.target.value })}
                  placeholder="Who’s it for?"
                  autoFocus
                />
                <div className="recipient-toggles">
                  <button type="button" onClick={() => setShowCc(!showCc)}>
                    Cc
                  </button>
                  <button type="button" onClick={() => setShowBcc(!showBcc)}>
                    Bcc
                  </button>
                </div>
              </label>
              {showCc && (
                <label>
                  <span>Cc</span>
                  <input
                    aria-label="CC recipients"
                    value={model.ccRaw}
                    onChange={(e) => update({ ccRaw: e.target.value })}
                    list="contact-options"
                  />
                </label>
              )}
              {showBcc && (
                <label>
                  <span>Bcc</span>
                  <input
                    aria-label="BCC recipients"
                    value={model.bccRaw}
                    onChange={(e) => update({ bccRaw: e.target.value })}
                    list="contact-options"
                  />
                </label>
              )}
              <label>
                <input
                  aria-label="Subject"
                  placeholder="Subject"
                  value={model.subject}
                  onChange={(e) => update({ subject: e.target.value })}
                  maxLength={998}
                />
              </label>
              <datalist id="contact-options">
                {contacts.data?.map((c) => (
                  <option key={c.id} value={c.email}>
                    {c.name}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="compose-body">
              <EditorContent editor={editor} />
              {attachments.filter((a) => !a.inline).length > 0 && (
                <div className="compose-attachments">
                  {attachments
                    .filter((a) => !a.inline)
                    .map((a) => (
                      <div key={a.id}>
                        <Paperclip size={14} />
                        <span>{a.filename}</span>
                        <small>{bytes(a.size)}</small>
                        <button
                          className="icon-btn"
                          title={`Remove ${a.filename}`}
                          onClick={async () => {
                            try {
                              await api(
                                `/mail/drafts/${draft.id}/attachments/${a.id}`,
                                { method: 'DELETE', body: {} },
                              );
                              attachmentsRef.current =
                                attachmentsRef.current.filter(
                                  (v) => v.id !== a.id,
                                );
                              setAttachments(attachmentsRef.current);
                            } catch (e) {
                              toast((e as Error).message, true);
                            }
                          }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
            {conflict && (
              <div className="draft-conflict">
                <p>
                  Another member changed this draft. Your version is still here.
                </p>
                <button
                  onClick={async () => {
                    try {
                      const copy = payload(),
                        next = await api<Draft>('/mail/drafts', {
                          method: 'POST',
                          body: copy,
                        });
                      for (const a of attachments) {
                        const response = await fetch(
                          `/api/v1/mail/attachments/${a.id}`,
                        );
                        if (!response.ok)
                          throw new Error('Attachment could not be copied');
                        const file = new File(
                          [await response.blob()],
                          a.filename,
                          { type: a.content_type },
                        );
                        const uploaded = await api<Attachment>(
                          `/mail/drafts/${next.id}/attachments?filename=${encodeURIComponent(a.filename)}${a.inline ? '&inline=1' : ''}`,
                          { method: 'POST', file },
                        );
                        if (a.inline && a.cid)
                          copy.html = copy.html.replaceAll(
                            `cid:${a.cid}`,
                            `cid:${uploaded.cid}`,
                          );
                      }
                      if (copy.html !== next.html)
                        await api(`/mail/drafts/${next.id}`, {
                          method: 'PATCH',
                          body: { ...copy, revision: next.revision },
                        });
                      onClose();
                      void invalidateMail();
                      void composeNew(next.id);
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  Save a new copy
                </button>
              </div>
            )}
            <div className="formatting-toolbar">
              <button
                className={`icon-btn ${editor?.isActive('bold') ? 'active' : ''}`}
                title="Bold"
                onClick={() => editor?.chain().focus().toggleBold().run()}
              >
                <Bold size={16} />
              </button>
              <button
                className="icon-btn"
                title="Italic"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
              >
                <Italic size={16} />
              </button>
              <button
                className="icon-btn"
                title="Underline"
                onClick={() => editor?.chain().focus().toggleUnderline().run()}
              >
                <Underline size={16} />
              </button>
              <button
                className="icon-btn"
                title="Insert link"
                onClick={() => setLinkModal(true)}
              >
                <Link2 size={16} />
              </button>
              <span className="toolbar-divider" />
              <button
                className="icon-btn"
                title="Attach files"
                onClick={() => files.current?.click()}
                disabled={uploading}
              >
                <Paperclip size={17} />
              </button>
              <button
                className="icon-btn"
                title="Insert image"
                onClick={() => images.current?.click()}
                disabled={uploading}
              >
                <ImagePlus size={17} />
              </button>
              {address?.signature && (
                <button
                  className="text-btn"
                  onClick={() =>
                    editor
                      ?.chain()
                      .focus()
                      .insertContent(address.signature)
                      .run()
                  }
                >
                  Signature
                </button>
              )}
            </div>
            <footer className="composer-footer">
              <div className="send-controls">
                <button
                  className="btn send-btn"
                  disabled={sending || uploading || estimatedSize > max}
                  onClick={() => void send()}
                >
                  {sending ? 'Sending…' : uploading ? 'Uploading…' : 'Send'}
                  <Send size={16} />
                </button>
                <button
                  className="schedule-toggle"
                  title="Schedule send"
                  disabled={sending || uploading || estimatedSize > max}
                  onClick={() => setSchedule(true)}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
              <span
                className={`save-status ${estimatedSize > max ? 'danger-text' : ''}`}
              >
                {estimatedSize > max
                  ? `${bytes(estimatedSize)} exceeds this provider’s ${bytes(max)} limit`
                  : saveStatus === 'Saved to Drafts'
                    ? `${saveStatus} · ${bytes(estimatedSize)}`
                    : saveStatus}
              </span>
              <button
                className="icon-btn"
                title="Discard draft"
                onClick={() => setDiscard(true)}
              >
                <Trash2 size={18} />
              </button>
            </footer>
            <input
              ref={files}
              type="file"
              multiple
              hidden
              onChange={(e) => void upload(e.target.files)}
            />
            <input
              ref={images}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => void upload(e.target.files, true)}
            />
          </>
        )}
      </section>
      {schedule && (
        <Modal
          title="Send it at the right moment"
          onClose={() => setSchedule(false)}
        >
          <Field label={`Send at (${user.timezone})`}>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </Field>
          <footer>
            <button
              className="btn secondary"
              onClick={() => setSchedule(false)}
            >
              Cancel
            </button>
            <button
              className="btn"
              disabled={sending}
              onClick={() => {
                try {
                  void send(zonedTimestamp(scheduleAt, user.timezone));
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              <Clock3 size={16} /> Schedule send
            </button>
          </footer>
        </Modal>
      )}
      {discard && (
        <Confirm
          title="Discard this draft?"
          message="Your draft and its attachments will be removed."
          danger
          onClose={() => setDiscard(false)}
          onConfirm={async () => {
            await saveQueue.current.catch(() => {});
            await api(`/mail/drafts/${draft.id}`, {
              method: 'DELETE',
              body: {},
            });
            onClose();
          }}
        />
      )}
      {linkModal && (
        <Modal title="Insert a link" onClose={() => setLinkModal(false)}>
          <Field label="URL">
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <footer>
            <button
              className="btn secondary"
              onClick={() => setLinkModal(false)}
            >
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => {
                try {
                  const url = new URL(linkUrl);
                  if (!['https:', 'http:'].includes(url.protocol))
                    throw new Error();
                  editor?.chain().focus().setLink({ href: url.href }).run();
                  setLinkModal(false);
                  setLinkUrl('');
                } catch {
                  toast('Enter a valid http or https link.', true);
                }
              }}
            >
              Insert link
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
  async function composeNew(id: string) {
    onClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new CustomEvent('ygm:open-draft', { detail: id }));
  }
}
