import { Injectable, Logger } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel } from 'amqplib';



const SCAN_REQUESTS_QUEUE = 'scan_requests';
const SCAN_RESULTS_QUEUE = 'scan_results';
const SCAN_COMPLETED_QUEUE = "scan_completed"
const SCAN_VULNERABILITY_FOUND = "scan_vulnerability_found";


@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null


  private async connectRabbitMq() {
    const url = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
    try {
      this.connection = await amqp.connect(url)
      this.channel = await this.connection.createChannel();
      await this.channel.assertQueue(SCAN_COMPLETED_QUEUE, { durable: true })
      await this.channel.assertQueue(SCAN_REQUESTS_QUEUE, { durable: true });
      await this.channel.assertQueue(SCAN_RESULTS_QUEUE, { durable: true });
      await this.channel.assertQueue(SCAN_VULNERABILITY_FOUND, { durable: true });
      await this.channel.prefetch(1)

      await this.channel.consume(SCAN_COMPLETED_QUEUE, async (msg) => {
        if (!msg || !this.channel) return;
        try {
        } catch (error) {
          
        }
      })
    } catch (error) {

    }
  }
  getHello(): string {
    return 'Hello World!';
  }
}
