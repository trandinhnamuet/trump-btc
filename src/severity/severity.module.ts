import { Module } from '@nestjs/common';
import { SeverityService } from './severity.service';

@Module({
  providers: [SeverityService],
  exports: [SeverityService],
})
export class SeverityModule {}
