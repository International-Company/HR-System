import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey, SessionState } from '@hrms/shared';
import type { Request } from 'express';
import type { Principal } from '../access/principal.js';

export const PUBLIC_KEY = 'hrms:public';
export const STATES_KEY = 'hrms:states';
export const PERMISSION_KEY = 'hrms:permission';

/** No session required. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Allow restricted session states (default: only 'active'). */
export const AllowStates = (...states: SessionState[]) => SetMetadata(STATES_KEY, states);

/**
 * Coarse check: the principal holds the permission in at least one scope.
 * Record-level scope checks happen in the service layer.
 */
export const RequirePermission = (perm: PermissionKey) => SetMetadata(PERMISSION_KEY, perm);

export interface AuthedRequest extends Request {
  principal?: Principal;
  sessionId?: string;
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.principal) throw new Error('No principal on request');
  return req.principal;
});
