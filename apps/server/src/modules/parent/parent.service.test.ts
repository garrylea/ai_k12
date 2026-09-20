import { describe, it, expect, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { ParentService } from './parent.service';

const mk = (overrides: Record<string, any> = {}) => ({
  parentsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    updatePassword: vi.fn().mockResolvedValue(undefined),
  },
  studentsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByUsername: vi.fn().mockResolvedValue(null),
    findByParentId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(11),
    updatePassword: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    createDefaultSettings: vi.fn().mockResolvedValue(undefined),
  },
  progressRepo: {
    findByStudentAndSubject: vi.fn().mockResolvedValue(null),
    createConfig: vi.fn().mockResolvedValue(1),
    applyConfig: vi.fn().mockResolvedValue(undefined),
  },
  versionsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findBySubjectId: vi.fn().mockResolvedValue([]),
  },
  semestersRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByTextbookVersionId: vi.fn().mockResolvedValue([]),
  },
  contentService: {
    getSubjectConfigOptions: vi.fn().mockResolvedValue([]),
    pickDefaultVersion: vi.fn().mockImplementation((versions: any[]) => versions[0] ?? null),
  },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) =>
  new ParentService(d.studentsRepo as any, d.progressRepo as any, d.versionsRepo as any, d.semestersRepo as any, d.contentService as any, d.parentsRepo as any);

const own = { id: 5, parentId: 3, username: 'xiaoming', passwordHash: 'h', name: '小明', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true };

describe('ParentService 学生子账号管理', () => {
  it('新建：grade 推导 school_level + 连带建 settings', async () => {
    const d = mk();
    await mkSvc(d).createStudent(3, { name: '二宝', username: 'erbao', password: '123456', age: 8, grade: '小学三年级' });
    expect(d.studentsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ schoolLevel: 'primary', parentId: 3 }));
    expect(d.studentsRepo.createDefaultSettings).toHaveBeenCalledWith(11, 'primary');
  });

  it('新建：用户名已存在 -> 1004', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByUsername: vi.fn().mockResolvedValue(own) }) });
    await expect(mkSvc(d).createStudent(3, { name: 'x', username: 'xiaoming', password: '123456', age: 13, grade: '初二' }))
      .rejects.toMatchObject({ response: { code: 1004, message: '用户名已存在' } });
  });

  it('新建：非法年级 -> 1001', async () => {
    const d = mk();
    await expect(mkSvc(d).createStudent(3, { name: 'x', username: 'newbie', password: '123456', age: 13, grade: '大学' }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('重置密码：非自己名下学生 -> 1005（不泄漏存在性）', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue({ ...own, parentId: 999 }) }) });
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1005, message: '无权操作该学生' } });
  });

  it('重置密码：学生不存在 -> 1002；成功 -> updatePassword', async () => {
    const d = mk();
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1002, message: '学生不存在' } });
    const d2 = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d2).resetPassword(3, 5, 'newpass123');
    expect(d2.studentsRepo.updatePassword).toHaveBeenCalledWith(5, expect.any(String));
  });

  it('重置密码：长度不合法 -> 1001 且不落库', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await expect(mkSvc(d).resetPassword(3, 5, '123'))
      .rejects.toMatchObject({ response: { code: 1001 } });
    expect(d.studentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('停用/启用：归属校验 + setActive', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d).setStatus(3, 5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
  });

  it('列表：只传 parentId，脱敏 passwordHash', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByParentId: vi.fn().mockResolvedValue([own]) }) });
    const list = await mkSvc(d).listStudents(3);
    expect(list[0]).not.toHaveProperty('passwordHash');
    expect(list[0]).toMatchObject({ username: 'xiaoming', isActive: true });
  });
});

describe('ParentService 教材配置', () => {
  const mathOptions = [{
    subjectId: 1,
    subjectName: '数学',
    grades: [{
      code: 'grade_8',
      label: '初二',
      versions: [{ id: 9, name: '人教版', publisher: '人教版', edition: '', gradeBand: 'junior', terms: ['first', 'second'] }],
    }],
  }];
  const semester77 = { id: 77, textbookVersionId: 9, name: '八年级下册', grade: 'grade_8', term: 'second', sortOrder: 15 };
  const version9 = { id: 9, subjectId: 1, name: '人教版', code: 'math_人教版_junior', gradeBand: 'junior', publisher: '人教版', edition: '', isActive: true };
  const version10 = { id: 10, subjectId: 1, name: '人教版（2024）', code: 'x', gradeBand: 'junior', publisher: '人教版', edition: '根据2022年版课程标准修订', isActive: true };

  it('查询：未配置学科按学生年级推导默认（初二 -> grade_8），不落库', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      contentService: Object.assign(mk().contentService, { getSubjectConfigOptions: vi.fn().mockResolvedValue(mathOptions) }),
    });
    const res = await mkSvc(d).getSubjectConfigs(3, 5);
    expect(res.subjects[0]).toMatchObject({
      subjectId: 1, subjectName: '数学', configured: false, started: false,
      gradeCode: 'grade_8', term: 'first', textbookVersionId: 9,
    });
    expect(d.progressRepo.findByStudentAndSubject).toHaveBeenCalledWith(5, 1);
  });

  it('查询：已配置学科读 progress + semester + version', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      contentService: Object.assign(mk().contentService, { getSubjectConfigOptions: vi.fn().mockResolvedValue(mathOptions) }),
      progressRepo: Object.assign(mk().progressRepo, {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          id: 1, studentId: 5, subjectId: 1, textbookVersionId: 9, currentSemesterId: 77,
          currentUnitId: 3, currentLessonId: 12, currentCardSort: 2,
          nextUnlockType: 'lesson', isClear: true, status: 'in_progress',
        }),
      }),
      semestersRepo: Object.assign(mk().semestersRepo, { findById: vi.fn().mockResolvedValue(semester77) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version9) }),
    });
    const res = await mkSvc(d).getSubjectConfigs(3, 5);
    expect(res.subjects[0]).toMatchObject({
      configured: true, started: true, gradeCode: 'grade_8', term: 'second', textbookVersionId: 9, publisher: '人教版',
    });
  });

  it('查询：归属校验 1005', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue({ ...own, parentId: 999 }) }) });
    await expect(mkSvc(d).getSubjectConfigs(3, 5)).rejects.toMatchObject({ response: { code: 1005 } });
  });

  it('保存：非自己名下学生 -> 1005', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue({ ...own, parentId: 999 }) }) });
    await expect(mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_8', term: 'first' }))
      .rejects.toMatchObject({ response: { code: 1005 } });
  });

  it('保存：显式版本不属于该学科 -> 1001', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue({ ...version9, subjectId: 2 }) }),
    });
    await expect(mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_8', term: 'first', textbookVersionId: 9 }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('保存：版本不含该年级/册别 -> 1001 且不落库', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version9) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([{ id: 78, grade: 'grade_8', term: 'first' }]),
      }),
    });
    await expect(mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_9', term: 'first', textbookVersionId: 9 }))
      .rejects.toMatchObject({ response: { code: 1001 } });
    expect(d.progressRepo.createConfig).not.toHaveBeenCalled();
    expect(d.progressRepo.applyConfig).not.toHaveBeenCalled();
  });

  it('保存：首次配置 -> createConfig（not_started），reset=false', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version9) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([semester77, { id: 78, grade: 'grade_8', term: 'first' }]),
      }),
    });
    const res = await mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_8', term: 'first', textbookVersionId: 9 });
    expect(res).toMatchObject({ subjectId: 1, textbookVersionId: 9, semesterId: 78, reset: false });
    expect(d.progressRepo.createConfig).toHaveBeenCalledWith({ studentId: 5, subjectId: 1, textbookVersionId: 9, semesterId: 78 });
  });

  it('保存：缺省版本走默认规则（pickDefaultVersion 按年级学段）', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findBySubjectId: vi.fn().mockResolvedValue([version9, version10]) }),
      contentService: Object.assign(mk().contentService, { pickDefaultVersion: vi.fn().mockReturnValue(version10) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([{ id: 88, grade: 'grade_9', term: 'first' }]),
      }),
    });
    const res = await mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_9', term: 'first' });
    expect(d.contentService.pickDefaultVersion).toHaveBeenCalledWith([version9, version10], 'junior');
    expect(res).toMatchObject({ textbookVersionId: 10, semesterId: 88, reset: false });
  });

  it('保存：已开始学习且切换版本 -> applyConfig reset=true', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version10) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([{ id: 88, grade: 'grade_9', term: 'first' }]),
      }),
      progressRepo: Object.assign(mk().progressRepo, {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          id: 1, studentId: 5, subjectId: 1, textbookVersionId: 9, currentSemesterId: 77,
          currentUnitId: 3, currentLessonId: 12, currentCardSort: 2,
          nextUnlockType: 'lesson', isClear: true, status: 'in_progress',
        }),
      }),
    });
    const res = await mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_9', term: 'first', textbookVersionId: 10 });
    expect(res.reset).toBe(true);
    expect(d.progressRepo.applyConfig).toHaveBeenCalledWith(1, { textbookVersionId: 10, semesterId: 88, reset: true });
  });

  it('保存：已开始但保存相同配置 -> reset=false', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version9) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([{ id: 77, grade: 'grade_8', term: 'first' }]),
      }),
      progressRepo: Object.assign(mk().progressRepo, {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          id: 1, studentId: 5, subjectId: 1, textbookVersionId: 9, currentSemesterId: 77,
          currentUnitId: 3, currentLessonId: 12, currentCardSort: 2,
          nextUnlockType: 'lesson', isClear: true, status: 'in_progress',
        }),
      }),
    });
    const res = await mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_8', term: 'first', textbookVersionId: 9 });
    expect(res.reset).toBe(false);
    expect(d.progressRepo.applyConfig).toHaveBeenCalledWith(1, { textbookVersionId: 9, semesterId: 77, reset: false });
  });

  it('保存：未开始（仅配置过）时修改 -> reset=false', async () => {
    const d = mk({
      studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }),
      versionsRepo: Object.assign(mk().versionsRepo, { findById: vi.fn().mockResolvedValue(version10) }),
      semestersRepo: Object.assign(mk().semestersRepo, {
        findByTextbookVersionId: vi.fn().mockResolvedValue([{ id: 88, grade: 'grade_9', term: 'first' }]),
      }),
      progressRepo: Object.assign(mk().progressRepo, {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          id: 1, studentId: 5, subjectId: 1, textbookVersionId: 9, currentSemesterId: 77,
          currentUnitId: null, currentLessonId: null, currentCardSort: null,
          nextUnlockType: 'lesson', isClear: true, status: 'not_started',
        }),
      }),
    });
    const res = await mkSvc(d).updateSubjectConfig(3, 5, 1, { gradeCode: 'grade_9', term: 'first', textbookVersionId: 10 });
    expect(res.reset).toBe(false);
    expect(d.progressRepo.applyConfig).toHaveBeenCalledWith(1, { textbookVersionId: 10, semesterId: 88, reset: false });
  });
});

describe('ParentService 账号信息（spec §4.5）', () => {
  const parentRow = {
    id: 7, phone: '13800000000', passwordHash: '$2b$10$secret', name: '张三', isActive: true,
  };

  it('getAccount：只回 id/name/phone（不泄漏 passwordHash / isActive）', async () => {
    const d = mk({
      parentsRepo: { findById: vi.fn().mockResolvedValue(parentRow), updatePassword: vi.fn() },
    });

    const out = await mkSvc(d).getAccount(7);

    // 键集合精确相等：这是防「顺手多返回」的钉子
    expect(Object.keys(out).sort()).toEqual(['id', 'name', 'phone']);
    expect(out).toEqual({ id: 7, name: '张三', phone: '13800000000' });
    expect(d.parentsRepo.findById).toHaveBeenCalledWith(7);
  });

  it('getAccount：家长行不存在 → 404/1002', async () => {
    const d = mk(); // 默认 findById → null

    await expect(mkSvc(d).getAccount(7)).rejects.toMatchObject({
      status: 404,
      response: { code: 1002 },
    });
  });

  it('getAccount：name 为 null 时原样返回（不编成空串）', async () => {
    const d = mk({
      parentsRepo: { findById: vi.fn().mockResolvedValue({ ...parentRow, name: null }), updatePassword: vi.fn() },
    });

    await expect(mkSvc(d).getAccount(7)).resolves.toEqual({
      id: 7, name: null, phone: '13800000000',
    });
  });
});

describe('ParentService 改密（spec §4.6）', () => {
  const hash = (pw: string) => bcrypt.hash(pw, 4);
  const mkWithHash = (passwordHash: string) => mk({
    parentsRepo: { findById: vi.fn().mockResolvedValue({
      id: 7, phone: '13800000000', passwordHash, name: '张三', isActive: true,
    }), updatePassword: vi.fn() },
  });

  it('新密码长度越界（<6 / >32）→ 409/1001 且**不写库**', async () => {
    const d = mkWithHash(await hash('oldpass'));

    await expect(mkSvc(d).changePassword(7, 'oldpass', '12345')).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });
    await expect(mkSvc(d).changePassword(7, 'oldpass', 'x'.repeat(33))).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });

    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('家长行不存在 → 404/1002 且不写库', async () => {
    const d = mk(); // 默认 findById → null

    await expect(mkSvc(d).changePassword(7, 'oldpass', 'newpass123')).rejects.toMatchObject({
      status: 404,
      response: { code: 1002 },
    });

    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('旧密码错 → 401/1003 且**不写库**（与登录失败同码）', async () => {
    const d = mkWithHash(await hash('right-old'));

    await expect(mkSvc(d).changePassword(7, 'wrong-old', 'newpass123')).rejects.toMatchObject({
      status: 401,
      response: { code: 1003 },
    });

    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('新旧相同 → 409/1001 且不写库', async () => {
    const d = mkWithHash(await hash('samepass'));

    await expect(mkSvc(d).changePassword(7, 'samepass', 'samepass')).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });

    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('成功 → updatePassword 收到的是 **bcrypt hash**（不是明文）', async () => {
    const d = mkWithHash(await hash('oldpass'));

    await mkSvc(d).changePassword(7, 'oldpass', 'newpass123');

    expect(d.parentsRepo.updatePassword).toHaveBeenCalledTimes(1);
    const [id, received] = d.parentsRepo.updatePassword.mock.calls[0];
    expect(id).toBe(7);
    // 明文落库是最危险的退化：既断言不等于明文，也断言 hash 能验回新密码
    expect(received).not.toBe('newpass123');
    expect(await bcrypt.compare('newpass123', received)).toBe(true);
  });
});
