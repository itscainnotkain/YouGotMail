# YouGotMail

A private, Gmail-inspired email app with a calmer interface, your own branding, and all your domains in one place. The application runs on **one Cloudflare Worker**, with Cloudflare D1, private R2 storage, Queues, and Durable Objects. No application server is needed.

<!-- deploy-button:start -->

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fitscainnotkain%2FYouGotMail)
<!-- deploy-button:end -->

## What is included

- Unified and individual inboxes, private and shared mailboxes, multiple domains, aliases, plus addressing and optional catch-all.
- Conversations, replies, reply-all, forwarding, rich-text composition, inline images, private attachments and original inbound EML downloads.
- Autosaved drafts with shared-edit conflict detection, CC/BCC, ten-second undo send, scheduled sending and per-address signatures.
- Archive, stars, labels, read/unread, Spam, Trash, snooze, bulk actions, full-text search, contacts, filters, blocked senders and vacation replies.
- Owner/admin/member roles, invitations, password recovery, Argon2id passwords, optional TOTP with single-use recovery codes, session management, CSRF protection and rate limiting.
- Instance branding, logo/favicon, accent colour, login text, custom app hostname, dark mode and responsive layouts.
- Guided first-run setup, DNS/routing previews, explicit mail-service migration confirmation, DNS verification, real send/receive setup tests, health and audit pages.
- Native Cloudflare Email Sending where enabled, plus Resend. Each domain uses its selected provider; sends never silently switch providers.

Shared members have equal access to their shared mailbox, including drafts, read state and labels. Administrators configure users and mailbox membership; private email is accessible only to its mailbox members.

## Run locally

Use Node.js 24 LTS or newer.

```sh
npm ci
npm run setup:local
npm run dev
```

Open **http://127.0.0.1:5173**. `setup:local` generates private local secrets in the ignored `.dev.vars` file and applies local database migrations. Use its `SETUP_TOKEN` value to create the owner account. It preserves existing secrets on subsequent runs.

For a populated local preview, leave the dev server running and run this in another terminal:

```sh
npm run seed
```

On a fresh instance, this creates the local account **demo / Local demo password 123!**. If you already claimed the instance, it keeps your account and adds sample mail to it. It adds two mailboxes, three addresses, ten conversations, labels and a contact. These use `.example` domains and local storage only. The sample domains are marked ready for UI exploration; they do not represent verified public DNS. Seeding does not install provider credentials or send external email. Local Cloudflare email sending is simulated; Resend requires real credentials and makes real API requests if you connect it.

The demo seed uses the Cloudflare dev server's Local Explorer API and is never exposed as a production endpoint.

## Deploy to your Cloudflare account

Use a Workers Paid account with R2 and Queues available. Arbitrary-recipient native Cloudflare sending additionally requires Email Sending access. [Cloudflare Email Sending requirements and limits](https://developers.cloudflare.com/email-service/platform/limits/) apply independently of the app.

### One-click deployment

Click the deployment button above, connect your Git provider, and follow Cloudflare's deployment flow. The template declares its D1, R2, queue, Durable Object and email bindings in `wrangler.jsonc`; Cloudflare can provision the supported resources. Its deploy script builds the app and applies migrations using the **DB binding name**. [Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) describes resource provisioning and required secrets.

Supply **unique** `SETUP_TOKEN` and `APP_KEY` secrets when prompted. Generate them with:

```sh
npm run generate-secrets
```

`SETUP_TOKEN` unlocks first-run ownership; keep it until you claim the site. `APP_KEY` is a 32-byte base64 AES-GCM key for stored integration credentials and TOTP secrets. Back it up securely and retain it across deployments. Example placeholder secrets are rejected. Local `.dev.vars` values are not automatically published as production secrets.

### CLI deployment

```sh
npx wrangler login
npx wrangler d1 create yougotmail
npx wrangler r2 bucket create yougotmail-files
npx wrangler queues create yougotmail-jobs
npx wrangler queues create yougotmail-dead
```

Put the returned D1 `database_id` into the `DB` declaration in `wrangler.jsonc`. Use unique resource and Worker names if installing a second instance in the same account. Keep the dead-letter queue name ending in `-dead`, as declared by the template. Upload the generated production secrets:

```sh
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put APP_KEY
npm run deploy
```

The build emits the static app to `dist/client` and the Worker to `dist/yougotmail`. Only `dist/client` is public. Wrangler uses the Vite-generated deployment configuration. Do not publish the complete `dist` folder as static assets, as Worker build output may include development secrets. `npm run deploy` applies remote migrations before deployment; it stops on a failed migration.

## Finish setup on the site

1. Unlock the deployed site using your setup key and create the owner account. Use a recovery email you can already access.
2. Choose your branding. Optionally configure a custom app hostname before connecting Resend so its webhook uses the permanent hostname.
3. Connect a Cloudflare API token scoped to your account and the zones you intend to use. Provide the deployed Worker name. Connect Resend as well if you want it as a sending provider.
4. Add your active Cloudflare domains and select a sending provider per domain. Review the actual DNS and routing changes before applying them. Existing foreign MX records and forwarding routes require explicit migration acknowledgement. Existing SPF is merged; an existing DMARC policy is retained.
5. Create private or shared mailboxes, then add aliases and invite users. Unknown recipients are rejected unless you explicitly select a catch-all mailbox. Mailbox quotas default to 1 GiB and can be adjusted by an administrator. Quotas measure encoded message bytes; originals, parsed bodies and indexes can consume additional physical storage.
6. Send the setup test to your existing email, then reply to it. The wizard completes only after outbound acceptance and actual inbound receipt are confirmed.

Cloudflare must host authoritative DNS for each email domain. This release configures active zone apex domains, not arbitrary external DNS providers. DNS propagation can take time; recheck status in Domains. Selecting Resend for sending does not change inbound storage: Cloudflare Email Routing still delivers to the Worker.

For the scoped setup token, enable the permissions needed for the operations you choose:

| Scope                              | Operations                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Selected zones                     | Read zones; edit DNS; edit Email Routing settings and rules; manage Email Sending domains if using native sending |
| Selected account                   | Read Worker settings and Queues; manage event subscriptions for native delivery status                            |
| Selected account / zones, optional | Edit Worker custom domains when configuring a custom app hostname                                                 |

Permission labels can vary as Cloudflare's Email Service beta evolves. API errors appear in setup without exposing saved tokens. Domain configuration uses public MX, SPF and DKIM checks; native sending eligibility is finally confirmed by the actual send test. [Cloudflare native sending](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) and [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) document the platform configuration.

Use a Resend API key with domain and webhook management access during setup. Domain DKIM/return-path records are installed automatically. A signed delivery webhook is created for `/api/v1/webhooks/resend`; if its creation is unavailable, enter the signing secret from your Resend webhook settings. Cloudflare delivery events are subscribed to the jobs queue when supported; a configuration warning gives the manual step if the beta subscription API rejects automatic registration. Keep the subscription source scoped to your account, zone and sending domain.

## Operation and recovery

- Outbox distinguishes pending, sending, provider acceptance, recipient delivery failures and ambiguous sends. Provider acceptance means the provider accepted the message, not that every recipient received it.
- Durable outbox snapshots, queue handling and minute cron recovery prevent ordinary queue redelivery from resending accepted mail. Resend retries use a stable idempotency key within its 24-hour window. Ambiguous native sends require an administrator to review and explicitly acknowledge possible duplicate delivery before retrying.
- The health page shows processing failures and retry controls. Cron also wakes snoozed conversations, recovers abandoned draft locks and removes orphan uploads. Trash and Spam are permanently cleared after 30 days.
- Incoming originals and bodies are private in R2. Attachments require mailbox access. HTML uses a script-free sandbox and a restrictive CSP; external images load only when explicitly enabled for that message. No third-party analytics are included.
- Basic Spam handling uses blocked senders and user-defined rules. It is not an advanced spam classifier or malware scanner. Authentication headers supplied by arbitrary senders are not treated as trusted spam signals.
- Back up D1 and R2 together, plus `APP_KEY` separately. A D1-only backup cannot restore stored bodies or attachments. Use [D1 export](https://developers.cloudflare.com/d1/reference/export-import/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), and an authenticated S3-compatible R2 backup process. Restore into a separate test instance before replacing an existing deployment.
- Keep production secrets and tokens out of Git. D1/R2 data and development state are excluded by `.gitignore`. Rotating a provider API token is done in Connections. Rotating `APP_KEY` requires decrypting and reencrypting existing integrations and TOTP data; replacing it blindly will lock those records.
- For a new version, run checks, back up storage, then deploy. Database migrations are tracked independently of Worker versions; rolling back a Worker does not roll back its database.

## Validation and architecture

```sh
npm run check
npx wrangler deploy --dry-run
```

Tests execute inside the Workers runtime using real local D1, R2 and Durable Objects. External sending/DNS APIs are mocked so tests never send mail or modify DNS. They cover first-owner claims, password encryption, TOTP replay, CSRF, private/shared access, MIME parsing and deduplication, quotas, rendering, search/threading, drafts, undo, schedules, provider redelivery, signed webhooks, early delivery events, cron recovery and DNS migration safeguards.

The React/Tiptap app is in `src/`, the Hono Worker and email/queue/cron handlers are in `worker/`, shared API types are in `shared/`, and versioned D1 SQL is in `migrations/`. D1 stores metadata and FTS5 search indexes; R2 stores MIME, bodies, attachments and immutable outbox snapshots; Durable Objects provide rate limits and mailbox update notifications. Webmail has a polling fallback when its notification socket disconnects.

Inbound raw email is limited to 25 MiB. Native Cloudflare outbound messages are limited to 5 MiB and 32 attachments; the app limits Resend messages to 25 MiB after MIME/base64 overhead. A single uploaded attachment is capped at 18 MiB, with at most 50 combined recipients. At least one To address is required by the supported sending APIs. The UI and server both enforce limits. Provider-generated API identifiers are kept separate from RFC Message-IDs; unambiguous recent replies can use a subject/participant fallback when the provider doesn't return the real header ID.

This release provides webmail for one private organisation per deployment. It does not implement IMAP, POP or an SMTP server, external-provider mailbox synchronisation, enterprise e-discovery, end-to-end encryption or Gmail-scale spam filtering. Outgoing EML downloads reconstruct the saved content; inbound downloads preserve the original received bytes.

Local builds and provider-mocked tests do not prove public DNS propagation or live deliverability. Complete the deployed wizard's real send/receive test before using an instance for mail.
