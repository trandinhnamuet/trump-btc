import { Module } from '@nestjs/common';
import { CalibrationModule } from '../calibration/calibration.module';
import { MarketSignalModule } from '../market-signal/market-signal.module';
import { SeverityModule } from '../severity/severity.module';
import { AnalysisService } from './analysis.service';
import { EnsembleService } from './ensemble.service';

@Module({
  imports: [MarketSignalModule, SeverityModule, CalibrationModule],
  providers: [AnalysisService, EnsembleService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
