-- 2026-11-06：数学/物理专项新增 2 题档（5 分），给存量学生补规则并重排档位顺序。
-- 幂等：INSERT IGNORE 撞 uniq_point_rules(student_id, task_code, tier_key) 即跳过；
-- UPDATE 按 CASE 重算固定 sort_order，重跑结果不变（未命中任何 WHEN 时 ELSE 保留原值）。
--
-- 2 题档继承该生该任务码的启用状态：已有档位全是 is_active=0（家长关掉了整组）时，
-- 新档位也插成 0，不能凭迁移悄悄把已停用的任务重新打开；否则插 1（默认启用）。
INSERT IGNORE INTO point_rules
  (student_id, task_code, tier_key, tier_label, points, daily_limit, sort_order, is_active)
SELECT student_id, task_code, '2', '2 题', 5, 5,
       CASE task_code WHEN 'math_targeted' THEN 31 ELSE 101 END,
       CASE WHEN MAX(is_active) = 0 THEN 0 ELSE 1 END
FROM point_rules
WHERE task_code IN ('math_targeted', 'physics_targeted')
GROUP BY student_id, task_code;

UPDATE point_rules
SET sort_order = CASE task_code
  WHEN 'math_targeted' THEN
    CASE tier_key WHEN '1' THEN 30 WHEN '2' THEN 31 WHEN '3' THEN 32 WHEN '5' THEN 33 WHEN '10' THEN 34 END
  WHEN 'physics_targeted' THEN
    CASE tier_key WHEN '1' THEN 100 WHEN '2' THEN 101 WHEN '3' THEN 102 WHEN '5' THEN 103 WHEN '10' THEN 104 END
  ELSE sort_order
END
WHERE task_code IN ('math_targeted', 'physics_targeted');
