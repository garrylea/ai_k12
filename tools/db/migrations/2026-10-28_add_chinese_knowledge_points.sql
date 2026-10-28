-- 初中语文知识点两级树种子（subject_id=2, grade_band='junior'）。
-- 2026-10-28 人工拟定：一级 4 类（积累与运用 / 古诗文 / 现代文阅读 / 写作），二级 29 个。
-- code 前缀 C（数学为 M），一级 C01 / 二级 C0101。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 一级
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 2, NULL, p.name, p.code, 'junior' FROM (
  SELECT 'C01' AS code, '积累与运用' AS name UNION ALL
  SELECT 'C02', '古诗文' UNION ALL
  SELECT 'C03', '现代文阅读' UNION ALL
  SELECT 'C04', '写作'
) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 2 AND k.grade_band = 'junior'
    AND k.parent_kp_id IS NULL AND k.code = p.code
);

-- 积累与运用
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 2, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'C0101' AS code, '字词（字音字形）' AS name UNION ALL
  SELECT 'C0102' AS code, '词语与成语' AS name UNION ALL
  SELECT 'C0103' AS code, '标点符号' AS name UNION ALL
  SELECT 'C0104' AS code, '病句辨析与修改' AS name UNION ALL
  SELECT 'C0105' AS code, '书法' AS name UNION ALL
  SELECT 'C0106' AS code, '对联' AS name UNION ALL
  SELECT 'C0107' AS code, '修辞与语言运用' AS name UNION ALL
  SELECT 'C0108' AS code, '句子衔接与补写' AS name UNION ALL
  SELECT 'C0109' AS code, '文学文化常识' AS name UNION ALL
  SELECT 'C0110' AS code, '名著阅读' AS name
) c JOIN knowledge_points p ON p.subject_id = 2 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'C01'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 2 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 古诗文
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 2, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'C0201' AS code, '古诗文默写' AS name UNION ALL
  SELECT 'C0202' AS code, '古诗理解与鉴赏' AS name UNION ALL
  SELECT 'C0203' AS code, '文言实词与虚词' AS name UNION ALL
  SELECT 'C0204' AS code, '文言断句与翻译' AS name UNION ALL
  SELECT 'C0205' AS code, '古文内容理解' AS name
) c JOIN knowledge_points p ON p.subject_id = 2 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'C02'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 2 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 现代文阅读
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 2, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'C0301' AS code, '内容概括与信息筛选' AS name UNION ALL
  SELECT 'C0302' AS code, '词句理解与赏析' AS name UNION ALL
  SELECT 'C0303' AS code, '人物形象（人物特点）' AS name UNION ALL
  SELECT 'C0304' AS code, '中心思想与主旨' AS name UNION ALL
  SELECT 'C0305' AS code, '表达方式' AS name UNION ALL
  SELECT 'C0306' AS code, '写作手法（表现手法与结构）' AS name UNION ALL
  SELECT 'C0307' AS code, '说明方法与说明文阅读' AS name UNION ALL
  SELECT 'C0308' AS code, '论证方法与议论文阅读' AS name UNION ALL
  SELECT 'C0309' AS code, '开放性探究与迁移' AS name
) c JOIN knowledge_points p ON p.subject_id = 2 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'C03'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 2 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 写作
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 2, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'C0401' AS code, '命题作文' AS name UNION ALL
  SELECT 'C0402' AS code, '半命题作文' AS name UNION ALL
  SELECT 'C0403' AS code, '材料作文' AS name UNION ALL
  SELECT 'C0404' AS code, '话题作文' AS name UNION ALL
  SELECT 'C0405' AS code, '应用文写作' AS name
) c JOIN knowledge_points p ON p.subject_id = 2 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'C04'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 2 AND k.grade_band = 'junior' AND k.code = c.code
);
