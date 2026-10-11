import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  correctionInput,
  deviceWebauthnVerifyInput,
  devicePinInput,
  networkRangeInput,
  punchInput,
  reviewInput,
} from '@hrms/shared';
import { assertUuid, parse } from '../common/errors.js';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, Public, RequirePermission, type AuthedRequest } from '../auth/decorators.js';
import { AttendanceService, type ClientMeta } from './attendance.service.js';
import { DevicesService } from './devices.service.js';

const rangeQuery = z.object({ from: z.iso.date(), to: z.iso.date() });

@Controller()
export class AttendanceController {
  constructor(
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Relying party for WebAuthn: the public URL when configured, otherwise the host the
   * browser used. Credentials are bound to this host name (Q-04).
   */
  private meta(req: AuthedRequest): ClientMeta {
    const url = this.config.PUBLIC_URL ? new URL(this.config.PUBLIC_URL) : null;
    const host = url?.host ?? req.get('host') ?? 'localhost';
    const protocol = url ? url.protocol.replace(':', '') : req.protocol;
    return {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      rpId: (url?.hostname ?? host).split(':')[0]!,
      origin: `${protocol}://${host}`,
    };
  }

  /** Shows the caller's own address as the server sees it (helps HR configure networks). */
  @Public()
  @Get('network/whoami')
  whoami(@Req() req: AuthedRequest) {
    // TEMPORARY proxy spike (P4): echoes the caller's own forwarding headers; removed after measurement.
    const h = req.headers;
    return { ip: req.ip ?? null, ips: req.ips, xff: h['x-forwarded-for'] ?? null, xri: h['x-real-ip'] ?? null, socket: req.socket.remoteAddress ?? null };
  }

  @Get('attendance/today')
  today(@CurrentPrincipal() p: Principal, @Req() req: AuthedRequest) {
    return this.attendance.today(p, this.meta(req));
  }

  @Post('attendance/punch-options')
  punchOptions(@CurrentPrincipal() p: Principal, @Req() req: AuthedRequest) {
    return this.devices.authenticationOptions(p, this.meta(req));
  }

  @Post('attendance/punch')
  punch(@CurrentPrincipal() p: Principal, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.attendance.punch(p, parse(punchInput, body), this.meta(req));
  }

  @Get('attendance/employees/:id/days')
  days(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(rangeQuery, query);
    return this.attendance.days(p, assertUuid(id, 'Employee'), q.from, q.to);
  }

  @Get('attendance/review')
  @RequirePermission('attendance.review')
  review(@CurrentPrincipal() p: Principal, @Query('companyId') companyId: string, @Query() query: unknown) {
    const q = parse(rangeQuery, query);
    return this.attendance.review(p, assertUuid(companyId ?? '', 'Company'), q.from, q.to);
  }

  @Post('attendance/employees/:id/days/:date/review')
  @HttpCode(204)
  @RequirePermission('attendance.review')
  async reviewDay(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('date') date: string, @Body() body: unknown) {
    const input = parse(reviewInput, body);
    const d = parse(z.iso.date(), date);
    await this.attendance.reviewDay(p, assertUuid(id, 'Employee'), d, input.action, input.note);
  }

  @Get('attendance/employees/:id/corrections')
  corrections(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.attendance.listCorrections(p, assertUuid(id, 'Employee'));
  }

  @Post('attendance/corrections')
  requestCorrection(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.attendance.requestCorrection(p, parse(correctionInput, body));
  }

  // --- networks -------------------------------------------------------------------------

  @Get('attendance/networks')
  networks(@CurrentPrincipal() p: Principal, @Query('companyId') companyId: string) {
    return this.attendance.listNetworks(p, assertUuid(companyId ?? '', 'Company'));
  }

  @Post('attendance/networks')
  @RequirePermission('attendance.network.manage')
  addNetwork(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.attendance.addNetwork(p, parse(networkRangeInput, body));
  }

  @Post('attendance/networks/:id/deactivate')
  @HttpCode(204)
  @RequirePermission('attendance.network.manage')
  async removeNetwork(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.attendance.deactivateNetwork(p, assertUuid(id, 'Network'));
  }

  // --- devices ----------------------------------------------------------------------------

  @Get('attendance/devices/mine')
  myDevices(@CurrentPrincipal() p: Principal) {
    return this.devices.myDevices(p);
  }

  @Post('attendance/devices/pin')
  registerPin(@CurrentPrincipal() p: Principal, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(devicePinInput, body);
    return this.devices.registerPin(p, input.label, input.pin, req.headers['user-agent'] ?? null);
  }

  @Post('attendance/devices/webauthn/options')
  registrationOptions(@CurrentPrincipal() p: Principal, @Req() req: AuthedRequest) {
    return this.devices.registrationOptions(p, { rpId: this.meta(req).rpId, rpName: 'HRMS' });
  }

  @Post('attendance/devices/webauthn/verify')
  verifyRegistration(@CurrentPrincipal() p: Principal, @Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(deviceWebauthnVerifyInput, body);
    return this.devices.verifyRegistration(p, input.label, input.response, this.meta(req), req.headers['user-agent'] ?? null);
  }

  @Get('attendance/devices')
  @RequirePermission('attendance.device.manage')
  companyDevices(@CurrentPrincipal() p: Principal, @Query('companyId') companyId: string) {
    return this.devices.companyDevices(p, assertUuid(companyId ?? '', 'Company'));
  }

  @Post('attendance/devices/:id/approve')
  @HttpCode(204)
  @RequirePermission('attendance.device.manage')
  async approve(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.devices.setStatus(p, assertUuid(id, 'Device'), 'approve');
  }

  @Post('attendance/devices/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.devices.setStatus(p, assertUuid(id, 'Device'), 'revoke');
  }
}
