import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface LlmRouteRow extends RowDataPacket {
  id: number; scene: string; subject: string;
  primary_model_key: string; fallback_model_key: string | null;
}

export interface LlmRoute {
  scene: string; subject: string; primaryModelKey: string; fallbackModelKey: string | null;
}

@Injectable()
export class LlmRoutesRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async listAll(): Promise<LlmRoute[]> {
    const [rows] = await this.pool.execute<LlmRouteRow[]>('SELECT * FROM llm_routes ORDER BY scene, subject');
    return rows.map((r) => ({ scene: r.scene, subject: r.subject, primaryModelKey: r.primary_model_key, fallbackModelKey: r.fallback_model_key }));
  }

  /** 全量替换（事务）。调用方负责先校验 modelKey 全部存在且启用。 */
  async replaceAll(routes: LlmRoute[]): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM llm_routes');
      for (const r of routes) {
        await conn.execute(
          'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
          [r.scene, r.subject, r.primaryModelKey, r.fallbackModelKey ?? null]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async existsReferenceTo(modelKey: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT 1 AS x FROM llm_routes WHERE primary_model_key = ? OR fallback_model_key = ? LIMIT 1',
      [modelKey, modelKey]);
    return rows.length > 0;
  }
}
