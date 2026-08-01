import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface CardRow extends RowDataPacket {
  id: number;
  lesson_id: number;
  knowledge_point_ids: string | null;
}

export interface CardContentRow extends RowDataPacket {
  id: number;
  lesson_id: number;
  sort_order: number;
  card_type: string;
  title: string | null;
  content: string;
  content_metadata: string | null;
  textbook_page: string | null;
}

/**
 * Card repo — knowledgePointCount per lesson (star map) + full card content
 * for the lesson reading page (P2.2 课程详情).
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

  /** Full ordered card list for a lesson (reading page). */
  async findByLessonId(lessonId: number): Promise<CardContentRow[]> {
    const [rows] = await this.pool.execute<CardContentRow[]>(
      `SELECT id, lesson_id, sort_order, card_type, title, content, content_metadata, textbook_page
       FROM cards WHERE lesson_id = ? ORDER BY sort_order`,
      [lessonId],
    );
    return rows;
  }
}
