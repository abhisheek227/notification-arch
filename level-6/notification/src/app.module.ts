import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseService } from './database.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';

@Module({
  imports: [],
  controllers: [AppController, NotificationController],
  providers: [AppService, DatabaseService, NotificationService],
})
export class AppModule {}
