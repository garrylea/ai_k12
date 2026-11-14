import { describe, it, expect, vi } from 'vitest';
import { AiDialoguesRepository } from './ai-dialogues.repo';

const mockPool = () => ({
  query: vi.fn().mockResolvedValue([[], []]),
  execute: vi.fn().mockResolvedValue([[], []]),
});

describe('AiDialoguesRepository.findByStudentAndTrack', () => {
  it('多 scene 用 IN，hasChat 只约束 aux_freeform', async () => {
    const pool = mockPool();
    const repo = new AiDialoguesRepository(pool as any);
    await repo.findByStudentAndTrack(9, 'auxiliary', 10, undefined, ['aux_qna', 'aux_freeform'], true);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('scene IN (?,?)');
    expect(sql).toContain("scene <> 'aux_freeform'");
    expect(sql).toContain('EXISTS');
    expect(sql).toContain("NOT IN ('transcription','freeform_submit','freeform_judge')");
    expect(sql).toContain('m.deleted_at IS NULL');
    expect(params).toEqual([9, 'auxiliary', 'aux_qna', 'aux_freeform', 10]);
  });

  it('不传 hasChat 时不加 EXISTS（兼容旧调用）', async () => {
    const pool = mockPool();
    const repo = new AiDialoguesRepository(pool as any);
    await repo.findByStudentAndTrack(9, 'auxiliary', 10, 5, 'aux_qna');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('EXISTS');
    expect(sql).toContain('scene IN (?)');
    expect(sql).toContain('id < ?');
    expect(params).toEqual([9, 'auxiliary', 5, 'aux_qna', 10]);
  });
});
