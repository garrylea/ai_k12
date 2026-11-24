-- 初中英语知识点两级树种子（subject_id=3, grade_band='junior'）。
-- 2026-11-24 人工拟定：一级 7 类（语法 / 词汇 / 完形填空 / 阅读理解 / 写作与表达 / 听力 / 情景交际），二级 28 个。
-- code 前缀 E（数学为 M、语文为 C、物理为 P），一级 E01 / 二级 E0101。
-- code 与 name 与 tools/data-refinery/src/prompts/question_kps/english.txt 的类目对齐，勿改字面。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 一级
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, NULL, p.name, p.code, 'junior' FROM (
  SELECT 'E01' AS code, '语法' AS name UNION ALL
  SELECT 'E02', '词汇' UNION ALL
  SELECT 'E03', '完形填空' UNION ALL
  SELECT 'E04', '阅读理解' UNION ALL
  SELECT 'E05', '写作与表达' UNION ALL
  SELECT 'E06', '听力' UNION ALL
  SELECT 'E07', '情景交际'
) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior'
    AND k.parent_kp_id IS NULL AND k.code = p.code
);

-- 语法
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0101' AS code, '时态' AS name UNION ALL
  SELECT 'E0102', '语态' UNION ALL
  SELECT 'E0103', '从句' UNION ALL
  SELECT 'E0104', '非谓语动词' UNION ALL
  SELECT 'E0105', '情态动词' UNION ALL
  SELECT 'E0106', '比较级与最高级' UNION ALL
  SELECT 'E0107', '介词与连词'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E01'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 词汇
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0201' AS code, '词义辨析' AS name UNION ALL
  SELECT 'E0202', '固定搭配' UNION ALL
  SELECT 'E0203', '词形变化' UNION ALL
  SELECT 'E0204', '构词法' UNION ALL
  SELECT 'E0205', '熟词僻义'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E02'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 完形填空
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0301' AS code, '上下文推断' AS name UNION ALL
  SELECT 'E0302', '逻辑衔接' UNION ALL
  SELECT 'E0303', '词义复现'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E03'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 阅读理解
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0401' AS code, '细节理解' AS name UNION ALL
  SELECT 'E0402', '推理判断' UNION ALL
  SELECT 'E0403', '主旨大意' UNION ALL
  SELECT 'E0404', '标题归纳' UNION ALL
  SELECT 'E0405', '词义猜测'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E04'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 写作与表达
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0501' AS code, '信息提取' AS name UNION ALL
  SELECT 'E0502', '观点表达' UNION ALL
  SELECT 'E0503', '文段表达' UNION ALL
  SELECT 'E0504', '书面表达'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E05'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 听力
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0601' AS code, '对话理解' AS name UNION ALL
  SELECT 'E0602', '独白理解'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E06'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 情景交际
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 3, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'E0701' AS code, '情景问答' AS name UNION ALL
  SELECT 'E0702', '交际用语'
) c JOIN knowledge_points p ON p.subject_id = 3 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'E07'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 3 AND k.grade_band = 'junior' AND k.code = c.code
);
