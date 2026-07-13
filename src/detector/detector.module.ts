import { Module } from '@nestjs/common';
import { DetectorService } from './detector.service';

@Module({
  providers: [DetectorService],
  exports: [DetectorService],
})
export class DetectorModule {}
