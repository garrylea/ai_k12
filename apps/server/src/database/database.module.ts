import { Module, Global } from '@nestjs/common';
import { createPool } from './connection.js';

const poolProvider = {
  provide: 'DATABASE_POOL',
  useFactory: () => createPool(),
};

@Global()
@Module({
  providers: [poolProvider],
  exports: [poolProvider],
})
export class DatabaseModule {}
