import { Module } from '@nestjs/common';
import { KnowledgeGraphController } from './knowledge-graph.controller.js';
import { KnowledgeGraphService } from './knowledge-graph.service.js';
import { KnowledgePointsRepository } from '../../database/repositories/knowledge-points.repo.js';
import { StudentKnowledgeMasteryRepository } from '../../database/repositories/student-knowledge-mastery.repo.js';
import { MainErrorBooksRepository } from '../../database/repositories/main-error-books.repo.js';

/**
 * 数学薄弱点图谱模块（spec `2026-09-23-math-weakpoint-graph-design.md`）。
 *
 * - **无 `imports`**：三个仓储都只依赖 `@Inject('DATABASE_POOL')`，而 `DatabaseModule` 是
 *   `@Global()`，不需要 import。仓储是**无状态**的（只有一个连接池），与
 *   `TrainingModule` / `ParentInsightsModule` 里各自那份是不同实例、不分裂任何状态。
 * - **不注入 `PointsService`**：本模块只读、不发分。发分仍由
 *   `POST /api/training/targeted/start` → 训练模块负责。
 * - 别把 `StudentKnowledgeMasteryRepository` 改成从别的模块 import：那些模块**不导出**仓储，
 *   强行加 export 会让两个模块的演进互相绑死。
 */
@Module({
  controllers: [KnowledgeGraphController],
  providers: [
    KnowledgeGraphService,
    KnowledgePointsRepository,
    StudentKnowledgeMasteryRepository,
    MainErrorBooksRepository,
  ],
})
export class KnowledgeGraphModule {}
