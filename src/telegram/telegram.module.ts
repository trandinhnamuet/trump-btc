import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { BtcPriceModule } from '../btc-price/btc-price.module';

@Module({
  imports: [AnalysisModule, BtcPriceModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
