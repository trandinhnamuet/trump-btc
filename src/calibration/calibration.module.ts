import { Module } from '@nestjs/common';
import { CalibrationService } from './calibration.service';

@Module({
  providers: [CalibrationService],
  exports: [CalibrationService],
})
export class CalibrationModule {}
