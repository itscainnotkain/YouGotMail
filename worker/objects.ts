import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export class MailboxLive extends DurableObject<Env> {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === '/notify') {
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(
            JSON.stringify({ type: 'mailbox.updated', at: Date.now() }),
          );
        } catch {
          socket.close();
        }
      }
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair();
    const tags = [request.headers.get('x-session-id') || 'unknown'];
    this.ctx.acceptWebSocket(pair[1], tags);
    // Every socket expires with its session; refresh is handled by the client.
    pair[1].serializeAttachment({
      session: tags[0],
      expires: Number(request.headers.get('x-session-expires')),
      user: request.headers.get('x-user-id'),
      mailbox: request.headers.get('x-mailbox-id'),
    });
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async alarm() {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      const data = socket.deserializeAttachment() as {
        session: string;
        expires: number;
        user: string;
        mailbox: string;
      };
      if (
        !(await this.env.DB.prepare(
          'SELECT 1 FROM mailbox_members WHERE user_id=? AND mailbox_id=?',
        )
          .bind(data.user, data.mailbox)
          .first())
      ) {
        socket.close(1008, 'Mailbox access revoked');
        continue;
      }
      if (
        data.expires <= Date.now() ||
        !(await this.env.DB.prepare(
          'SELECT 1 FROM sessions WHERE id=? AND expires_at>? AND user_id IN (SELECT id FROM users WHERE disabled=0)',
        )
          .bind(data.session, Date.now())
          .first())
      )
        socket.close(1008, 'Session expired');
    }
    if (this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong');
  }
  webSocketClose(socket: WebSocket) {
    socket.close();
  }
}
export class RateLimiter extends DurableObject<Env> {
  async fetch(request: Request) {
    const { limit, window } = (await request.json()) as {
      limit: number;
      window: number;
    };
    const time = Date.now();
    const allowed = await this.ctx.storage.transaction(async (tx) => {
      const old = await tx.get<{ count: number; reset: number }>('state');
      const state =
        old && old.reset > time ? old : { count: 0, reset: time + window };
      state.count++;
      await tx.put('state', state);
      return state.count <= limit;
    });
    await this.ctx.storage.setAlarm(time + window);
    return new Response(null, { status: allowed ? 204 : 429 });
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
