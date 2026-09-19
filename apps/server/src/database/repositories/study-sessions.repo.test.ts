import { describe, it, expect, vi } from 'vitest';
import { StudySessionsRepository } from './study-sessions.repo.js';

const mockPool = (opts: { rows?: any[]; affectedRows?: number } = {}) => {
  const { rows = [], affectedRows = 1 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 1, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) {
        return Promise.resolve([{ affectedRows, changedRows: affectedRows }, []]);
      }
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
};

const insertInput = () => ({
  studentId: 9,
  sessionUid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  module: 'training_targeted',
  scene: 'targeted_run',
  subjectId: 1,
  refType: null,
  refId: null,
  platformClass: 'ipad',
  browser: 'safari',
  screenClass: 'ipad_landscape',
  inputType: 'touch',
  appShell: 'web',
});

describe('StudySessionsRepository.insert', () => {
  it('INSERT IGNORE 落一行，列序与参数一一对应', async () => {
    const pool = mockPool({ affectedRows: 1 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.insert(insertInput())).toBe(true);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO study_sessions');
    expect(sql).toContain(
      '(student_id, session_uid, module, scene, subject_id, ref_type, ref_id, platform_class, browser, screen_class, input_type, app_shell)',
    );
    expect(params).toEqual([
      9,
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'training_targeted',
      'targeted_run',
      1,
      null,
      null,
      'ipad',
      'safari',
      'ipad_landscape',
      'touch',
      'web',
    ]);
  });

  it('撞 uniq_ss_uid（affectedRows=0）→ false（幂等，不新建）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.insert(insertInput())).toBe(false);
  });
});

describe('StudySessionsRepository.heartbeat', () => {
  it('增量封顶 45s，且用 GREATEST 防负数（时钟回拨）', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 120 }] });
    const repo = new StudySessionsRepository(pool as any);
    const seconds = await repo.heartbeat('uid-1', 9, 'hidden', 2);

    expect(seconds).toBe(120);
    const [updateSql, updateParams] = pool.execute.mock.calls[0];
    expect(updateSql).toContain('LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)');
    expect(updateSql).toContain('GREATEST(0,');
    expect(updateSql).toContain("IF(client_state = 'visible'");
    expect(updateSql).toContain('heartbeat_count = heartbeat_count + 1');
    expect(updateSql).toContain("WHERE session_uid = ? AND student_id = ? AND status = 'active'");
    // 顺序是 load-bearing：MySQL 的 SET 从左到右求值，后出现的表达式会看到**已赋值**的新值。
    // 若把 `client_state = ?` 挪到 IF 之前，IF 就会读到本次上报的新状态（hidden 心跳不再补计
    // 最后一段 visible、visible 心跳反而把 hidden 期间也计上），静默算错时长。
    const ifIndex = updateSql.indexOf("IF(client_state = 'visible'");
    const assignIndex = updateSql.indexOf('client_state = ?');
    expect(ifIndex).toBeGreaterThanOrEqual(0);
    expect(assignIndex).toBeGreaterThan(ifIndex);
    // subject_id 只补不覆盖（P6.5）：必须是 COALESCE(subject_id, ?)，
    // 写成 `subject_id = ?` 会把会话中途换的学科覆盖掉已完成时段的归属。
    expect(updateSql).toContain('subject_id = COALESCE(subject_id, ?)');
    expect(updateSql).not.toMatch(/subject_id\s*=\s*\?/);
    expect(updateParams).toEqual(['hidden', 2, 'uid-1', 9]);
  });

  it('不传学科（null）也是合法调用：等价「这次没带」，不影响已有 subject_id', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);

    await repo.heartbeat('uid-1', 9, 'visible', null);

    const [, updateParams] = pool.execute.mock.calls[0];
    expect(updateParams).toEqual(['visible', null, 'uid-1', 9]);
  });

  it('没命中活跃会话（affectedRows=0）→ null，不报错', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.heartbeat('uid-x', 9, 'visible', null)).toBeNull();
  });
});

describe('StudySessionsRepository.end', () => {
  it('结束时补计最后一段并落 end_reason', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 300, ended_at: new Date('2026-09-19T10:00:00Z') }] });
    const repo = new StudySessionsRepository(pool as any);
    const out = await repo.end('uid-1', 9, 'route_change');

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain("status = 'ended'");
    expect(sql).toContain('end_reason = ?');
    expect(sql).toContain('ended_at = NOW(3)');
    expect(out?.activeSeconds).toBe(300);
  });

  it('没命中（已结束/不存在）→ null', async () => {
    const pool = mockPool({ affectedRows: 0, rows: [] });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.end('uid-x', 9, 'route_change')).toBeNull();
  });
});

describe('StudySessionsRepository.closeStale', () => {
  it('按学生收尾：end_reason=closed、ended_at=最后一次心跳', async () => {
    const pool = mockPool({ affectedRows: 3 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.closeStale(9)).toBe(3);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at");
    expect(sql).toContain("WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE");
    expect(sql).toContain('AND student_id = ?');
    expect(params).toEqual([9]);
  });

  it('不传 studentId → 全库收尾（夜间兜底用）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    await repo.closeStale();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('student_id = ?');
    expect(params).toEqual([]);
  });
});
