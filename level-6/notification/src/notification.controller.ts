import {
  Body,
  Controller,
  Delete,
  Get,
  type MessageEvent,
  Param,
  Patch,
  Post,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import {
  NotificationService,
  type PushSubscriptionInput,
  type SendNotificationInput,
} from './notification.service.js';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'notification' };
  }

  @Get('vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: this.notificationService.getVapidPublicKey() };
  }

  @Post('subscribe')
  subscribe(@Body() body: PushSubscriptionInput) {
    return this.notificationService.subscribe(body);
  }

  @Delete('subscribe')
  unsubscribe(@Body('endpoint') endpoint: string) {
    return this.notificationService.unsubscribe(endpoint);
  }

  @Get()
  list() {
    return this.notificationService.listNotifications();
  }

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.notificationService.getStream();
  }

  @Post('send')
  send(@Body() body: SendNotificationInput) {
    return this.notificationService.notify(body);
  }

  @Patch('read-all')
  markAllRead() {
    return this.notificationService.markAllRead();
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.notificationService.markRead(id);
  }
}
