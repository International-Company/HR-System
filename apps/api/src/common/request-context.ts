import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../access/principal.js';

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  principal?: Principal;
  sessionId?: string;
  actorUserId?: string;
  actorUsername?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
};
