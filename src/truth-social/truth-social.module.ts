import { Module } from '@nestjs/common';
import { TruthSocialService } from './truth-social.service';

@Module({
  providers: [TruthSocialService],
  exports: [TruthSocialService],
})
export class TruthSocialModule {}
