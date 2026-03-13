import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { BtcPriceModule } from '../btc-price/btc-price.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AnalysisModule, BtcPriceModule, StorageModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
