import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { AdminsRepository } from '../../database/repositories/admins.repo.js';
import { ParentsRepository } from '../../database/repositories/parents.repo.js';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'k12-dev-secret',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, StudentsRepository, AdminsRepository, ParentsRepository],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
