-- 2026-11-18：修复专项档位顺序错位（1、3、2、5）。
-- 根因：2026-11-06 的 add_targeted_2_tier 只落库了 INSERT 部分，重排 sort_order 的 UPDATE
-- 未生效，导致 3 题档（31）与 2 题档（31）撞序，按 sort_order,id 排成 1、3、2、5。
-- 幂等：按 task_code + tier_key 重算固定 sort_order；未命中的档位保留原值（内层 CASE 带 ELSE，
-- 避免出现 NULL 违反 NOT NULL）。重跑结果不变。
UPDATE point_rules
SET sort_order = CASE task_code
  WHEN 'math_targeted' THEN
    CASE tier_key
      WHEN '1' THEN 30 WHEN '2' THEN 31 WHEN '3' THEN 32 WHEN '5' THEN 33 WHEN '10' THEN 34
      ELSE sort_order
    END
  WHEN 'physics_targeted' THEN
    CASE tier_key
      WHEN '1' THEN 100 WHEN '2' THEN 101 WHEN '3' THEN 102 WHEN '5' THEN 103 WHEN '10' THEN 104
      ELSE sort_order
    END
  ELSE sort_order
END
WHERE task_code IN ('math_targeted', 'physics_targeted');
