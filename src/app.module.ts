import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PollingModule } from './polling/polling.module';

/**
 * AppModule: Module gốc của ứng dụng.
 *
 * - ConfigModule: Tự động load biến môi trường từ file .env
 * - ScheduleModule: Kích hoạt cron jobs (@Cron decorator)
 * - PollingModule: Toàn bộ logic chính của ứng dụng
 */
@Module({
  imports: [
    // Load .env vào process.env, available toàn bộ app
    ConfigModule.forRoot({
      isGlobal: true, // Không cần import lại ở các module con
      envFilePath: '.env',
    }),

    // Kích hoạt scheduler để @Cron decorators hoạt động
    ScheduleModule.forRoot(),

    // Module chứa toàn bộ logic: polling, phân tích, alerts
    PollingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

