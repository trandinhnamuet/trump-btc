import { Module } from '@nestjs/common';
import { TruthSocialService } from './truth-social.service';
import { TruthSocialAuthService } from './truth-social-auth.service';

@Module({
  providers: [TruthSocialService, TruthSocialAuthService],
  exports: [TruthSocialService],
})
export class TruthSocialModule {}
