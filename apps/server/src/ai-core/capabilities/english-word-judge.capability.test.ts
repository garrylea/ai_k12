import { describe, it, expect, vi } from 'vitest';
import { EnglishWordJudgeCapability } from './english-word-judge.capability.js';
import type { EnglishWordJudgeRequest } from '../types.js';

const commonRequest: EnglishWordJudgeRequest = {
  word: 'address',
  phonetic: '/əˈdres/',
  target: { pos: 'n.', gloss: '地址' },
  context: null,
  mode: 'common',
  otherGlosses: ['演说；演讲'],
  studentAnswer: '地址',
};

const extendedRequest: EnglishWordJudgeRequest = {
  word: 'address',
  phonetic: '/əˈdres/',
  target: { pos: 'v.', gloss: '处理；对付（问题）' },
  context: 'address the problem',
  mode: 'extended',
  otherGlosses: ['地址', '演说；演讲'],
  studentAnswer: '地址',
};

const capWith = (chat: ReturnType<typeof vi.fn>) =>
  new EnglishWordJudgeCapability({ modelClient: { chat } as never });

const userMessageOf = (chat: ReturnType<typeof vi.fn>) =>
  chat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === 'user').content as string;

const systemMessageOf = (chat: ReturnType<typeof vi.fn>) =>
  chat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === 'system').content as string;

describe('EnglishWordJudgeCapability — 解析与回退', () => {
  it('主模型成功 → 解析出 verdict 与 comment', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    const res = await capWith(chat).generate(commonRequest);
    expect(res.verdict).toBe('correct');
    expect(res.comment).toBeNull();
  });

  it('JSON 被 markdown 代码围栏包住也能解析（模型常见跑偏）', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue({ content: '```json\n{"verdict":"wrong","comment":"意思不对"}\n```' });
    const res = await capWith(chat).generate(commonRequest);
    expect(res.verdict).toBe('wrong');
    expect(res.comment).toBe('意思不对');
  });

  it('comment 缺省 → 补 null（判对时模型不给 comment 是正常的，不是解析失败）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct"}' });
    const res = await capWith(chat).generate(commonRequest);
    expect(res.comment).toBeNull();
  });

  it('verdict 不在枚举内 → 抛错（不静默当成某档）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"passed","comment":null}' });
    await expect(capWith(chat).generate(commonRequest)).rejects.toThrow(/parse failed/);
  });

  it('主模型失败 → 回退 fallback 模型', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error('local down'))
      .mockResolvedValueOnce({ content: '{"verdict":"wrong","comment":null}' });
    const res = await capWith(chat).generate(commonRequest);
    expect(res.verdict).toBe('wrong');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('两个模型都失败 → 抛出（调用方兜底为 undetermined，不计对错）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('all down'));
    await expect(capWith(chat).generate(commonRequest)).rejects.toThrow();
  });

  it('返回非 JSON 文本 → 抛错（不是静默返回某个判定）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '抱歉，我无法判断。' });
    await expect(capWith(chat).generate(commonRequest)).rejects.toThrow(/parse failed/);
  });
});

describe('EnglishWordJudgeCapability — common 模式收敛 off_target', () => {
  it('common 模式下模型输出 off_target → 收敛成 wrong', async () => {
    // common 模式没有「考哪个义项」的问题，答到任一真实义项都该判对；
    // 模型仍可能顺手输出 off_target，放行会让普通背词凭空出现「没答到考点」
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"off_target","comment":"x"}' });
    const res = await capWith(chat).generate(commonRequest);
    expect(res.verdict).toBe('wrong');
  });

  it('extended 模式下 off_target 原样保留（这是本模式存在的理由）', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '{"verdict":"off_target","comment":"本题考「处理；对付」"}',
    });
    const res = await capWith(chat).generate(extendedRequest);
    expect(res.verdict).toBe('off_target');
  });

  it('common 模式下 correct / wrong 原样通过', async () => {
    for (const v of ['correct', 'wrong']) {
      const chat = vi.fn().mockResolvedValue({ content: `{"verdict":"${v}","comment":null}` });
      expect((await capWith(chat).generate(commonRequest)).verdict).toBe(v);
    }
  });
});

describe('EnglishWordJudgeCapability — 调用参数', () => {
  it('本地 provider → 下发关 thinking 的 chat_template_kwargs；且**不**传 thinking:false', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    await capWith(chat).generate(commonRequest);
    // 路由 english_word_judge 的 primary 是 local（见 model-routes.yaml）
    expect(chat.mock.calls[0][0].extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    // `thinking: false` 对 llama.cpp 是空操作；云端 fallback 收到未知字段可能 400
    expect(chat.mock.calls[0][0].thinking).toBeUndefined();
  });

  it('要求 JSON 输出（靠 response_format，不是靠 prompt 里叮嘱）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    await capWith(chat).generate(commonRequest);
    expect(chat.mock.calls[0][0].responseFormat).toBe('json_object');
  });
});

describe('EnglishWordJudgeCapability — prompt 渲染', () => {
  it('extended 模式：题面含语境，system 说明三档', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"off_target","comment":null}' });
    await capWith(chat).generate(extendedRequest);
    const user = userMessageOf(chat);
    expect(user).toContain('address');
    expect(user).toContain('address the problem');
    expect(user).toContain('处理；对付（问题）');
    expect(user).toContain('地址');
    const system = systemMessageOf(chat);
    expect(system).toContain('off_target');
    expect(system).toContain('熟词僻义');
  });

  it('common 模式：题面**不含**语境段，system 明确不要输出 off_target', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    await capWith(chat).generate({ ...commonRequest, context: null });
    const user = userMessageOf(chat);
    expect(user).not.toContain('**语境**');
    const system = systemMessageOf(chat);
    expect(system).toContain('本模式不要输出 `off_target`');
    // 两档模式的说明里不该出现三档那一段的标题
    expect(system).not.toContain('判三档');
  });

  it('otherGlosses 非空：标题只出现**一次**，各义项作为列表项', async () => {
    // Mustache 的 section 对数组是「迭代」不是「判空」——若直接用 {{#otherGlosses}} 包住
    // 标题，标题会被打印 N 次（每个义项一次）。这条用例就是钉那个坑。
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"off_target","comment":null}' });
    await capWith(chat).generate(extendedRequest);
    const user = userMessageOf(chat);
    const headerCount = user.split('该词的其他义项').length - 1;
    expect(headerCount).toBe(1);
    expect(user).toContain('- 地址');
    expect(user).toContain('- 演说；演讲');
  });

  it('otherGlosses 为空：走「没有登记其他义项」分支，不留下空标题', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    await capWith(chat).generate({ ...commonRequest, otherGlosses: [] });
    const user = userMessageOf(chat);
    expect(user).toContain('该词没有登记其他义项');
    expect(user).not.toContain('该词的其他义项');
  });

  it('无音标时不渲染音标行（不留下空的「音标：」）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"correct","comment":null}' });
    await capWith(chat).generate({ ...commonRequest, phonetic: null });
    expect(userMessageOf(chat)).not.toContain('**音标**');
  });

  it('学生作答一定进 user message（否则模型判的就是空气）', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '{"verdict":"wrong","comment":null}' });
    await capWith(chat).generate({ ...commonRequest, studentAnswer: '演讲' });
    expect(userMessageOf(chat)).toContain('演讲');
  });
});
