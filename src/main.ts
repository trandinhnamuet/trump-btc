import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 2998;
  await app.listen(port);
  logger.log(`Application started and listening on port ${port}`);
  logger.log('Scheduler and polling services should now be active');
}

bootstrap();
