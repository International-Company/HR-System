import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { pushSubscriptionInput } from '@hrms/shared';
import { parse } from '../common/errors.js';
import type { Principal } from '../access/principal.js';
import { CurrentPrincipal, type AuthedRequest } from '../auth/decorators.js';
import { NotificationsService } from './notifications.service.js';

const readInput = z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() });

/** Personal notification centre: every user sees only their own notifications. */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query('unread') unread?: string, @Query('before') before?: string) {
    return this.notifications.list(p, {
      unreadOnly: unread === 'true',
      ...(before && /^[0-9a-f-]{36}$/i.test(before) ? { before } : {}),
    });
  }

  @Get('unread-count')
  async unreadCount(@CurrentPrincipal() p: Principal) {
    return { count: await this.notifications.unreadCount(p) };
  }

  @Post('read')
  async read(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const input = parse(readInput, body);
    return { updated: await this.notifications.markRead(p, input.all ? 'all' : (input.ids ?? [])) };
  }

  @Get('push/public-key')
  async publicKey() {
    return { publicKey: (await this.notifications.vapidKeys()).publicKey };
  }

  @Post('push/subscribe')
  @HttpCode(204)
  async subscribe(@CurrentPrincipal() p: Principal, @Body() body: unknown, @Req() req: AuthedRequest) {
    await this.notifications.subscribe(p, parse(pushSubscriptionInput, body), req.headers['user-agent'] ?? null);
  }

  @Post('push/unsubscribe')
  @HttpCode(204)
  async unsubscribe(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    await this.notifications.unsubscribe(p, parse(z.object({ endpoint: z.url() }), body).endpoint);
  }
}
