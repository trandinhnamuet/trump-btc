import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { MarketSignalModule } from '../market-signal/market-signal.module';

@Module({
  imports: [MarketSignalModule],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}

