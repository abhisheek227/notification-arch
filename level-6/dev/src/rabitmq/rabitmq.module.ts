import { Module } from '@nestjs/common';
import { RabbitMQ } from './rabitmq.controller.js';
import { RabbitMQService } from './rabitmq.service.js';

@Module({
  imports: [],
  controllers: [RabbitMQ],
  providers: [RabbitMQService],
  exports: [RabbitMQService],
})
export class RabbitMQModule {}
