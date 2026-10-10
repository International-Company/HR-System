import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey, SessionState } from '@hrms/shared';
import { ApiError } from '../common/errors.js';
import { requestContext } from '../common/request-context.js';
import { PolicyService } from '../access/policy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionService } from './session.service.js';
import {
  PERMISSION_KEY,
  PUBLIC_KEY,
  STATES_KEY,
  type AuthedRequest,
} from './decorators.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard (RBAC-05): every route requires an authenticated session unless marked
 * @Public. Enforces session state, CSRF on state-changing requests and the coarse
 * permission check.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[this.sessions.cookieName];
    const resolved = await this.sessions.resolve(token);
    if (!resolved) throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in');
    const { session, user } = resolved;

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (!this.sessions.checkCsrf(session.id, typeof header === 'string' ? header : undefined)) {
        throw new ApiError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
      }
    }

    const mfa = await this.settings.get('security.mfa');
    const principal = await this.policy.loadPrincipal(user, session.id, (roleKeys) =>
      this.sessions.computeState(user, session, roleKeys, mfa.requiredForRoles),
    );
    req.principal = principal;
    req.sessionId = session.id;
    const ctx = requestContext.get();
    if (ctx) {
      ctx.principal = principal;
      ctx.sessionId = session.id;
      ctx.actorUserId = user.id;
      ctx.actorUsername = user.username;
    }

    const allowed = this.reflector.getAllAndOverride<SessionState[]>(STATES_KEY, targets) ?? [
      'active',
    ];
    if (!allowed.includes(principal.state)) {
      throw new ApiError(403, 'SESSION_STATE', 'Complete the required sign-in step first', {
        meta: { state: principal.state },
      });
    }

    const perm = this.reflector.getAllAndOverride<PermissionKey>(PERMISSION_KEY, targets);
    if (perm && !principal.has(perm)) {
      await this.audit.recordStandalone({
        action: 'access.denied',
        outcome: 'denied',
        details: { permission: perm, method: req.method, path: req.route?.path ?? req.path },
      });
      throw ApiError.forbidden();
    }
    return true;
  }
}
