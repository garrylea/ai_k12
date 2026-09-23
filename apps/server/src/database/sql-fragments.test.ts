import { describe, it, expect } from 'vitest';
import { UNCOVERED_ERROR_PREDICATE } from './sql-fragments';

/**
 * 共享片段是**两处查询的唯一真源**（`MainErrorBooksRepository.countUncoveredUncleared`
 * 与 `ParentInsightsRepository.countUncoveredUnclearedErrors` 都拼它）。
 * 这个用例把片段文本钉死：片段被改宽/改窄（比如漏掉 `qkp.question_id = meb.question_id`
 * 变成恒真子查询）时，两处会**同时**静默错掉，只有这里能拦住。
 */
describe('sql-fragments.UNCOVERED_ERROR_PREDICATE', () => {
  it('谓词文本与两处仓储的期望逐字一致', () => {
    expect(UNCOVERED_ERROR_PREDICATE).toBe(
      'NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id)',
    );
  });

  it('不含外层过滤条件（student_id / is_cleared / subject_id 归各自查询管）', () => {
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('student_id');
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('is_cleared');
    expect(UNCOVERED_ERROR_PREDICATE).not.toContain('subject_id');
  });

  it('别名固定为 meb（两处查询都用 meb 指 main_error_books，换别名必须同步改片段）', () => {
    expect(UNCOVERED_ERROR_PREDICATE).toContain('meb.question_id');
  });
});
