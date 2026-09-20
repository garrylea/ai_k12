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
    const out = await repo.heartbeat('uid-1', 9, 'hidden', 2, 'away');

    expect(out?.activeSeconds).toBe(120);
    const [updateSql, updateParams] = pool.execute.mock.calls[0];
    expect(updateSql).toContain('LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)');
    expect(updateSql).toContain('GREATEST(0,');
    expect(updateSql).toContain("IF(client_state = 'visible'");
    expect(updateSql).toContain('heartbeat_count = heartbeat_count + 1');
    expect(updateSql).toContain("WHERE session_uid = ? AND student_id = ? AND status = 'active'");
    // subject_id 只补不覆盖（P6.5）：必须是 COALESCE(subject_id, ?)，
    // 写成 `subject_id = ?` 会把会话中途换的学科覆盖掉已完成时段的归属。
    expect(updateSql).toContain('subject_id = COALESCE(subject_id, ?)');
    expect(updateSql).not.toMatch(/subject_id\s*=\s*\?/);
    // 参数逐位对应：state / reason / state（hidden_since 的 IF）/ subjectId / uid / studentId。
    expect(updateParams).toEqual(['hidden', 'away', 'hidden', 2, 'uid-1', 9]);
    expect(updateParams).toHaveLength(6);
  });

  it('SET 列顺序是 load-bearing：三个累计列 + hidden_since 的 IF 都必须排在赋值之前', async () => {
    // MySQL 的 SET 从左到右求值，后出现的表达式会看到**已赋值**的新值。
    // 三个累计列要读**本次上报前**的 client_state / hidden_reason / last_heartbeat_at；
    // 一旦把 `client_state = ?` 挪到前面，语句照样能跑，但口径全错、静默算错时长。
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 120 }] });
    const repo = new StudySessionsRepository(pool as any);
    await repo.heartbeat('uid-1', 9, 'visible', null, null);

    const [sql] = pool.execute.mock.calls[0];
    const awayIdx = sql.indexOf('hidden_away_seconds = hidden_away_seconds');
    const idleIdx = sql.indexOf('hidden_idle_seconds = hidden_idle_seconds');
    const activeIdx = sql.indexOf('active_seconds = active_seconds');
    const assignStateIdx = sql.indexOf('client_state = ?');
    const assignReasonIdx = sql.indexOf('hidden_reason = ?');
    const assignSinceIdx = sql.indexOf('hidden_since = IF(?');
    const assignSubjectIdx = sql.indexOf('subject_id = COALESCE(subject_id, ?)');

    for (const [name, idx] of [
      ['hidden_away_seconds', awayIdx],
      ['hidden_idle_seconds', idleIdx],
      ['active_seconds', activeIdx],
      ['client_state = ?', assignStateIdx],
      ['hidden_reason = ?', assignReasonIdx],
      ['hidden_since = IF(?', assignSinceIdx],
      ['subject_id = COALESCE', assignSubjectIdx],
    ] as const) {
      expect(idx, `${name} 没找到`).toBeGreaterThanOrEqual(0);
    }

    // 三个累计列都在三个赋值之前（它们读的是旧值）
    expect(awayIdx).toBeLessThan(assignStateIdx);
    expect(awayIdx).toBeLessThan(assignReasonIdx);
    expect(awayIdx).toBeLessThan(assignSinceIdx);
    expect(idleIdx).toBeLessThan(assignStateIdx);
    expect(idleIdx).toBeLessThan(assignReasonIdx);
    expect(idleIdx).toBeLessThan(assignSinceIdx);
    expect(activeIdx).toBeLessThan(assignStateIdx);
    expect(activeIdx).toBeLessThan(assignReasonIdx);
    expect(activeIdx).toBeLessThan(assignSinceIdx);
    // hidden_since 的 IF 读自己的旧值（COALESCE 保住本段起点）→ 按约定仍排在两个挂机累计列之后，
    // 让「哪条表达式读旧值」一眼可辨（累计列已不再读 hidden_since，此顺序本身不改变口径）
    expect(assignSinceIdx).toBeGreaterThan(awayIdx);
    expect(assignSinceIdx).toBeGreaterThan(idleIdx);
    // 既有顺序：subject_id 仍在 client_state 之后（别挪到累计列之前，会看不清哪条读旧值）
    expect(assignSubjectIdx).toBeGreaterThan(assignStateIdx);
  });

  it('away 段只累加 hidden_away_seconds（按 hidden_reason 分流，两条 IF 各自守卫）', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);
    await repo.heartbeat('uid-1', 9, 'hidden', null, 'away');

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("IF(client_state = 'hidden' AND hidden_reason = 'away'");
    expect(sql).toContain("IF(client_state = 'hidden' AND hidden_reason = 'idle'");
    // 三条累计（away / idle / active）全部以「上次心跳」为基点，单次封顶 45s
    expect(sql.match(/LEAST\(TIMESTAMPDIFF\(SECOND, last_heartbeat_at, NOW\(3\)\), 45\)/g)).toHaveLength(3);
    // hidden_since 只用于维护本段起点，绝不参与秒数累加
    expect(sql).not.toContain('TIMESTAMPDIFF(SECOND, hidden_since');
    expect(params[1]).toBe('away');
  });

  it('idle 段只累加 hidden_idle_seconds', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);
    await repo.heartbeat('uid-1', 9, 'hidden', null, 'idle');

    const [, params] = pool.execute.mock.calls[0];
    expect(params[1]).toBe('idle');
  });

  it('hidden_since 建立（hidden 时 COALESCE 保住本段起点）与回到 visible 清空', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);
    await repo.heartbeat('uid-1', 9, 'hidden', null, 'away');

    const [sql, params] = pool.execute.mock.calls[0];
    // hidden → 建立（已建立则不动：COALESCE 保住本段起点，供 service 判「这一段连续多久」）
    expect(sql).toContain("hidden_since = IF(? = 'hidden', COALESCE(hidden_since, NOW(3)), NULL)");
    // 第三个占位符就是 state（`client_state = ?` 之外还要再出现一次）
    expect(params[2]).toBe('hidden');

    // 回到 visible → 同一个表达式落到 NULL 分支，清空本段
    // （每次 heartbeat 是「UPDATE + 回读 SELECT」两条，故第二次的 UPDATE 在 calls[2]）
    await repo.heartbeat('uid-1', 9, 'visible', null, null);
    const [sql2, params2] = pool.execute.mock.calls[2];
    expect(sql2).toContain("hidden_since = IF(? = 'hidden', COALESCE(hidden_since, NOW(3)), NULL)");
    expect(params2[2]).toBe('visible');
  });

  it('hidden_reason 维护：hidden 时写本次原因，visible 时写 null', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);

    await repo.heartbeat('uid-1', 9, 'hidden', null, 'idle');
    expect(pool.execute.mock.calls[0][1][1]).toBe('idle');

    await repo.heartbeat('uid-1', 9, 'visible', null, null);
    expect(pool.execute.mock.calls[2][1][1]).toBeNull();
  });

  it('不传学科（null）也是合法调用：等价「这次没带」，不影响已有 subject_id', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);

    await repo.heartbeat('uid-1', 9, 'visible', null, null);

    const [, updateParams] = pool.execute.mock.calls[0];
    expect(updateParams).toEqual(['visible', null, 'visible', null, 'uid-1', 9]);
  });

  it('返回本段挂机信息（hidden_since / hidden_reason）供 service 判阈值', async () => {
    const since = new Date('2026-09-20T10:00:00.000Z');
    const pool = mockPool({
      affectedRows: 1,
      rows: [{ active_seconds: 300, hidden_since: since, hidden_reason: 'away' }],
    });
    const repo = new StudySessionsRepository(pool as any);

    const out = await repo.heartbeat('uid-1', 9, 'hidden', null, 'away');

    expect(out).toEqual({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'away' });
    const [selectSql] = pool.execute.mock.calls[1];
    expect(selectSql).toContain('SELECT active_seconds, hidden_since, hidden_reason');
  });

  it('没命中活跃会话（affectedRows=0）→ null，不报错', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.heartbeat('uid-x', 9, 'visible', null, null)).toBeNull();
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

  it('结束前也补计最后一段挂机秒数（pagehide 后不再有心跳），且不写挂机三列', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 300, ended_at: new Date('2026-09-19T10:00:00Z') }] });
    const repo = new StudySessionsRepository(pool as any);
    await repo.end('uid-1', 9, 'pagehide');

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("IF(client_state = 'hidden' AND hidden_reason = 'away'");
    expect(sql).toContain("IF(client_state = 'hidden' AND hidden_reason = 'idle'");
    // 三条累计列必须排在 `last_heartbeat_at = NOW(3)` 之前（active_seconds 读旧 last_heartbeat_at）
    expect(sql.indexOf('active_seconds = active_seconds')).toBeLessThan(
      sql.indexOf('last_heartbeat_at = NOW(3)'),
    );
    // end 不改 client_state / hidden_since / hidden_reason（本段信息要留给 service 判定）
    expect(sql).not.toContain('client_state = ?');
    expect(sql).not.toContain('hidden_since =');
    expect(sql).not.toContain('hidden_reason = ?');
    expect(params).toEqual(['pagehide', 'uid-1', 9]);
  });

  it('返回本段挂机信息供 service 在结束路径判阈值', async () => {
    const since = new Date('2026-09-20T10:00:00.000Z');
    const pool = mockPool({
      affectedRows: 1,
      rows: [{ active_seconds: 300, ended_at: new Date('2026-09-19T10:00:00Z'), hidden_since: since, hidden_reason: 'idle' }],
    });
    const repo = new StudySessionsRepository(pool as any);
    const out = await repo.end('uid-1', 9, 'pagehide');

    expect(out?.hiddenSince).toEqual(since);
    expect(out?.hiddenReason).toBe('idle');
  });

  it('没命中（已结束/不存在）→ null', async () => {
    const pool = mockPool({ affectedRows: 0, rows: [] });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.end('uid-x', 9, 'route_change')).toBeNull();
  });
});

describe('StudySessionsRepository 挂机累计差值基点', () => {
  it('挂机累计的差值基点是 last_heartbeat_at，不是 hidden_since（改回会系统性偏大 1.6×）', async () => {
    // 心跳间隔 30s、单次封顶 45s：若以「本段起点」hidden_since 为基点，挂机段内每次心跳都会
    // 按「距起点」重算并加满 45s（45 → 90 → 135），累计系统性偏大 ~1.6×。三条累计列必须与
    // active_seconds 同源，一律以「上次心跳」last_heartbeat_at 为基点。
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 60 }] });
    const repo = new StudySessionsRepository(pool as any);

    // heartbeat：away / idle / active 三条累计的基点都是 last_heartbeat_at
    await repo.heartbeat('uid-1', 9, 'hidden', null, 'away');
    const [heartbeatSql] = pool.execute.mock.calls[0];
    expect(heartbeatSql).not.toContain('TIMESTAMPDIFF(SECOND, hidden_since');
    expect(
      heartbeatSql.match(/LEAST\(TIMESTAMPDIFF\(SECOND, last_heartbeat_at, NOW\(3\)\), 45\)/g),
    ).toHaveLength(3);

    // end：同样三条累计，基点也是 last_heartbeat_at（heartbeat 是 UPDATE+SELECT 两条，故 end 的 UPDATE 在 calls[2]）
    await repo.end('uid-1', 9, 'pagehide');
    const [endSql] = pool.execute.mock.calls[2];
    expect(endSql).not.toContain('TIMESTAMPDIFF(SECOND, hidden_since');
    expect(endSql.match(/LEAST\(TIMESTAMPDIFF\(SECOND, last_heartbeat_at, NOW\(3\)\), 45\)/g)).toHaveLength(3);
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
