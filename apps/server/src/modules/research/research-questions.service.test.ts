import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResearchQuestionsService, UpdateQuestionSchema, parseBody } from './research-questions.service.js';

const USER = { sub: 7, role: 'researcher', name: '教研员' } as any;

function fullRow(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    answer: 'D',
    answer_verified: 0,
    content_hash: 'abc',
    content: '题干',
    options: '[{"label":"A","text":"甲"}]',
    explanation: '旧解析',
    approach: '旧思路',
    ...over,
  };
}

function mkRepo(over: Record<string, any> = {}) {
  return {
    findById: vi.fn().mockResolvedValue(fullRow()),
    findPaperIdByQuestion: vi.fn().mockResolvedValue(42),
    updateWithAudit: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function mkImages(over: Record<string, any> = {}) {
  return {
    cleanupUnreferenced: vi.fn().mockResolvedValue({ deleted: 0, skipped: 0 }),
    ...over,
  };
}

function mkSvc(repo = mkRepo(), images = mkImages()) {
  return {
    svc: new ResearchQuestionsService(repo as any, images as any),
    repo,
    images,
  };
}

const dto = { answer: 'C', confirmedSource: true as const, note: '对照原卷第3题改正' };

describe('ResearchQuestionsService.update', () => {
  it('改 answer 时置 answer_verified=1 且不碰 content_hash', async () => {
    const { svc, repo } = mkSvc(mkRepo({
      findById: vi.fn().mockResolvedValue({ id: 9, answer: 'D', answer_verified: 0, content_hash: 'abc' }),
    }));
    await svc.update(9, dto, USER);

    expect(repo.updateWithAudit).toHaveBeenCalledWith(9,
      expect.objectContaining({ answer: 'C' }), true,
      expect.objectContaining({
        action: 'question.update', beforeJson: { answer: 'D' }, afterJson: { answer: 'C' },
      }));
  });

  it('只改 explanation 时 answer_verified 保持原值', async () => {
    const { svc, repo } = mkSvc(mkRepo({
      findById: vi.fn().mockResolvedValue({ id: 9, answer: 'D', answer_verified: 0 }),
    }));
    const res = await svc.update(9, { explanation: '新解析', confirmedSource: true }, USER);

    expect(repo.updateWithAudit).toHaveBeenCalledWith(9, expect.anything(), false, expect.anything());
    expect(res.question.answerVerified).toBe(false); // 不是写死的 true
  });

  it('只改解析但旧题已核验 → 返回 answerVerified=true（原值）', async () => {
    const { svc } = mkSvc(mkRepo({
      findById: vi.fn().mockResolvedValue(fullRow({ answer_verified: 1 })),
    }));
    const res = await svc.update(9, { explanation: '新解析', confirmedSource: true }, USER);
    expect(res.question.answerVerified).toBe(true);
  });

  it('未勾 confirmedSource → 400/1001', async () => {
    const { svc } = mkSvc();
    await expect(svc.update(9, { answer: 'C', confirmedSource: false }, USER))
      .rejects.toMatchObject({ status: 400 });
  });

  it('approach 出现相对路径图 → 400/1001', async () => {
    const { svc } = mkSvc();
    await expect(svc.update(9,
      { approach: '![图](images/a.png)', confirmedSource: true }, USER))
      .rejects.toMatchObject({ status: 400 });
  });

  it('approach 允许 /uploads/、http(s)://、data: 图片', async () => {
    const { svc } = mkSvc();
    for (const approach of [
      '![图](/uploads/research/a.png)',
      '![图](https://x.test/a.png)',
      '![图](data:image/png;base64,AAA)',
    ]) {
      await expect(svc.update(9, { approach, confirmedSource: true }, USER)).resolves.toBeDefined();
    }
  });

  it('改答案不回填历史作答（repo 未被调用写作答表）', async () => {
    const { svc, repo } = mkSvc();
    await svc.update(9, dto, USER);
    expect(repo.updateWithAudit).toHaveBeenCalledTimes(1);
    // 历史表写操作一律不发生——此仓储只暴露 findById/findPaperIdByQuestion/updateWithAudit
    expect(Object.keys(repo)).toEqual(['findById', 'findPaperIdByQuestion', 'updateWithAudit']);
  });

  it('options 用 JSON.stringify 比较，写入 DB 的是剥离 isCorrect 后的 JSON 字符串', async () => {
    const { svc, repo } = mkSvc(mkRepo({
      findById: vi.fn().mockResolvedValue(fullRow({ options: '[{"label":"B","text":"乙"}]' })),
    }));
    await svc.update(9, {
      options: [{ label: 'A', text: '甲', isCorrect: true } as any],
      confirmedSource: true,
    }, USER);

    expect(repo.updateWithAudit).toHaveBeenCalledWith(9,
      { options: '[{"label":"A","text":"甲"}]' }, false, expect.anything());
  });

  it('options 无实际变化 → 400/1001（旧值是同一 JSON）', async () => {
    const { svc } = mkSvc();
    await expect(svc.update(9, {
      options: [{ label: 'A', text: '甲' }], confirmedSource: true,
    }, USER)).rejects.toMatchObject({ status: 400 });
  });

  it('五字段全缺省 → 400/1001', async () => {
    const { svc } = mkSvc();
    await expect(svc.update(9, { confirmedSource: true }, USER))
      .rejects.toMatchObject({ status: 400 });
  });

  it('题目不存在 → 404', async () => {
    const { svc } = mkSvc(mkRepo({ findById: vi.fn().mockResolvedValue(null) }));
    await expect(svc.update(9, dto, USER)).rejects.toMatchObject({ status: 404 });
  });

  it('id 非正整数 → 400/1001', async () => {
    const { svc } = mkSvc();
    await expect(svc.update(0, dto, USER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('审计条目携带 paperId / note / 操作者身份', async () => {
    const { svc, repo } = mkSvc();
    await svc.update(9, dto, USER);
    const audit = repo.updateWithAudit.mock.calls[0][3];
    expect(audit).toMatchObject({
      action: 'question.update', targetType: 'question', targetId: 9, paperId: 42,
      actorId: 7, actorRole: 'researcher', actorName: '教研员',
      note: '对照原卷第3题改正',
    });
    expect(repo.findPaperIdByQuestion).toHaveBeenCalledWith(9);
  });

  it('图片差集 OLD−NEW：commit 后清理，失败只记日志不回滚', async () => {
    const images = mkImages({
      cleanupUnreferenced: vi.fn().mockResolvedValue({ deleted: 1, skipped: 0 }),
    });
    const repo = mkRepo({
      findById: vi.fn().mockResolvedValue(fullRow({
        content: '旧 ![图](/uploads/research/removed.png) 题',
      })),
    });
    const { svc } = mkSvc(repo, images);

    const res = await svc.update(9, { content: '新题', confirmedSource: true }, USER);

    expect(images.cleanupUnreferenced).toHaveBeenCalledWith(['/uploads/research/removed.png'], USER);
    expect(res.deletedImages).toBe(1);
    expect(res.changedFields).toEqual(['content']);
  });

  it('cleanupUnreferenced 抛错不破坏 PATCH 结果', async () => {
    const images = mkImages({
      cleanupUnreferenced: vi.fn().mockRejectedValue(new Error('unlink failed')),
    });
    const repo = mkRepo({
      findById: vi.fn().mockResolvedValue(fullRow({
        content: '旧 ![图](/uploads/research/removed.png) 题',
      })),
    });
    const { svc } = mkSvc(repo, images);

    const res = await svc.update(9, { content: '新题', confirmedSource: true }, USER);
    expect(res.changedFields).toEqual(['content']);
    expect(res.deletedImages).toBe(0);
  });
});

describe('UpdateQuestionSchema (parseBody)', () => {
  it('confirmedSource=false 被 zod 拒绝 → 400/1001', () => {
    expect(() => parseBody(UpdateQuestionSchema, { answer: 'C', confirmedSource: false }))
      .toThrow(BadRequestException);
  });

  it('options 剥 isCorrect', () => {
    const out = parseBody(UpdateQuestionSchema, {
      options: [{ label: 'A', text: '甲', isCorrect: true }], confirmedSource: true,
    });
    expect(out.options).toEqual([{ label: 'A', text: '甲' }]);
  });

  it('approach 相对路径图被拒，绝对路径放行', () => {
    expect(() => parseBody(UpdateQuestionSchema, {
      approach: '![x](images/a.png)', confirmedSource: true,
    })).toThrow(BadRequestException);
    expect(() => parseBody(UpdateQuestionSchema, {
      approach: '![x](/uploads/research/a.png)', confirmedSource: true,
    })).not.toThrow();
  });

  it('options 超过 10 项被拒', () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ label: String(i), text: 'x' }));
    expect(() => parseBody(UpdateQuestionSchema, { options, confirmedSource: true }))
      .toThrow(BadRequestException);
  });
});
