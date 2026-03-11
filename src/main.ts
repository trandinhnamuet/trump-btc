import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

// Polyfill crypto.randomUUID for @nestjs/schedule
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID },
    writable: true,
    configurable: true,
  });
}

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 2998;
  await app.listen(port);
  logger.log(`Application started and listening on port ${port}`);
  logger.log('Scheduler and polling services should now be active');
}

bootstrap();
