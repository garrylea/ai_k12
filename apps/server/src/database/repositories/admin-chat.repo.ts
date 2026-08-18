import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AdminDialogue { id: number; adminId: number; modelKey: string; title: string | null; updatedAt: Date; }
export interface AdminMessage { id: number; dialogueId: number; role: 'user' | 'assistant'; content: string; reasoning: string | null; createdAt: Date; }

@Injectable()
export class AdminChatRepository {
  constructor(@Inject('DATABASE_POOL') private pool: Pool) {}

  async createDialogue(adminId: number, modelKey: string): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO admin_dialogues (admin_id, model_key) VALUES (?, ?)', [adminId, modelKey]);
    return (r as any).insertId;
  }

  async findDialogue(id: number): Promise<AdminDialogue | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, admin_id AS adminId, model_key AS modelKey, title, updated_at AS updatedAt FROM admin_dialogues WHERE id = ?', [id]);
    return (rows[0] as any) ?? null;
  }

  async listDialogues(adminId: number): Promise<AdminDialogue[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, admin_id AS adminId, model_key AS modelKey, title, updated_at AS updatedAt FROM admin_dialogues WHERE admin_id = ? ORDER BY updated_at DESC', [adminId]);
    return rows as any;
  }

  async deleteDialogue(id: number): Promise<void> {
    await this.pool.execute('DELETE FROM admin_messages WHERE dialogue_id = ?', [id]);
    await this.pool.execute('DELETE FROM admin_dialogues WHERE id = ?', [id]);
  }

  async addMessage(dialogueId: number, role: 'user' | 'assistant', content: string, reasoning?: string | null): Promise<number> {
    const [r] = await this.pool.execute(
      'INSERT INTO admin_messages (dialogue_id, role, content, reasoning) VALUES (?, ?, ?, ?)',
      [dialogueId, role, content, reasoning ?? null]);
    await this.pool.execute('UPDATE admin_dialogues SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [dialogueId]);
    return (r as any).insertId;
  }

  async listMessages(dialogueId: number): Promise<AdminMessage[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, dialogue_id AS dialogueId, role, content, reasoning, created_at AS createdAt FROM admin_messages WHERE dialogue_id = ? ORDER BY id', [dialogueId]);
    return rows as any;
  }
}
