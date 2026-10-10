import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { NotificationDto } from '@hrms/shared';
import { CONFIG, DATABASE, ENCRYPTOR } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { notification, notificationRecipient, pushSubscription, systemSecret } from '../db/schema.js';
import type { Encryptor } from '../common/crypto.js';
import { ApiError } from '../common/errors.js';
import { uuidv7 } from '../common/ids.js';
import type { Principal } from '../access/principal.js';

export interface NotifyInput {
  userIds: string[];
  companyId?: string | null;
  eventType: string;
  title: { ar: string; en: string };
  body?: { ar: string; en: string };
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export const PUSH_SENDER = 'PUSH_SENDER';

/** Delivery port for Web Push (replaced by a fake in tests). */
export interface PushSender {
  send(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: string,
    vapid: { subject: string; publicKey: string; privateKey: string },
  ): Promise<'ok' | 'gone' | 'error'>;
}

export class WebPushSender implements PushSender {
  async send(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: string,
    vapid: { subject: string; publicKey: string; privateKey: string },
  ): Promise<'ok' | 'gone' | 'error'> {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        vapidDetails: vapid,
        TTL: 24 * 3600,
        timeout: 10_000,
      });
      return 'ok';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? 'gone' : 'error';
    }
  }
}

/**
 * Notification centre (NOT-01..06). Notifications are created inside the business
 * transaction; push delivery is done by the worker afterwards. E-mail is not sent in this
 * release (NOT-05): see MailPort.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(ENCRYPTOR) private readonly encryptor: Encryptor,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  async notify(tx: Tx, input: NotifyInput): Promise<string | null> {
    const userIds = [...new Set(input.userIds.filter(Boolean))];
    if (!userIds.length) return null;
    const id = uuidv7();
    await tx.insert(notification).values({
      id,
      companyId: input.companyId ?? null,
      eventType: input.eventType,
      titleAr: input.title.ar,
      titleEn: input.title.en,
      bodyAr: input.body?.ar ?? '',
      bodyEn: input.body?.en ?? '',
      link: input.link ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    });
    await tx.insert(notificationRecipient).values(userIds.map((userId) => ({ notificationId: id, userId })));
    return id;
  }

  async list(principal: Principal, opts: { unreadOnly: boolean; before?: string }): Promise<NotificationDto[]> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .select({ n: notification, r: notificationRecipient })
        .from(notificationRecipient)
        .innerJoin(notification, eq(notification.id, notificationRecipient.notificationId))
        .where(
          and(
            eq(notificationRecipient.userId, principal.userId),
            opts.unreadOnly ? isNull(notificationRecipient.readAt) : undefined,
            opts.before ? lt(notification.id, opts.before) : undefined,
          ),
        )
        .orderBy(desc(notification.id))
        .limit(50);
      return rows.map(({ n, r }) => ({
        id: n.id,
        eventType: n.eventType,
        title: { ar: n.titleAr, en: n.titleEn },
        body: { ar: n.bodyAr, en: n.bodyEn },
        link: n.link,
        createdAt: n.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      }));
    });
  }

  async unreadCount(principal: Principal): Promise<number> {
    const [r] = await this.database.tx(principal.rls(), (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notificationRecipient)
        .where(and(eq(notificationRecipient.userId, principal.userId), isNull(notificationRecipient.readAt))),
    );
    return r?.n ?? 0;
  }

  async markRead(principal: Principal, ids: string[] | 'all'): Promise<number> {
    return this.database.tx(principal.rls(), async (tx) => {
      const rows = await tx
        .update(notificationRecipient)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationRecipient.userId, principal.userId),
            isNull(notificationRecipient.readAt),
            ids === 'all' ? undefined : inArray(notificationRecipient.notificationId, ids),
          ),
        )
        .returning({ id: notificationRecipient.notificationId });
      return rows.length;
    });
  }

  // --- Web Push ---------------------------------------------------------------------------

  /** VAPID keys are generated once and stored encrypted (no manual setup needed). */
  async vapidKeys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
    const subject = this.config.PUBLIC_URL ?? 'mailto:admin@example.invalid';
    const read = async () => {
      const [row] = await this.database.system((tx) => tx.select().from(systemSecret).where(eq(systemSecret.key, 'vapid')));
      return row ? (JSON.parse(this.encryptor.decryptString(row.valueEnc, 'secret:vapid')) as { publicKey: string; privateKey: string }) : null;
    };
    const existing = await read();
    if (existing) return { ...existing, subject };
    const keys = webpush.generateVAPIDKeys();
    await this.database.system((tx) =>
      tx
        .insert(systemSecret)
        .values({ key: 'vapid', valueEnc: this.encryptor.encrypt(JSON.stringify(keys), 'secret:vapid') })
        .onConflictDoNothing(),
    );
    return { ...(await read())!, subject };
  }

  async subscribe(principal: Principal, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null) {
    await this.database.tx(principal.rls(), async (tx) => {
      // An endpoint belongs to one browser: re-subscribing moves it to the current user.
      const updated = await tx
        .update(pushSubscription)
        .set({ userId: principal.userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, revokedAt: null, failureCount: 0 })
        .where(and(eq(pushSubscription.endpoint, sub.endpoint), eq(pushSubscription.userId, principal.userId)))
        .returning({ id: pushSubscription.id });
      if (!updated.length) {
        await tx.insert(pushSubscription).values({
          id: uuidv7(),
          userId: principal.userId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          userAgent: userAgent?.slice(0, 300) ?? null,
        });
      }
    }).catch((err: unknown) => {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw ApiError.conflict('This browser is registered to another account; sign out there first');
      }
      throw err;
    });
  }

  async unsubscribe(principal: Principal, endpoint: string) {
    await this.database.tx(principal.rls(), (tx) =>
      tx
        .update(pushSubscription)
        .set({ revokedAt: new Date() })
        .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, principal.userId))),
    );
  }

  /** Worker: deliver pending notifications to registered browsers. Returns deliveries made. */
  async dispatchPush(limit = 200): Promise<number> {
    const pending = await this.database.system((tx) =>
      tx
        .select({ r: notificationRecipient, n: notification })
        .from(notificationRecipient)
        .innerJoin(notification, eq(notification.id, notificationRecipient.notificationId))
        .where(and(isNull(notificationRecipient.pushSentAt), isNull(notificationRecipient.readAt)))
        .limit(limit),
    );
    if (!pending.length) return 0;
    const vapid = await this.vapidKeys();
    let sent = 0;
    for (const { r, n } of pending) {
      const subs = await this.database.system((tx) =>
        tx.select().from(pushSubscription).where(and(eq(pushSubscription.userId, r.userId), isNull(pushSubscription.revokedAt))),
      );
      // Payload contains only titles and a relative link; no personal data beyond the title.
      const payload = JSON.stringify({ id: n.id, title: { ar: n.titleAr, en: n.titleEn }, link: n.link ?? '/notifications' });
      for (const s of subs) {
        const result = await this.push.send(s, payload, vapid);
        await this.database.system((tx) =>
          tx
            .update(pushSubscription)
            .set(
              result === 'ok'
                ? { lastSuccessAt: new Date(), failureCount: 0 }
                : result === 'gone'
                  ? { revokedAt: new Date() }
                  : { failureCount: sql`${pushSubscription.failureCount} + 1` },
            )
            .where(eq(pushSubscription.id, s.id)),
        );
        if (result === 'ok') sent++;
      }
      await this.database.system((tx) =>
        tx
          .update(notificationRecipient)
          .set({ pushSentAt: new Date() })
          .where(and(eq(notificationRecipient.notificationId, r.notificationId), eq(notificationRecipient.userId, r.userId))),
      );
    }
    if (sent) this.logger.log(`Delivered ${sent} push notification(s)`);
    return sent;
  }
}

/**
 * E-mail delivery port (NOT-05). The initial release ships only this disabled adapter, which
 * records nothing and sends nothing. Activating SMTP later means adding an adapter behind
 * this interface and a configuration switch, with owner approval.
 */
export interface MailPort {
  readonly enabled: boolean;
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export class DisabledMailer implements MailPort {
  readonly enabled = false;
  async send(): Promise<void> {
    // Intentionally a no-op: e-mail is out of scope for the initial release.
  }
}
