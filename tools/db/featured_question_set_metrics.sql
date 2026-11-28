-- 学生精选题单：首次发布后 14 个自然日的产品度量查询。
-- 口径见 docs/superpowers/specs/2026-11-28-curated-question-set-design.md §12。
-- 四个指标：推荐学生数 / 触达数 / 打开数 / 完成数，全部只统计 [window_start, now] 窗口。

SET @window_start = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 14 DAY);

SELECT
  (SELECT COUNT(DISTINCT student_id)
     FROM featured_question_set_recommendations
    WHERE created_at >= @window_start) AS recommending_students,
  (SELECT COALESCE(SUM(reach_count), 0)
     FROM featured_question_set_publications
    WHERE published_at >= @window_start) AS reach_count,
  (SELECT COUNT(*)
     FROM (
       SELECT publication_id, student_id
       FROM featured_question_set_reads
       WHERE read_at >= @window_start
       GROUP BY publication_id, student_id
     ) t) AS opened_count,
  (SELECT COUNT(*)
     FROM (
       SELECT featured_publication_id, student_id
       FROM special_practice_sessions
       WHERE featured_publication_id IS NOT NULL
         AND completed_at IS NOT NULL
         AND started_at >= @window_start
       GROUP BY featured_publication_id, student_id
     ) t) AS completed_count;
