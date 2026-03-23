import { Module } from '@nestjs/common';
import { MarketSignalService } from './market-signal.service';

@Module({
  providers: [MarketSignalService],
  exports: [MarketSignalService],
})
export class MarketSignalModule {}
