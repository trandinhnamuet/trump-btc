import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { BtcPriceModule } from '../btc-price/btc-price.module';
import { StorageModule } from '../storage/storage.module';
import { TruthSocialModule } from '../truth-social/truth-social.module';
import { DetectorModule } from '../detector/detector.module';

@Module({
  imports: [AnalysisModule, BtcPriceModule, StorageModule, TruthSocialModule, DetectorModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
