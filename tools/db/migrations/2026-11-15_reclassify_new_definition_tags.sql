-- 2026-11-15：新定义二级模型拆分（坐标 / 纯几何 / 代数）。
-- 现有 11 道 geometry_new_definition 中，10 道是坐标系里的点/线/圆/变换定义，
-- 1 道（6716，“m-相关函数”）是函数关系定义；分别迁到 coordinate / algebra。
-- 幂等：重复执行时 WHERE model='geometry_new_definition' 已无命中。

UPDATE question_model_tags
SET model = 'coordinate_new_definition', model_name = '坐标新定义'
WHERE category = 'new_definition'
  AND model = 'geometry_new_definition'
  AND question_id IN (4374, 4402, 4426, 4781, 4836, 4919, 6642, 6689, 7089, 7091);

UPDATE question_model_tags
SET model = 'algebra_new_definition', model_name = '代数新定义'
WHERE category = 'new_definition'
  AND model = 'geometry_new_definition'
  AND question_id = 6716;
