import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { SeverityModule } from '../severity/severity.module';
import { MarketSignalModule } from '../market-signal/market-signal.module';

@Module({
  imports: [SeverityModule, MarketSignalModule],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
