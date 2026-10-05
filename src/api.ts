import { QueryClient } from '@tanstack/react-query';
import type { User, Branding, Mailbox } from '../shared/types';
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 20_000, refetchOnWindowFocus: true },
  },
});
let csrf = '';
export class ApiException extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    file?: File | Blob;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.file
        ? { 'Content-Type': options.file.type || 'application/octet-stream' }
        : options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body:
      options.file ||
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal,
  });
  const data = (await response.json().catch(() => ({
    error: 'The server returned an unexpected response',
  }))) as { error?: string; code?: string; csrf?: string };
  if (!response.ok)
    throw new ApiException(
      data.error || 'Request failed',
      response.status,
      data.code,
    );
  if (data.csrf) csrf = data.csrf;
  return data as T;
}
export function setAuth(data: { user: User; csrf: string }) {
  csrf = data.csrf;
  queryClient.setQueryData(['auth'], data);
}
export function clearAuth() {
  csrf = '';
  queryClient.clear();
}
export async function invalidateMail() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['threads'] }),
    queryClient.invalidateQueries({ queryKey: ['thread'] }),
    queryClient.invalidateQueries({ queryKey: ['mailboxes'] }),
    queryClient.invalidateQueries({ queryKey: ['counts'] }),
    queryClient.invalidateQueries({ queryKey: ['drafts'] }),
    queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  ]);
}
export type Status = { hasOwner: boolean; branding: Branding; version: string };
export type AuthData = { user: User; csrf: string };
export function initials(name: string) {
  return (
    name
      .split(/[\s@]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((v) => v[0].toUpperCase())
      .join('') || '?'
  );
}
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
export function dateLabel(timestamp: number, timezone: string) {
  const date = new Date(timestamp),
    today = new Date();
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    ...(date.toDateString() === today.toDateString()
      ? { hour: 'numeric', minute: '2-digit' }
      : { day: 'numeric', month: 'short' }),
  }).format(date);
}
export function fullDate(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}
export function localDateTime(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function zonedTimestamp(value: string, timezone: string) {
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  let timestamp = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const rendered = localDateTime(timestamp, timezone);
    const [y, m, d, h, min] = rendered.split(/[-T:]/).map(Number);
    timestamp +=
      Date.UTC(year, month - 1, day, hour, minute) -
      Date.UTC(y, m - 1, d, h, min);
  }
  if (localDateTime(timestamp, timezone) !== value)
    throw new Error('That local time does not exist. Choose another time.');
  return timestamp;
}
export function primaryMailbox(boxes: Mailbox[], selected: string) {
  return (
    boxes.find((b) => b.id === selected && b.addresses.some((a) => a.active)) ||
    boxes.find(
      (b) => b.kind === 'private' && b.addresses.some((a) => a.active),
    ) ||
    boxes.find((b) => b.addresses.some((a) => a.active))
  );
}
