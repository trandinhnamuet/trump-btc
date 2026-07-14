import { Module } from '@nestjs/common';
import { PollingService } from './polling.service';
import { TruthSocialModule } from '../truth-social/truth-social.module';
import { BtcPriceModule } from '../btc-price/btc-price.module';
import { TelegramModule } from '../telegram/telegram.module';
import { StorageModule } from '../storage/storage.module';
import { DetectorModule } from '../detector/detector.module';

/**
 * PollingModule: Import tất cả các module cần thiết cho orchestrator.
 */
@Module({
  imports: [
    TruthSocialModule,
    BtcPriceModule,
    TelegramModule,
    StorageModule,
    DetectorModule,
  ],
  providers: [PollingService],
})
export class PollingModule {}
