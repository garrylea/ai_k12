import { describe, expect, it } from 'vitest';
import { parseRunHandoff } from './run-handoff';

/**
 * 配置页 → run 页的 sessionStorage 交接体解析（计划 §3 Task 7b）。
 *
 * 这个解析器是**两个会话页发分的唯一入口**：解析失败会被当成「空题单」把学生踢回配置页，
 * 而不是报错——所以形状判断必须严格（旧数组格式不再兼容，两侧同提交一起改）。
 */
describe('parseRunHandoff', () => {
  it('解析标准交接体：sessionId 与 questions 原样返回', () => {
    const parsed = parseRunHandoff<{ questionId: number }>(
      JSON.stringify({ sessionId: 77, questions: [{ questionId: 101 }] }),
    );
    expect(parsed).toEqual({ sessionId: 77, questions: [{ questionId: 101 }] });
  });

  it('sessionId 为 null（会话 INSERT 降级）也合法，原样保留', () => {
    const parsed = parseRunHandoff(JSON.stringify({ sessionId: null, questions: [] }));
    expect(parsed).toEqual({ sessionId: null, questions: [] });
  });

  it('数组（旧格式）不再兼容 → null', () => {
    expect(parseRunHandoff(JSON.stringify([{ questionId: 101 }]))).toBeNull();
  });

  it('缺 sessionId 字段 → 形状不对，返回 null', () => {
    expect(parseRunHandoff(JSON.stringify({ questions: [] }))).toBeNull();
  });

  it('sessionId 不是数字（字符串）→ 返回 null', () => {
    expect(parseRunHandoff(JSON.stringify({ sessionId: '77', questions: [] }))).toBeNull();
  });

  it('questions 不是数组 → 返回 null', () => {
    expect(parseRunHandoff(JSON.stringify({ sessionId: 77, questions: {} }))).toBeNull();
  });

  it('空串 / null / 非法 JSON → null（调用方按空题单处理）', () => {
    expect(parseRunHandoff(null)).toBeNull();
    expect(parseRunHandoff('')).toBeNull();
    expect(parseRunHandoff('{')).toBeNull();
  });

  /**
   * 练习记录详情页（2026-11-06 Task 8）额外写 `title` 与 `mode`：
   * 老入口（配置页 / 薄弱点图谱）不写这两个字段，所以它们必须是**可选**且只在出现时返回，
   * 否则旧交接体解析结果会多出两个 `undefined` 键、两侧形状对不上。
   */
  it('可选 title/mode 原样返回', () => {
    const parsed = parseRunHandoff(JSON.stringify({
      sessionId: null, questions: [], title: '重做：卷 · 第 1 题', mode: 'redo',
    }));
    expect(parsed).toEqual({
      sessionId: null, questions: [], title: '重做：卷 · 第 1 题', mode: 'redo',
    });
  });

  it('非法 mode -> null', () => {
    expect(parseRunHandoff(JSON.stringify({ sessionId: 1, questions: [], mode: 'x' }))).toBeNull();
  });

  it('title 不是字符串 -> null', () => {
    expect(parseRunHandoff(JSON.stringify({ sessionId: 1, questions: [], title: 1 }))).toBeNull();
  });
});
