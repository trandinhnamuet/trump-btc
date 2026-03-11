import { Module } from '@nestjs/common';
import { BtcPriceService } from './btc-price.service';

@Module({
  providers: [BtcPriceService],
  exports: [BtcPriceService],
})
export class BtcPriceModule {}
