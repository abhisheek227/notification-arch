import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import amqp, { type Channel, type ChannelModel } from 'amqplib';

@Injectable()
export class RabbitMQService {
  private readonly logger = new Logger(RabbitMQService.name);

  private async connectQueue(url: string): Promise<ChannelModel> {
    if (!url || url.trim() === '') {
      throw new BadRequestException('RabbitMQ URL is required');
    }
    try {
      const connection = await amqp.connect(url);
      this.logger.log(`Connected to RabbitMQ at ${url}`);
      return connection;
    } catch (error) {
      throw new InternalServerErrorException(
        `Something went wrong while connecting to RabbitMQ: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async channel(
    connection: ChannelModel,
    queueName: string,
  ): Promise<Channel> {
    const ch = await connection.createChannel();
    await ch.assertQueue(queueName, { durable: true });
    return ch;
  }

  async connect(url: string): Promise<ChannelModel> {
    return this.connectQueue(url);
  }

  async createChannel(
    connection: ChannelModel,
    queueName: string,
  ): Promise<Channel> {
    return this.channel(connection, queueName);
  }
}
