import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturedDeliveryService } from './featured-delivery.service.js';

const student = (overrides: Record<string, unknown> = {}) => ({
  id: 9,
  grade: '初一',
  ...overrides,
});

const sourceQuestion = (id: number) => ({
  id,
  subject_id: 1,
  content: `题面${id}`,
  type: 'choice',
  options: JSON.stringify([{ key: 'A', text: '选项' }]),
  answer: 'A',
  explanation: null,
  material_text: null,
  material_url: null,
  sub_no: id,
  source: 'paper',
  question_no: null,
});

const openResult = (overrides: Record<string, unknown> = {}) => ({
  publicationId: 22,
  setId: 7,
  title: '七年级数学精选',
  subjectId: 1,
  questions: [sourceQuestion(1), sourceQuestion(2)],
  ...overrides,
});

describe('FeaturedDeliveryService', () => {
  let repository: {
    listStudentPublications: ReturnType<typeof vi.fn>;
    unreadSummary: ReturnType<typeof vi.fn>;
    findOpenPublication: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
  };
  let specialSessions: { upsertSession: ReturnType<typeof vi.fn> };
  let students: { findById: ReturnType<typeof vi.fn> };
  let pool: { getConnection: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  let conn: {
    beginTransaction: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  let service: FeaturedDeliveryService;

  beforeEach(() => {
    conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      execute: vi.fn(),
      query: vi.fn(),
    };
    pool = { getConnection: vi.fn().mockResolvedValue(conn), execute: vi.fn(), query: vi.fn() };
    students = { findById: vi.fn().mockResolvedValue(student()) };
    repository = {
      listStudentPublications: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      unreadSummary: vi.fn().mockResolvedValue({ count: 0, latest: null }),
      findOpenPublication: vi.fn().mockResolvedValue(openResult()),
      markRead: vi.fn().mockResolvedValue(undefined),
    };
    specialSessions = { upsertSession: vi.fn().mockResolvedValue(101) };
    service = new FeaturedDeliveryService(
      repository as never,
      specialSessions as never,
      students as never,
      pool as never,
    );
  });

  it('list 返回 {items,page,pageSize,total} 线格式，年级用 grade_N code', async () => {
    const items = [{ publicationId: 12 }];
    repository.listStudentPublications.mockResolvedValueOnce({ items, total: 7 });

    await expect(service.list(9, '2')).resolves.toEqual({
      items, page: 2, pageSize: 20, total: 7,
    });
    expect(students.findById).toHaveBeenCalledWith(9);
    expect(repository.listStudentPublications).toHaveBeenCalledWith(9, 'grade_7', 2);

    await expect(service.list(9)).resolves.toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(repository.listStudentPublications).toHaveBeenLastCalledWith(9, 'grade_7', 1);
  });

  it('unreadSummary 同样用 grade_N code', async () => {
    await expect(service.unreadSummary(9)).resolves.toEqual({ count: 0, latest: null });
    expect(repository.unreadSummary).toHaveBeenCalledWith(9, 'grade_7');
  });

  it('list / unreadSummary 学生不存在或年级无法解析 -> 1001，且不查仓储', async () => {
    students.findById.mockResolvedValueOnce(null).mockResolvedValueOnce(student({ grade: '大学' }));

    await expect(service.list(9)).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(service.unreadSummary(9)).rejects.toMatchObject({ response: { code: 1001 } });
    expect(repository.listStudentPublications).not.toHaveBeenCalled();
    expect(repository.unreadSummary).not.toHaveBeenCalled();
  });

  it('open 先生成 sessionUid、创建 featured session，再标已读', async () => {
    const out = await service.open(9, 22);

    expect(out.sessionUid).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.mode).toBe('featured');
    expect(out.subjectId).toBe(1);
    expect(out.title).toBe('七年级数学精选');
    expect(out.questions).toHaveLength(2);
    expect(specialSessions.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionUid: out.sessionUid,
      studentId: 9,
      subjectId: 1,
      module: 'math_targeted',
      title: '七年级数学精选',
      questionCount: 2,
      featuredPublicationId: 22,
    }), conn);
    expect(repository.markRead).toHaveBeenCalledWith(22, 9, conn);
  });

  it('同一学生重复 open：sessionUid 不同、session/read 各再写一次', async () => {
    const first = await service.open(9, 22);
    const second = await service.open(9, 22);

    expect(second.sessionUid).not.toBe(first.sessionUid);
    expect(specialSessions.upsertSession).toHaveBeenCalledTimes(2);
    expect(repository.markRead).toHaveBeenCalledTimes(2);
  });

  it('open 单连接事务：三处仓储调用共用同一 executor，commit 在 markRead 之后', async () => {
    await service.open(9, 22);

    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(repository.findOpenPublication).toHaveBeenCalledWith(22, 'grade_7', conn);
    expect(specialSessions.upsertSession).toHaveBeenCalledWith(expect.anything(), conn);
    expect(repository.markRead).toHaveBeenCalledWith(22, 9, conn);
    expect(repository.markRead.mock.invocationCallOrder[0])
      .toBeGreaterThan(specialSessions.upsertSession.mock.invocationCallOrder[0]);
    expect(conn.commit.mock.invocationCallOrder[0])
      .toBeGreaterThan(repository.markRead.mock.invocationCallOrder[0]);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('open 查不到 publication（年级不匹配 / 已撤回 / 0 题）-> 1002 + rollback，不建会话也不写已读', async () => {
    repository.findOpenPublication.mockResolvedValue(null);

    await expect(service.open(9, 22)).rejects.toMatchObject({ response: { code: 1002 } });
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(specialSessions.upsertSession).not.toHaveBeenCalled();
    expect(repository.markRead).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('open 建会话失败 -> rollback 并抛原错误，不写已读', async () => {
    const boom = new Error('session db down');
    specialSessions.upsertSession.mockRejectedValue(boom);

    await expect(service.open(9, 22)).rejects.toBe(boom);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(repository.markRead).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('open 标已读失败 -> rollback 并抛原错误，不 commit', async () => {
    const boom = new Error('read db down');
    repository.markRead.mockRejectedValue(boom);

    await expect(service.open(9, 22)).rejects.toBe(boom);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('open 部分题下架：返回在架题与 publication 自己的标题', async () => {
    repository.findOpenPublication.mockResolvedValue(openResult({
      title: '教研手填标题',
      questions: [sourceQuestion(1)],
    }));

    const out = await service.open(9, 22);
    expect(out.title).toBe('教研手填标题');
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]).toMatchObject({ questionId: 1, text: '题面1' });
  });
});
