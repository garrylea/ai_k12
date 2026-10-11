/**
 * VariationService + VariationController（错题升级变式端点，PRD §7.10，2026-10-11）单元测试。
 *
 * 本文件钉住的关键行为：
 * 1. **一次作答即落定**（用户裁决 D1）：submitAnswer 判对判错都 CAS markAnswered；
 *    重复作答 / 并发竞态（CAS=0）→ 400 同文案；主观题 isCorrect=null 不落定（等自评）。
 * 2. **selfAssess 刻意不经 judgeCore**（镜像套题裁决，有钉子用例）。
 * 3. **下线题收口**：findByIds 查不到（repo 只回 is_active=1）→ markAnswered(id, 0) 并剔除，
 *    防「N 道变式待练」死计数。
 * 4. **判题隔离**：judgeQuestion source='variation'（隔离分支在 judge-core 测试里钉），
 *    返回形状**无 points 字段**（纯加练不发分）。
 * 5. Controller 400 矩阵 + 201 状态码钉子（Nest 默认，未加 @HttpCode）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { VariationService } from './variation.service.js';
import { VariationController } from './variation.controller.js';
import type { QuestionRow } from '../../database/repositories/types.js';

const STUDENT_ID = 7;
const ERROR_ITEM_ID = 33;
const VARIATION_ID = 501;
const QUESTION_ID = 88;

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

function makeQuestion(over: Record<string, unknown> = {}): QuestionRow {
  return {
    id: QUESTION_ID,
    subject_id: 1,
    type: 'choice',
    difficulty: 1,
    content: '变式题面',
    options: '[{"label":"A","text":"1"},{"label":"B","text":"2"}]',
    answer: 'A',
    explanation: '解析',
    source: 'variation',
    content_hash: null,
    is_active: 1,
    created_at: new Date('2026-10-11T00:00:00Z'),
    ...over,
  } as unknown as QuestionRow;
}

function makePendingRow(over: Record<string, unknown> = {}) {
  return {
    id: VARIATION_ID,
    original_error_item_id: ERROR_ITEM_ID,
    question_id: QUESTION_ID,
    difficulty: 1,
    ...over,
  };
}

function harness(over: {
  pendingByQuestion?: Record<string, unknown> | null;
  pendingList?: Array<Record<string, unknown>>;
  questions?: QuestionRow[] | null;
  judged?: Record<string, unknown> | null;
  casAffected?: number;
} = {}) {
  const variationRepo = {
    findPendingByQuestion: vi.fn().mockResolvedValue(
      over.pendingByQuestion === undefined ? makePendingRow() : over.pendingByQuestion,
    ),
    findPendingByStudent: vi.fn().mockResolvedValue(
      over.pendingList === undefined ? [makePendingRow()] : over.pendingList,
    ),
    markAnswered: vi.fn().mockResolvedValue(over.casAffected ?? 1),
  };
  const questionsRepo = {
    findByIds: vi.fn().mockResolvedValue(over.questions === undefined ? [makeQuestion()] : over.questions),
  };
  const judgeCore = {
    judgeQuestion: vi.fn().mockResolvedValue(
      over.judged === undefined
        ? { questionId: QUESTION_ID, isCorrect: true, method: 'exact', errorType: null }
        : over.judged,
    ),
  };
  const service = new VariationService(variationRepo as any, questionsRepo as any, judgeCore as any);
  return { service, variationRepo, questionsRepo, judgeCore };
}

describe('VariationService.listPending', () => {
  it('空 pending → 空数组，不查题目', async () => {
    const h = harness({ pendingList: [] });
    const r = await h.service.listPending(STUDENT_ID);
    expect(r).toEqual({ variations: [] });
    expect(h.questionsRepo.findByIds).not.toHaveBeenCalled();
  });

  it('组装题面：errorBookId=original_error_item_id，options parseOptions，绝不下发 answer/explanation', async () => {
    const h = harness();
    const r = await h.service.listPending(STUDENT_ID);
    expect(r.variations).toHaveLength(1);
    const v = r.variations[0];
    expect(v).toEqual({
      variationId: VARIATION_ID,
      questionId: QUESTION_ID,
      errorBookId: ERROR_ITEM_ID,
      text: '变式题面',
      type: 'choice',
      options: [{ label: 'A', text: '1' }, { label: 'B', text: '2' }],
      difficulty: 1,
    });
    expect(JSON.stringify(r)).not.toContain('"answer"');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('下线题收口：findByIds 查不到 → markAnswered(id, 0) 并从结果剔除（防死计数）', async () => {
    const h = harness({
      pendingList: [makePendingRow(), makePendingRow({ id: 502, question_id: 89 })],
      questions: [makeQuestion()], // 只有 88 在线，89 已下线
    });
    const r = await h.service.listPending(STUDENT_ID);
    expect(h.variationRepo.markAnswered).toHaveBeenCalledWith(502, false);
    expect(r.variations.map((v) => v.variationId)).toEqual([VARIATION_ID]);
  });
});

describe('VariationService.submitAnswer', () => {
  it('判题 source=variation，判对 CAS 落定，返回 remainingCount（无 points 字段）', async () => {
    const h = harness({ pendingList: [] });
    const r = await h.service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' });
    expect(h.judgeCore.judgeQuestion).toHaveBeenCalledWith({
      studentId: STUDENT_ID, subjectId: 1, questionId: QUESTION_ID, studentAnswer: 'A', source: 'variation',
    });
    expect(h.variationRepo.markAnswered).toHaveBeenCalledWith(VARIATION_ID, true);
    expect(r).toEqual({
      isCorrect: true, method: 'exact', errorType: null,
      needsSelfAssessment: false, referenceAnswer: null, explanation: null,
      remainingCount: 0,
    });
    expect('points' in r).toBe(false);
  });

  it('判错同样落定（一次作答即落定，D1）', async () => {
    const h = harness({ judged: { questionId: QUESTION_ID, isCorrect: false, method: 'exact', errorType: 'calc' }, pendingList: [] });
    const r = await h.service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'B' });
    expect(h.variationRepo.markAnswered).toHaveBeenCalledWith(VARIATION_ID, false);
    expect(r.isCorrect).toBe(false);
    expect(r.errorType).toBe('calc');
  });

  it('主观题（isCorrect=null）不落定，needsSelfAssessment 原样带回', async () => {
    const h = harness({
      judged: {
        questionId: QUESTION_ID, isCorrect: null, method: 'self_assess',
        needsSelfAssessment: true, referenceAnswer: '过程…', explanation: '解析',
      },
      pendingList: [makePendingRow(), makePendingRow({ id: 502 })],
    });
    const r = await h.service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'x=3' });
    expect(h.variationRepo.markAnswered).not.toHaveBeenCalled();
    expect(r.isCorrect).toBeNull();
    expect(r.needsSelfAssessment).toBe(true);
    expect(r.referenceAnswer).toBe('过程…');
  });

  it('不在待练清单 / 已作答 → 400（不泄漏存在性）', async () => {
    const h = harness({ pendingByQuestion: null });
    await expect(
      h.service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' }),
    ).rejects.toMatchObject({ status: 400, response: { message: '该变式题不在待练清单或已作答' } });
    expect(h.judgeCore.judgeQuestion).not.toHaveBeenCalled();
  });

  it('CAS 竞态（affectedRows=0）→ 400 同文案', async () => {
    const h = harness({ casAffected: 0 });
    await expect(
      h.service.submitAnswer(STUDENT_ID, { questionId: QUESTION_ID, studentAnswer: 'A' }),
    ).rejects.toMatchObject({ status: 400, response: { message: '该变式题不在待练清单或已作答' } });
  });
});

describe('VariationService.selfAssess', () => {
  it('落定 assessment 结果，不经 judgeCore（镜像套题裁决的钉子）', async () => {
    const h = harness({ pendingList: [] });
    const r = await h.service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'correct' });
    expect(h.judgeCore.judgeQuestion).not.toHaveBeenCalled();
    expect(h.variationRepo.markAnswered).toHaveBeenCalledWith(VARIATION_ID, true);
    expect(r).toEqual({
      isCorrect: true, method: 'self_assess', errorType: null,
      needsSelfAssessment: false, referenceAnswer: null, explanation: null,
      remainingCount: 0,
    });
  });

  it('assessment=incorrect 同样落定为答错', async () => {
    const h = harness({ pendingList: [] });
    const r = await h.service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'incorrect' });
    expect(h.variationRepo.markAnswered).toHaveBeenCalledWith(VARIATION_ID, false);
    expect(r.isCorrect).toBe(false);
  });

  it('不在待练清单 → 400；CAS 竞态 → 400', async () => {
    const h1 = harness({ pendingByQuestion: null });
    await expect(
      h1.service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'correct' }),
    ).rejects.toMatchObject({ status: 400 });
    const h2 = harness({ casAffected: 0 });
    await expect(
      h2.service.selfAssess(STUDENT_ID, { questionId: QUESTION_ID, assessment: 'correct' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('VariationController 校验矩阵', () => {
  const user = { sub: STUDENT_ID, role: 'student' } as any;
  const mkController = (service: any) => new VariationController(service);

  it('me：errorBookId 非法（0 / -1 / 1.5 / abc）→ 400', async () => {
    const svc: any = { listPending: vi.fn() };
    const c = mkController(svc);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      await expect(c.me(bad, user)).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.listPending).not.toHaveBeenCalled();
  });

  it('me：合法/缺省 errorBookId 透传 service', async () => {
    const svc: any = { listPending: vi.fn().mockResolvedValue({ variations: [] }) };
    const c = mkController(svc);
    await c.me(undefined, user);
    await c.me('33', user);
    expect(svc.listPending).toHaveBeenNthCalledWith(1, STUDENT_ID, undefined);
    expect(svc.listPending).toHaveBeenNthCalledWith(2, STUDENT_ID, 33);
  });

  it('answers：questionId 非正整数 / studentAnswer 非 string → 400', async () => {
    const svc: any = { submitAnswer: vi.fn() };
    const c = mkController(svc);
    for (const dto of [
      { questionId: 0, studentAnswer: 'A' },
      { questionId: 1.5, studentAnswer: 'A' },
      { questionId: 10, studentAnswer: 3 },
    ] as any[]) {
      await expect(c.answer(dto, user)).rejects.toMatchObject({ status: 400 });
    }
    expect(svc.submitAnswer).not.toHaveBeenCalled();
  });

  it('self-assess：assessment 越界 → 400', async () => {
    const svc: any = { selfAssess: vi.fn() };
    const c = mkController(svc);
    await expect(
      c.selfAssess({ questionId: 10, assessment: 'maybe' as any }, user),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.selfAssess).not.toHaveBeenCalled();
  });

  it('钉子：POST 端点未加 @HttpCode（Nest 默认 201，openapi 记 201 的依据）', () => {
    for (const descriptor of Object.entries(Object.getOwnPropertyDescriptors(VariationController.prototype)).map(([, d]) => d)) {
      if (typeof descriptor.value !== 'function') continue;
      // Reflect metadata 里没有显式覆盖 HTTP code 的痕迹（无 HTTP_CODE metadata）即为默认 201
      const code = Reflect.getMetadata('__httpCode__', descriptor.value);
      expect(code).toBeUndefined();
    }
  });
});
