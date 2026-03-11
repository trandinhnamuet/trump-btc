import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService], // Export để các module khác dùng được
})
export class StorageModule {}
