import {
  BadRequestException,
  Injectable,
  Logger,
  type MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { Observable, Subject } from 'rxjs';
import * as webPush from 'web-push';
import { DatabaseService } from './database.service.js';

export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'success' | 'error';
  domain?: string | null;
  read: boolean;
  createdAt: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface SendNotificationInput {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'error';
  domain?: string;
}

const NOTIFICATIONS_QUEUE = 'notifications';

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private readonly stream$ = new Subject<MessageEvent>();
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private vapidPublicKey = '';

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    this.initVapid();
    await this.connectRabbitWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    this.stream$.complete();
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private initVapid(): void {
    const existing = this.db.getVapidKeys();
    const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';

    if (existing) {
      this.vapidPublicKey = existing.public_key;
      webPush.setVapidDetails(existing.subject, existing.public_key, existing.private_key);
      this.logger.log('Loaded existing VAPID keys from SQLite');
      return;
    }

    const keys = webPush.generateVAPIDKeys();
    this.db.saveVapidKeys(keys.publicKey, keys.privateKey, subject);
    this.vapidPublicKey = keys.publicKey;
    webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    this.logger.log('Generated new VAPID keys and stored them in SQLite');
  }

  private async connectRabbitWithRetry(retries = 15, delayMs = 2000): Promise<void> {
    const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.connection = await amqp.connect(url);
        this.channel = await this.connection.createChannel();
        await this.channel.assertQueue(NOTIFICATIONS_QUEUE, { durable: true });

        await this.channel.consume(NOTIFICATIONS_QUEUE, async (msg) => {
          if (!msg) return;
          try {
            const payload = JSON.parse(msg.content.toString()) as SendNotificationInput;
            await this.notify(payload);
          } catch (err) {
            this.logger.error('Failed to process notification queue message', err);
          } finally {
            this.channel?.ack(msg);
          }
        });

        this.logger.log(`Connected to RabbitMQ and listening on ${NOTIFICATIONS_QUEUE}`);
        return;
      } catch (err) {
        this.logger.warn(
          `RabbitMQ connection attempt ${attempt}/${retries} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    this.logger.error('Could not connect to RabbitMQ after maximum retries');
  }

  getVapidPublicKey(): string {
    return this.vapidPublicKey;
  }

  subscribe(sub: PushSubscriptionInput): { subscribed: true } {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new BadRequestException('Invalid push subscription payload');
    }
    this.db.saveSubscription(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    this.logger.log(`Saved push subscription (${sub.endpoint.slice(0, 48)}...)`);
    return { subscribed: true };
  }

  unsubscribe(endpoint: string): { unsubscribed: true } {
    if (!endpoint) {
      throw new BadRequestException('Endpoint is required');
    }
    this.db.deleteSubscription(endpoint);
    return { unsubscribed: true };
  }

  listNotifications(): { items: InAppNotification[]; unreadCount: number } {
    const rows = this.db.listNotifications();
    const items: InAppNotification[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      type: (r.type as InAppNotification['type']) || 'info',
      domain: r.domain,
      read: r.read === 1,
      createdAt: r.created_at,
    }));
    const unreadCount = items.filter((n) => !n.read).length;
    return { items, unreadCount };
  }

  markRead(id: string): { ok: true } {
    this.db.markRead(id);
    return { ok: true };
  }

  markAllRead(): { ok: true } {
    this.db.markAllRead();
    return { ok: true };
  }

  getStream(): Observable<MessageEvent> {
    return this.stream$.asObservable();
  }

  async notify(input: SendNotificationInput): Promise<InAppNotification> {
    if (!input.title || !input.body) {
      throw new BadRequestException('Notification title and body are required');
    }

    const notification: InAppNotification = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      type: input.type ?? 'info',
      domain: input.domain ?? null,
      read: false,
      createdAt: new Date().toISOString(),
    };

    // 1. Persist in SQLite for in-app notifications
    this.db.insertNotification(notification);

    // 2. Emit live in-app SSE event
    this.stream$.next({ data: notification });

    // 3. Deliver Web Push to all subscribed browsers
    const subscriptions = this.db.listSubscriptions();
    const pushPayload = JSON.stringify({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      domain: notification.domain,
    });

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webPush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            pushPayload,
          );
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            this.db.deleteSubscription(sub.endpoint);
            this.logger.log('Removed expired push subscription');
          } else {
            this.logger.warn(
              `Web push delivery failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );

    return notification;
  }
}
