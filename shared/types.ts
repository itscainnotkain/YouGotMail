export type Role = 'owner' | 'admin' | 'member';
export type Folder =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'scheduled'
  | 'snoozed'
  | 'all'
  | 'spam'
  | 'trash'
  | 'starred';
export type Provider = 'cloudflare' | 'resend';
export type User = {
  id: string;
  username: string;
  name: string;
  recovery_email: string;
  role: Role;
  timezone: string;
  two_factor: boolean;
};
export type Branding = {
  name: string;
  accent: string;
  login_text: string;
  logo: string;
  favicon: string;
  app_url: string;
  setup_complete: boolean;
};
export type Address = {
  id: string;
  mailbox_id: string;
  domain_id: string;
  email: string;
  name: string;
  signature: string;
  active: number;
  provider?: Provider;
  sending_status?: string;
};
export type Mailbox = {
  id: string;
  name: string;
  kind: 'private' | 'shared';
  primary_address: string;
  quota_bytes: number;
  used_bytes: number;
  addresses: Address[];
  unread: number;
};
export type Participant = { address: string; name?: string };
export type Label = {
  id: string;
  mailbox_id: string;
  name: string;
  color: string;
};
export type Thread = {
  id: string;
  mailbox_id: string;
  subject: string;
  snippet: string;
  participants: Participant[];
  updated_at: number;
  unread: number;
  starred: number;
  folder: string;
  snoozed_until: number | null;
  count: number;
  has_attachments: number;
  labels: Label[];
  mailbox_name?: string;
  delivery_status?: string;
};
export type Message = {
  id: string;
  thread_id: string;
  mailbox_id: string;
  direction: string;
  from_address: string;
  from_name: string;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  reply_to: Participant[];
  subject: string;
  date: number;
  internet_id: string;
  in_reply_to: string;
  references: string[];
  html: string;
  text: string;
  parse_error: string;
  attachments: Attachment[];
  delivery_status?: string;
  deliveries?: { recipient: string; status: string; detail: string }[];
};
export type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  cid: string;
  inline: number;
};
export type Draft = {
  id: string;
  mailbox_id: string;
  address_id: string;
  thread_id: string | null;
  subject: string;
  to: Participant[];
  cc: Participant[];
  bcc: Participant[];
  html: string;
  text: string;
  attachments: Attachment[];
  revision: number;
  updated_at: number;
  in_reply_to: string;
  references: string[];
};
export type Domain = {
  id: string;
  name: string;
  zone_id: string;
  provider: Provider;
  receiving_status: string;
  sending_status: string;
  catch_all_mailbox: string | null;
  last_error: string;
  created_at: number;
  provider_domain_id: string;
  event_subscription_id: string;
  last_checked: number;
};
export type Contact = {
  id: string;
  name: string;
  email: string;
  notes: string;
};
export type Filter = {
  id: string;
  mailbox_id: string;
  name: string;
  position: number;
  enabled: number;
  conditions: {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    hasAttachment?: boolean;
  };
  actions: {
    labelId?: string;
    archive?: boolean;
    star?: boolean;
    markRead?: boolean;
    spam?: boolean;
  };
};
export type ApiError = { error: string; code?: string; details?: unknown };
