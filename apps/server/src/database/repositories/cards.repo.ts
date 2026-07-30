import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface CardRow extends RowDataPacket {
  id: number;
  lesson_id: number;
  knowledge_point_ids: string | null;
}

/**
 * Minimal card repo — Phase A only needs knowledgePointCount per lesson.
 */
@Injectable()
export class CardsRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  /** Count distinct knowledge points referenced by cards in a lesson. */
  async countKnowledgePointsByLessonId(lessonId: number): Promise<number> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT knowledge_point_ids FROM cards WHERE lesson_id = ? AND knowledge_point_ids IS NOT NULL',
      [lessonId],
    );
    const kpSet = new Set<string>();
    for (const row of rows) {
      const ids = (row.knowledge_point_ids as string) || '';
      ids.split(',').map(id => id.trim()).filter(Boolean).forEach(id => kpSet.add(id));
    }
    return kpSet.size;
  }
}
