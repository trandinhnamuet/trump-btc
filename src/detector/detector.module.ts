import { Module } from '@nestjs/common';
import { DetectorService } from './detector.service';
import { ModelRegistryService } from './model-registry.service';

@Module({
  providers: [DetectorService, ModelRegistryService],
  exports: [DetectorService, ModelRegistryService],
})
export class DetectorModule {}
