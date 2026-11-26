import {
  Body,
  Controller,
  Get,
  type MessageEvent,
  NotFoundException,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AppService, type ScanRecord } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'dev' };
  }

  @Post('scan')
  startScan(@Body('domain') domain: string): ScanRecord {
    return this.appService.startScan(domain ?? '');
  }

  @Sse('scan/:id/events')
  streamScanEvents(@Param('id') id: string): Observable<MessageEvent> {
    return this.appService.getScanEvents(id);
  }

  @Get('scan/:id')
  getScan(@Param('id') id: string): ScanRecord {
    const scan = this.appService.getScan(id);
    if (!scan) {
      throw new NotFoundException(`Scan ${id} not found`);
    }
    return scan;
  }

  @Get('scans')
  listScans(): ScanRecord[] {
    return this.appService.listScans();
  }
}
