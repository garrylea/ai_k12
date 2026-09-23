/**
 * 跨仓储共享的 SQL 片段常量。
 *
 * **为什么要有这个文件**：`MainErrorBooksRepository.countUncoveredUncleared`（学生端图谱页）
 * 与 `ParentInsightsRepository.countUncoveredUnclearedErrors`（家长端报告）的
 * `NOT EXISTS (...)` 子句**逐字相同**，只有外层过滤条件不同。原先两边各写一份，
 * 残留风险是改一处忘另一处会**静默漂移**，而两边的测试各自只钉住自己那份。
 * 抽成常量后，两边拼的是同一段文本，漂移在结构上不可能发生。
 *
 * **只共享字符串**：这里不 import 任何仓储 / service，所以不造成模块耦合
 * （与「不要把 `ParentInsightsRepository` 跨模块复用」并不冲突 —— 那说的是不要共享**实例**）。
 *
 * ⚠️ 片段里的 `meb` 是 `main_error_books` 的别名，两处查询都这么写
 * （`parent-insights.repo.ts:484`、`main-error-books.repo.ts:168`）。
 * 谁换别名，谁必须同步改这里。
 */

/**
 * 「这条错题映射不到任何知识点」的判定子句。
 *
 * 语义：`main_error_books` 的某行（别名 `meb`）在 `question_knowledge_points` 里
 * 找不到任何关联行 —— 即该题的 KP 标注缺失，进不了知识点图谱。
 *
 * **不含** `student_id` / `is_cleared` / `subject_id`：那些是外层查询的过滤条件，
 * 两处口径不同（家长端跨学科、学生端仅数学），故意留在各自查询里。
 */
export const UNCOVERED_ERROR_PREDICATE =
  'NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id)';
