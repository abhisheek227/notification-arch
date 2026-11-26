import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface VapidKeysRow {
  public_key: string;
  private_key: string;
  subject: string;
  created_at: string;
}

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  title: string;
  body: string;
  type: string;
  domain: string | null;
  read: number;
  created_at: string;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: DatabaseSync;

  onModuleInit(): void {
    const dbPath = process.env.DB_PATH ?? './data/notifications.db';
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        domain TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    this.logger.log(`SQLite initialized at ${dbPath}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  getVapidKeys(): VapidKeysRow | undefined {
    const row = this.db
      .prepare('SELECT public_key, private_key, subject, created_at FROM vapid_keys WHERE id = 1')
      .get();
    return row as VapidKeysRow | undefined;
  }

  saveVapidKeys(publicKey: string, privateKey: string, subject: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO vapid_keys (id, public_key, private_key, subject, created_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(publicKey, privateKey, subject, new Date().toISOString());
  }

  saveSubscription(endpoint: string, p256dh: string, auth: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(endpoint, p256dh, auth, new Date().toISOString());
  }

  deleteSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  listSubscriptions(): PushSubscriptionRow[] {
    return this.db
      .prepare('SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions')
      .all() as unknown as PushSubscriptionRow[];
  }

  insertNotification(item: {
    id: string;
    title: string;
    body: string;
    type: string;
    domain?: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO notifications (id, title, body, type, domain, read, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(item.id, item.title, item.body, item.type, item.domain ?? null, item.createdAt);
  }

  listNotifications(limit = 50): NotificationRow[] {
    return this.db
      .prepare(
        `SELECT id, title, body, type, domain, read, created_at
         FROM notifications
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as NotificationRow[];
  }

  markRead(id: string): void {
    this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  }

  markAllRead(): void {
    this.db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  }
}
