-- 补初中数学 KP 树：相交线与平行线章（M09）
-- 2026-09-06。背景：71 个 KP 种子缺该整章，试卷题涉及的对顶角/邻补角/垂线/平行线
-- 无法从已有列表标注，LLM 双模型均判"新增"。本文档补齐，避免确认新 KP 反复出现。
-- 幂等：逐行 NOT EXISTS 防重（同 generate_kp_tree 模式），可重复执行。
-- 执行：mysql ... < 本文件（或 refinery db_loader 环境）

-- ===== M09 相交线与平行线 =====
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '相交线与平行线', 'M09', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '相交线与平行线'
);

-- M0901 相交线（对顶角、邻补角）
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '相交线', 'M0901', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '相交线'
);

-- M0902 垂线（垂直的定义、垂线段最短、点到直线的距离）
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '垂线', 'M0902', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '垂线'
);

-- M0903 同位角、内错角、同旁内角（三线八角）
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '同位角、内错角、同旁内角', 'M0903', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '同位角、内错角、同旁内角'
);

-- M0904 平行线的判定
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '平行线的判定', 'M0904', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平行线的判定'
);

-- M0905 平行线的性质
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '平行线的性质', 'M0905', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平行线的性质'
);

-- M0906 命题、定理与证明
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '命题、定理与证明', 'M0906', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '命题、定理与证明'
);

-- M0907 平行线间的距离
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '平行线间的距离', 'M0907', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '相交线与平行线'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平行线间的距离'
);
