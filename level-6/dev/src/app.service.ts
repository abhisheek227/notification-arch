import {
  BadRequestException,
  Injectable,
  Logger,
  type MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { type Channel, type ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { Observable, Subject } from 'rxjs';
import { RabbitMQService } from './rabitmq/rabitmq.service.js';

export type ScanStage = 'domain_scanning' | 'dns_checking';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ScanRecord {
  id: string;
  domain: string;
  status: 'queued' | 'scanning' | 'completed' | 'failed';
  currentStage: ScanStage | null;
  stages: {
    domain_scanning: StageStatus;
    dns_checking: StageStatus;
  };
  message: string;
  total: number;
  subdomains: string[];
  checkedCount: number;
  resolvedCount: number;
  resolvedSubdomains: string[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

interface ScanEventMessage {
  id: string;
  domain: string;
  stage: ScanStage;
  status: 'running' | 'completed' | 'failed';
  message: string;
  total?: number;
  subdomains?: string[];
  checkedCount?: number;
  resolvedCount?: number;
  resolvedSubdomains?: string[];
  error?: string;
  timestamp: string;
}

const SCAN_REQUESTS_QUEUE = 'scan_requests';
const SCAN_RESULTS_QUEUE = 'scan_results';
const NOTIFICATIONS_QUEUE = 'notifications';
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly scans = new Map<string, ScanRecord>();
  private readonly streams = new Map<string, Subject<MessageEvent>>();

  constructor(private readonly rabbitMq: RabbitMQService) {}

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    for (const subject of this.streams.values()) {
      subject.complete();
    }
    this.streams.clear();
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connectWithRetry(retries = 15, delayMs = 2000): Promise<void> {
    const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.connection = await this.rabbitMq.connect(url);
        this.channel = await this.rabbitMq.createChannel(
          this.connection,
          SCAN_REQUESTS_QUEUE,
        );
        await this.channel.assertQueue(SCAN_RESULTS_QUEUE, { durable: true });
        await this.channel.assertQueue(NOTIFICATIONS_QUEUE, { durable: true });

        await this.channel.consume(SCAN_RESULTS_QUEUE, (msg) => {
          if (!msg) return;
          try {
            const event = JSON.parse(msg.content.toString()) as ScanEventMessage;
            this.handlePsSignal(event);
          } catch (err) {
            this.logger.error('Failed to process scan event message', err);
          } finally {
            this.channel?.ack(msg);
          }
        });

        this.logger.log(`Connected to RabbitMQ at ${url}`);
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

  private handlePsSignal(event: ScanEventMessage): void {
    let record = this.scans.get(event.id);
    if (!record) {
      record = {
        id: event.id,
        domain: event.domain,
        status: 'scanning',
        currentStage: event.stage,
        stages: {
          domain_scanning: 'pending',
          dns_checking: 'pending',
        },
        message: event.message,
        total: 0,
        subdomains: [],
        checkedCount: 0,
        resolvedCount: 0,
        resolvedSubdomains: [],
        createdAt: event.timestamp ?? new Date().toISOString(),
      };
      this.scans.set(event.id, record);
    }

    record.currentStage = event.stage;
    record.stages[event.stage] = event.status;
    record.message = event.message;

    if (event.total !== undefined) record.total = event.total;
    if (event.subdomains !== undefined) record.subdomains = event.subdomains;
    if (event.checkedCount !== undefined) record.checkedCount = event.checkedCount;
    if (event.resolvedCount !== undefined) record.resolvedCount = event.resolvedCount;
    if (event.resolvedSubdomains !== undefined) {
      record.resolvedSubdomains = event.resolvedSubdomains;
    }
    if (event.error !== undefined) record.error = event.error;

    if (event.status === 'failed') {
      record.status = 'failed';
      record.completedAt = new Date().toISOString();
      this.channel?.sendToQueue(
        NOTIFICATIONS_QUEUE,
        Buffer.from(
          JSON.stringify({
            title: `Scan Failed: ${record.domain}`,
            body: record.error ?? 'An error occurred during scanning.',
            type: 'error',
            domain: record.domain,
          }),
        ),
        { persistent: true },
      );
    } else if (event.stage === 'dns_checking' && event.status === 'completed') {
      record.status = 'completed';
      record.completedAt = new Date().toISOString();
      this.channel?.sendToQueue(
        NOTIFICATIONS_QUEUE,
        Buffer.from(
          JSON.stringify({
            title: `Scan Complete: ${record.domain}`,
            body: `Found ${record.total} subdomains (${record.resolvedCount} DNS resolved).`,
            type: 'success',
            domain: record.domain,
          }),
        ),
        { persistent: true },
      );
    } else {
      record.status = 'scanning';
    }

    this.logger.log(
      `Received PS signal for ${event.domain} [${event.stage}:${event.status}] -> forwarding via SSE`,
    );

    const subject = this.streams.get(event.id);
    if (subject) {
      subject.next({ data: record });
      if (record.status === 'completed' || record.status === 'failed') {
        subject.complete();
        this.streams.delete(event.id);
      }
    }
  }

  private normalizeDomain(raw: string): string {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');

    if (!cleaned || !DOMAIN_REGEX.test(cleaned)) {
      throw new BadRequestException('Please provide a valid domain name (e.g. example.com)');
    }

    return cleaned;
  }

  startScan(rawDomain: string): ScanRecord {
    const domain = this.normalizeDomain(rawDomain);
    if (!this.channel) {
      throw new BadRequestException('RabbitMQ is not connected yet. Please try again.');
    }

    const record: ScanRecord = {
      id: randomUUID(),
      domain,
      status: 'queued',
      currentStage: null,
      stages: {
        domain_scanning: 'pending',
        dns_checking: 'pending',
      },
      message: `Queued scan for ${domain}...`,
      total: 0,
      subdomains: [],
      checkedCount: 0,
      resolvedCount: 0,
      resolvedSubdomains: [],
      createdAt: new Date().toISOString(),
    };

    this.scans.set(record.id, record);
    this.streams.set(record.id, new Subject<MessageEvent>());

    this.channel.sendToQueue(
      SCAN_REQUESTS_QUEUE,
      Buffer.from(JSON.stringify({ id: record.id, domain: record.domain })),
      { persistent: true },
    );

    this.logger.log(`Dispatched scan signal for ${domain} (id=${record.id})`);
    return record;
  }

  getScanEvents(id: string): Observable<MessageEvent> {
    const record = this.scans.get(id);
    let subject = this.streams.get(id);

    return new Observable<MessageEvent>((subscriber) => {
      if (record) {
        subscriber.next({ data: record });
        if (record.status === 'completed' || record.status === 'failed') {
          subscriber.complete();
          return;
        }
      }

      if (!subject) {
        subject = new Subject<MessageEvent>();
        this.streams.set(id, subject);
      }

      const subscription = subject.subscribe(subscriber);
      return () => subscription.unsubscribe();
    });
  }

  getScan(id: string): ScanRecord | undefined {
    return this.scans.get(id);
  }

  listScans(): ScanRecord[] {
    return Array.from(this.scans.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
