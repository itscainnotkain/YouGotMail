import type { User } from '../shared/types';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  EMAIL?: SendEmail;
  JOBS: Queue;
  LIVE: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  SETUP_TOKEN: string;
  APP_KEY: string;
  WORKER_NAME: string;
}
export type AppEnv = {
  Bindings: Env;
  Variables: { user: User; session: { id: string; csrf: string } };
};
export type Task =
  { kind: 'ingest'; id: string } | { kind: 'send'; id: string };

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}
