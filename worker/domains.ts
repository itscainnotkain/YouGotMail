import type { Env } from './env';
import { AppError } from './env';
import type { Domain } from '../shared/types';
import {
  cf,
  cfList,
  dnsAnswers,
  resend,
  type CloudflareConnection,
  type DnsRecord,
} from './providers';
import { digest, getIntegration } from './crypto';
import { now, setting, setSetting } from './lib';

type ResendDomain = {
  id: string;
  name: string;
  status: string;
  records: {
    record: string;
    type: string;
    name: string;
    value: string;
    priority?: number;
    status?: string;
  }[];
};
const sendingEvents = [
  'message.delivered',
  'message.deferred',
  'message.bounced',
  'message.failed',
  'message.rejected',
  'message.complained',
];
export function providerDnsName(name: string, domain: string) {
  const clean = name.trim().replace(/\.$/, '').toLowerCase();
  if (!clean || clean === '@') return domain;
  return clean === domain || clean.endsWith(`.${domain}`)
    ? clean
    : `${clean}.${domain}`;
}
export async function getDomain(env: Env, domainId: string) {
  const domain = await env.DB.prepare('SELECT * FROM domains WHERE id=?')
    .bind(domainId)
    .first<Domain>();
  if (!domain) throw new AppError(404, 'Domain not found');
  return domain;
}
export async function previewDomain(env: Env, domain: Domain) {
  const records = await cfList<DnsRecord>(
    env,
    `/zones/${domain.zone_id}/dns_records`,
  );
  const existing = (records || []).filter(
    (r) =>
      r.name === domain.name ||
      r.name === `_dmarc.${domain.name}` ||
      r.name.endsWith(`._domainkey.${domain.name}`) ||
      (r.name.endsWith(`.${domain.name}`) &&
        /^(cf-bounce|send)\./.test(r.name)),
  );
  const conflicts = records.filter(
    (r) =>
      r.type === 'MX' &&
      r.name === domain.name &&
      !/^route[123]\.mx\.cloudflare\.net\.?$/.test(r.content),
  );
  const routing = await cf<{
    enabled?: boolean;
    actions?: { type: string; value?: string[] }[];
  }>(env, `/zones/${domain.zone_id}/email/routing/rules/catch_all`);
  const config = await getIntegration<CloudflareConnection>(env, 'cloudflare');
  const routingConflict =
    !!routing.enabled &&
    !routing.actions?.some(
      (a) => a.type === 'worker' && a.value?.includes(config!.workerName),
    );
  const explicitRules = await cfList<{
    id: string;
    enabled: boolean;
    name: string;
    actions: { type: string; value?: string[] }[];
  }>(env, `/zones/${domain.zone_id}/email/routing/rules`);
  const enabledRules = (explicitRules || []).filter(
    (r) =>
      r.enabled &&
      !r.actions.some(
        (a) => a.type === 'worker' && a.value?.includes(config!.workerName),
      ),
  );
  const required: DnsRecord[] = [1, 2, 3].map((priority) => ({
    type: 'MX',
    name: domain.name,
    content: `route${priority}.mx.cloudflare.net`,
    priority: priority * 10,
    ttl: 1,
  }));
  const spfs = records.filter(
    (r) =>
      r.type === 'TXT' &&
      r.name === domain.name &&
      r.content.replace(/^"|"$/g, '').startsWith('v=spf1'),
  );
  if (spfs.length > 1)
    throw new AppError(
      400,
      'Multiple SPF records exist. Merge them into a single SPF record before continuing.',
    );
  const currentSpf = spfs[0]?.content.replace(/^"|"$/g, '');
  const merged = currentSpf
    ? currentSpf.includes('include:_spf.mx.cloudflare.net')
      ? currentSpf
      : currentSpf.replace(
          /\s+([~?+-]?all)\s*$/,
          ' include:_spf.mx.cloudflare.net $1',
        )
    : 'v=spf1 include:_spf.mx.cloudflare.net ~all';
  if (currentSpf && !merged.includes('include:_spf.mx.cloudflare.net'))
    throw new AppError(
      400,
      'Your existing SPF record has no final all mechanism. Correct it before setup.',
    );
  required.push({ type: 'TXT', name: domain.name, content: merged, ttl: 1 });
  let sendingRecords: DnsRecord[] = [],
    warning = '';
  if (domain.provider === 'resend') {
    if (!(await getIntegration(env, 'resend')))
      warning = 'Connect Resend before applying this configuration.';
    else if (domain.provider_domain_id) {
      const d = await resend<ResendDomain>(
        env,
        `/domains/${domain.provider_domain_id}`,
      );
      sendingRecords = d.records.map((r) => ({
        type: r.type,
        name: providerDnsName(r.name, domain.name),
        content: r.value,
        priority: r.priority,
        ttl: 1,
      }));
    } else
      warning =
        'Resend will generate the DKIM and return-path records during setup.';
  } else
    warning =
      'Cloudflare will generate and manage its DKIM and cf-bounce records. Workers Paid and Email Sending access are required.';
  const snapshot = await digest(
    JSON.stringify({
      records: existing.sort((a, b) => (a.id || '').localeCompare(b.id || '')),
      routing,
      enabledRules,
      provider: domain.provider,
    }),
  );
  await setSetting(env, `domain-preview:${domain.id}`, {
    snapshot,
    expires: now() + 15 * 60_000,
  });
  return {
    snapshot,
    existing,
    required,
    sendingRecords,
    mxConflicts: conflicts,
    routingConflict,
    enabledRules,
    warning,
    needsMigration:
      conflicts.length > 0 || routingConflict || enabledRules.length > 0,
  };
}
async function upsertDns(env: Env, zoneId: string, record: DnsRecord) {
  const existing = await cf<DnsRecord[]>(
    env,
    `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}&per_page=100`,
  );
  const exact = existing.find(
    (r) =>
      r.content.replace(/^"|"$/g, '') ===
        record.content.replace(/^"|"$/g, '') &&
      (record.type !== 'MX' || r.priority === record.priority),
  );
  if (exact) return;
  const payload = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: 1,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  };
  const spf = record.content.startsWith('v=spf1')
    ? existing.find((r) => r.content.replace(/^"|"$/g, '').startsWith('v=spf1'))
    : undefined;
  if (spf) {
    if (spf.locked)
      throw new AppError(
        400,
        'An existing locked SPF record needs to be unlocked before it can be merged.',
      );
    await cf(env, `/zones/${zoneId}/dns_records/${spf.id}`, 'PATCH', payload);
  } else await cf(env, `/zones/${zoneId}/dns_records`, 'POST', payload);
}
export async function applyDomain(
  env: Env,
  domain: Domain,
  snapshot: string,
  confirmMigration: boolean,
) {
  const saved = await setting<{ snapshot: string; expires: number } | null>(
    env,
    `domain-preview:${domain.id}`,
    null,
  );
  if (!saved || saved.expires < now() || saved.snapshot !== snapshot)
    throw new AppError(
      409,
      'Review a fresh DNS preview before applying changes',
    );
  const preview = await previewDomain(env, domain);
  if (preview.snapshot !== snapshot)
    throw new AppError(
      409,
      'DNS or routing changed since your preview. Review the changes again.',
    );
  if (preview.needsMigration && !confirmMigration)
    throw new AppError(
      409,
      'Confirm migration from your existing mail service before changing routing',
    );
  const config = await getIntegration<CloudflareConnection>(env, 'cloudflare');
  const lockUntil = now() + 10 * 60_000;
  const claim = await env.DB.prepare(
    "UPDATE domains SET setup_lock_until=?,receiving_status='configuring',sending_status='configuring',last_error='' WHERE id=? AND setup_lock_until<=?",
  )
    .bind(lockUntil, domain.id, now())
    .run();
  if (!claim.meta.changes)
    throw new AppError(
      409,
      'This domain is already being configured. Wait for the current setup to finish.',
    );
  try {
    for (const record of preview.mxConflicts)
      await cf(
        env,
        `/zones/${domain.zone_id}/dns_records/${record.id}`,
        'DELETE',
      );
    for (const record of preview.required.filter((r) => r.type === 'TXT'))
      await upsertDns(env, domain.zone_id, record);
    await cf(env, `/zones/${domain.zone_id}/email/routing/dns`, 'POST', {
      name: domain.name,
    });
    await cf(env, `/zones/${domain.zone_id}/email/routing`, 'PATCH', {
      support_subaddress: true,
      skip_wizard: true,
    });
    for (const rule of preview.enabledRules)
      await cf(
        env,
        `/zones/${domain.zone_id}/email/routing/rules/${rule.id}`,
        'PATCH',
        { enabled: false },
      );
    await cf(
      env,
      `/zones/${domain.zone_id}/email/routing/rules/catch_all`,
      'PUT',
      {
        enabled: true,
        name: 'YouGotMail',
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [config!.workerName] }],
      },
    );
    await env.DB.prepare(
      "UPDATE domains SET receiving_status='pending' WHERE id=?",
    )
      .bind(domain.id)
      .run();
    if (domain.provider === 'cloudflare') {
      const existing = (
        await cfList<{ name: string; tag: string; id?: string }>(
          env,
          `/zones/${domain.zone_id}/email/sending/subdomains`,
        )
      ).find((d) => d.name === domain.name);
      const d =
        existing ||
        (await cf<{ id?: string; tag: string }>(
          env,
          `/zones/${domain.zone_id}/email/sending/subdomains`,
          'POST',
          { name: domain.name },
        ));
      const providerId = d.id || d.tag;
      await env.DB.prepare('UPDATE domains SET provider_domain_id=? WHERE id=?')
        .bind(providerId, domain.id)
        .run();
      // Existing DMARC policy is retained. Start new domains in monitoring mode.
      if (
        !preview.existing.some(
          (r) => r.type === 'TXT' && r.name === `_dmarc.${domain.name}`,
        )
      )
        await upsertDns(env, domain.zone_id, {
          type: 'TXT',
          name: `_dmarc.${domain.name}`,
          content: 'v=DMARC1; p=none;',
          ttl: 1,
        });
      if (!domain.event_subscription_id && config?.queueId) {
        try {
          const subscription = await cf<{ id: string }>(
            env,
            `/accounts/${config.accountId}/event_subscriptions/subscriptions`,
            'POST',
            {
              name: `YouGotMail ${domain.name}`,
              enabled: true,
              destination: { type: 'queues.queue', queue_id: config.queueId },
              source: {
                type: 'email.sending',
                zone_id: domain.zone_id,
                domain: domain.name,
              },
              events: sendingEvents,
            },
          );
          await env.DB.prepare(
            'UPDATE domains SET event_subscription_id=? WHERE id=?',
          )
            .bind(subscription.id, domain.id)
            .run();
        } catch {
          await env.DB.prepare('UPDATE domains SET last_error=? WHERE id=?')
            .bind(
              'Delivery events could not be subscribed automatically. In Cloudflare Queues, add an Email Sending subscription for this domain to the jobs queue.',
              domain.id,
            )
            .run();
        }
      }
    } else {
      let providerId = domain.provider_domain_id;
      if (!providerId) {
        const domains = await resend<{ data: ResendDomain[] }>(env, '/domains');
        providerId =
          domains.data.find((d) => d.name === domain.name)?.id ||
          (
            await resend<ResendDomain>(env, '/domains', 'POST', {
              name: domain.name,
              region: 'eu-west-1',
            })
          ).id;
        await env.DB.prepare(
          'UPDATE domains SET provider_domain_id=? WHERE id=?',
        )
          .bind(providerId, domain.id)
          .run();
      }
      const d = await resend<ResendDomain>(env, `/domains/${providerId}`);
      for (const r of d.records)
        await upsertDns(env, domain.zone_id, {
          type: r.type,
          name: providerDnsName(r.name, domain.name),
          content: r.value,
          priority: r.priority,
        });
      if (
        !preview.existing.some(
          (r) => r.type === 'TXT' && r.name === `_dmarc.${domain.name}`,
        )
      )
        await upsertDns(env, domain.zone_id, {
          type: 'TXT',
          name: `_dmarc.${domain.name}`,
          content: 'v=DMARC1; p=none;',
          ttl: 1,
        });
      await resend(env, `/domains/${providerId}/verify`, 'POST');
    }
    return await checkDomain(env, await getDomain(env, domain.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Domain setup failed';
    await env.DB.prepare(
      'UPDATE domains SET last_error=?,last_checked=? WHERE id=?',
    )
      .bind(message, now(), domain.id)
      .run();
    throw new AppError(400, message, 'DOMAIN_SETUP');
  } finally {
    await env.DB.prepare(
      'UPDATE domains SET setup_lock_until=0 WHERE id=? AND setup_lock_until=?',
    )
      .bind(domain.id, lockUntil)
      .run();
  }
}
export async function checkDomain(env: Env, domain: Domain) {
  let receiving = 'pending',
    sending = 'pending',
    error = domain.last_error;
  try {
    const [mx, route] = await Promise.all([
      dnsAnswers(domain.name, 'MX'),
      cf<{ enabled: boolean; actions: { type: string; value?: string[] }[] }>(
        env,
        `/zones/${domain.zone_id}/email/routing/rules/catch_all`,
      ),
    ]);
    const config = await getIntegration<CloudflareConnection>(
      env,
      'cloudflare',
    );
    if (
      [1, 2, 3].every((n) =>
        mx.some((r) =>
          new RegExp(`route${n}\\.mx\\.cloudflare\\.net\\.?$`).test(r),
        ),
      ) &&
      mx.every((r) => /route[123]\.mx\.cloudflare\.net\.?$/.test(r)) &&
      route.enabled &&
      route.actions.some(
        (a) => a.type === 'worker' && a.value?.includes(config!.workerName),
      )
    )
      receiving = 'ready';
    if (domain.provider_domain_id) {
      if (domain.provider === 'resend') {
        const d = await resend<ResendDomain>(
          env,
          `/domains/${domain.provider_domain_id}`,
        );
        sending =
          d.status === 'verified'
            ? 'ready'
            : d.status === 'failed'
              ? 'failed'
              : 'pending';
      } else {
        const d = await cf<{
          enabled: boolean;
          name: string;
          dkim_selector?: string;
          return_path_domain?: string;
        }>(
          env,
          `/zones/${domain.zone_id}/email/sending/subdomains/${domain.provider_domain_id}`,
        );
        const returnPath = d.return_path_domain || `cf-bounce.${domain.name}`;
        const [spf, dkim] = await Promise.all([
          dnsAnswers(returnPath, 'TXT'),
          dnsAnswers(
            `${d.dkim_selector || 'cf-bounce'}._domainkey.${domain.name}`,
            'TXT',
          ),
        ]);
        if (
          d.enabled &&
          spf.some((r) => r.startsWith('v=spf1')) &&
          dkim.some((r) => r.includes('p='))
        )
          sending = 'ready';
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Domain check failed';
  }
  await env.DB.prepare(
    'UPDATE domains SET receiving_status=?,sending_status=?,last_error=?,last_checked=? WHERE id=?',
  )
    .bind(receiving, sending, error, now(), domain.id)
    .run();
  return getDomain(env, domain.id);
}
