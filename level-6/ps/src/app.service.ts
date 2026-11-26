import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ScanRequestMessage {
  id: string;
  domain: string;
}

export type ScanStage = 'domain_scanning' | 'dns_checking';
export type StageStatus = 'running' | 'completed' | 'failed';

export interface ScanEventMessage {
  id: string;
  domain: string;
  stage: ScanStage;
  status: StageStatus;
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
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connectWithRetry(retries = 15, delayMs = 2000): Promise<void> {
    const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.connection = await amqp.connect(url);
        this.channel = await this.connection.createChannel();
        await this.channel.assertQueue(SCAN_REQUESTS_QUEUE, { durable: true });
        await this.channel.assertQueue(SCAN_RESULTS_QUEUE, { durable: true });
        await this.channel.prefetch(1);

        await this.channel.consume(SCAN_REQUESTS_QUEUE, async (msg) => {
          if (!msg || !this.channel) return;
          try {
            const payload = JSON.parse(msg.content.toString()) as ScanRequestMessage;
            await this.handleScanRequest(payload);
          } catch (err) {
            this.logger.error('Failed to process scan request message', err);
          } finally {
            this.channel?.ack(msg);
          }
        });

        this.logger.log(
          `ps worker connected to RabbitMQ at ${url} and listening on ${SCAN_REQUESTS_QUEUE}`,
        );
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

  private async handleScanRequest(payload: ScanRequestMessage): Promise<void> {
    const { id, domain } = payload;
    this.logger.log(`Received scan request for ${domain} (id=${id})`);

    if (!DOMAIN_REGEX.test(domain)) {
      this.publishEvent({
        id,
        domain,
        stage: 'domain_scanning',
        status: 'failed',
        message: 'Invalid domain format',
        total: 0,
        subdomains: [],
        error: 'Invalid domain format',
      });
      return;
    }

    // Stage 1: Domain Scanning with Subfinder
    this.publishEvent({
      id,
      domain,
      stage: 'domain_scanning',
      status: 'running',
      message: `Scanning subdomains for ${domain} with subfinder...`,
    });

    let subdomains: string[] = [];
    try {
      const { stdout } = await execFileAsync('subfinder', ['-d', domain, '-silent'], {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      subdomains = Array.from(
        new Set(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      );

      this.logger.log(`Subfinder finished for ${domain}: ${subdomains.length} subdomains found`);
      this.publishEvent({
        id,
        domain,
        stage: 'domain_scanning',
        status: 'completed',
        message: `Domain scanning complete. Found ${subdomains.length} subdomains.`,
        total: subdomains.length,
        subdomains,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Subfinder failed for ${domain}: ${message}`);
      this.publishEvent({
        id,
        domain,
        stage: 'domain_scanning',
        status: 'failed',
        message: `Subfinder failed: ${message}`,
        total: 0,
        subdomains: [],
        error: message,
      });
      return;
    }

    // Stage 2: DNS Checking
    this.publishEvent({
      id,
      domain,
      stage: 'dns_checking',
      status: 'running',
      message: `Checking DNS records for ${subdomains.length} subdomains...`,
      total: subdomains.length,
      subdomains,
    });

    try {
      const resolvedSubdomains = await this.checkDns(id, domain, subdomains);
      this.logger.log(
        `DNS checking finished for ${domain}: ${resolvedSubdomains.length}/${subdomains.length} resolved`,
      );
      this.publishEvent({
        id,
        domain,
        stage: 'dns_checking',
        status: 'completed',
        message: `DNS checking complete. ${resolvedSubdomains.length} of ${subdomains.length} subdomains resolved.`,
        total: subdomains.length,
        subdomains,
        checkedCount: subdomains.length,
        resolvedCount: resolvedSubdomains.length,
        resolvedSubdomains,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`DNS checking failed for ${domain}: ${message}`);
      this.publishEvent({
        id,
        domain,
        stage: 'dns_checking',
        status: 'failed',
        message: `DNS checking failed: ${message}`,
        total: subdomains.length,
        subdomains,
        error: message,
      });
    }
  }

  private async checkDns(
    id: string,
    domain: string,
    subdomains: string[],
    concurrency = 10,
  ): Promise<string[]> {
    const resolved: string[] = [];
    let checked = 0;
    let index = 0;

    const worker = async () => {
      while (index < subdomains.length) {
        const current = subdomains[index++];
        let isResolved = false;
        try {
          await Promise.race([
            lookup(current),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('DNS timeout')), 3000),
            ),
          ]);
          resolved.push(current);
          isResolved = true;
        } catch {
          // Subdomain did not resolve
        }

        checked++;
        this.publishEvent({
          id,
          domain,
          stage: 'dns_checking',
          status: 'running',
          message: `DNS checking (${checked}/${subdomains.length}): ${current} → ${isResolved ? 'DNS OK' : 'No DNS'}`,
          total: subdomains.length,
          subdomains,
          checkedCount: checked,
          resolvedCount: resolved.length,
          resolvedSubdomains: [...resolved],
        });
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(subdomains.length, 1)) },
      () => worker(),
    );
    await Promise.all(workers);
    return resolved;
  }

  private publishEvent(event: Omit<ScanEventMessage, 'timestamp'>): void {
    const payload: ScanEventMessage = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.channel?.sendToQueue(
      SCAN_RESULTS_QUEUE,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true },
    );
  }

  getHello(): string {
    return 'ps subfinder worker is running';
  }
}
