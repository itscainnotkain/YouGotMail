import type { Env } from './env';
import { AppError } from './env';
import { getIntegration } from './crypto';

export type CloudflareConnection = {
  token: string;
  accountId: string;
  workerName: string;
  queueId: string;
};
export type ResendConnection = {
  token: string;
  webhookId?: string;
  webhookSecret?: string;
};
export type DnsRecord = {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
  locked?: boolean;
};
export async function cf<T>(
  env: Env,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const config = await getIntegration<CloudflareConnection>(env, 'cloudflare');
  if (!config)
    throw new AppError(
      400,
      'Connect your Cloudflare account first',
      'NOT_CONNECTED',
    );
  return cfWithToken<T>(config.token, path, method, data);
}
export async function cfWithToken<T>(
  token: string,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: { message: string; code: number }[];
  };
  if (!response.ok || !result.success)
    throw new AppError(
      400,
      result.errors?.map((e) => e.message).join('; ') ||
        'Cloudflare could not complete this request',
      'CLOUDFLARE',
    );
  return result.result;
}
export async function cfList<T>(env: Env, path: string) {
  const connection = await getIntegration<CloudflareConnection>(
    env,
    'cloudflare',
  );
  if (!connection)
    throw new AppError(400, 'Connect your Cloudflare account first');
  return cfListWithToken<T>(connection.token, path);
}
export async function cfListWithToken<T>(token: string, path: string) {
  const url = new URL(path, 'https://api.cloudflare.com');
  url.searchParams.set('per_page', '50');
  const rows: T[] = [];
  for (let page = 1; page <= 100; page++) {
    url.searchParams.set('page', String(page));
    const items = await cfWithToken<T[]>(token, `${url.pathname}${url.search}`);
    rows.push(...items);
    if (items.length < 50) return rows;
  }
  throw new AppError(
    400,
    'This account has too many records to review in one request. Use a token scoped to the domains you want to configure.',
  );
}
export async function resend<T>(
  env: Env,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const config = await getIntegration<ResendConnection>(env, 'resend');
  if (!config) throw new AppError(400, 'Connect Resend first', 'NOT_CONNECTED');
  return resendWithToken<T>(config.token, path, method, data);
}
export async function resendWithToken<T>(
  token: string,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new AppError(
      400,
      result.message || 'Resend could not complete this request',
      'RESEND',
    );
  return result;
}
export async function dnsAnswers(name: string, type: string) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error('DNS lookup failed');
  const data = (await response.json()) as {
    Answer?: { data: string; type: number }[];
  };
  return (data.Answer || []).map((r) =>
    r.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''),
  );
}
