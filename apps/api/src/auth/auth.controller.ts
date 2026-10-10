import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  changePasswordInput,
  disableMfaInput,
  loginInput,
  mfaVerifyInput,
  totpCodeInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Principal } from '../access/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AllowStates, CurrentPrincipal, Public, type AuthedRequest } from './decorators.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(204)
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const input = parse(loginInput, body);
    const { token } = await this.auth.login(input.username, input.password, {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    const policy = await this.settings.get('security.session');
    res.cookie(this.sessions.cookieName, token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: policy.absoluteHours * 3_600_000,
    });
  }

  @Post('logout')
  @HttpCode(204)
  @AllowStates('active', 'mfa_required', 'mfa_setup_required', 'password_change_required')
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(principal);
    res.clearCookie(this.sessions.cookieName, {
      path: '/',
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      httpOnly: true,
    });
  }

  @Get('session')
  @AllowStates('active', 'mfa_required', 'mfa_setup_required', 'password_change_required')
  session(@CurrentPrincipal() principal: Principal) {
    return this.auth.sessionInfo(principal);
  }

  @Post('password/change')
  @HttpCode(204)
  @AllowStates('active', 'password_change_required')
  async changePassword(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const input = parse(changePasswordInput, body);
    await this.auth.changePassword(principal, input.currentPassword, input.newPassword);
  }

  @Post('mfa/totp/setup')
  @AllowStates('active', 'mfa_setup_required')
  startTotp(@CurrentPrincipal() principal: Principal) {
    return this.auth.startTotpSetup(principal);
  }

  @Post('mfa/totp/confirm')
  @AllowStates('active', 'mfa_setup_required')
  confirmTotp(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.auth.confirmTotpSetup(principal, parse(totpCodeInput, body).code);
  }

  @Post('mfa/verify')
  @HttpCode(204)
  @AllowStates('mfa_required')
  async verifyMfa(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    await this.auth.verifyMfa(principal, parse(mfaVerifyInput, body));
  }

  @Post('mfa/totp/disable')
  @HttpCode(204)
  async disableTotp(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const input = parse(disableMfaInput, body);
    await this.auth.disableOwnTotp(principal, input.password, input.code);
  }

  @Get('sessions')
  mySessions(@CurrentPrincipal() principal: Principal) {
    return this.auth.listOwnSessions(principal);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeMySession(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    await this.auth.revokeOwnSession(principal, assertUuid(id, 'Session'));
  }
}
