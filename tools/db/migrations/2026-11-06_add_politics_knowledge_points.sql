-- 生成于 2026-11-06，模型：Qwen3.8-27B，一级 8 个 / 二级 68 个。
-- 初中道德与法治知识点两级树种子（subject_id=9, grade_band='junior'）。
-- 由 tools/data-refinery/src/generate_kp_tree.py 生成，产出需人工过目后执行。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 成长的节拍
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '成长的节拍', 'DF01', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '成长的节拍'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中学时代意义', 'DF0101', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中学时代意义'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '正确认识自我', 'DF0102', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '正确认识自我'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '做更好的自己', 'DF0103', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '做更好的自己'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '少年梦想与规划', 'DF0104', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '少年梦想与规划'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '学会学习', 'DF0105', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '学会学习'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '师生关系', 'DF0106', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '师生关系'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '友谊的澄清', 'DF0107', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '成长的节拍'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '友谊的澄清'
);

-- 亲情与生命
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '亲情与生命', 'DF02', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '亲情与生命'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '家的意味', 'DF0201', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '家的意味'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '亲情之爱', 'DF0202', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '亲情之爱'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '孝亲敬长', 'DF0203', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '孝亲敬长'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '珍爱生命', 'DF0204', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '珍爱生命'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '敬畏生命', 'DF0205', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '敬畏生命'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '守护生命', 'DF0206', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '守护生命'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '增强生命韧性', 'DF0207', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '增强生命韧性'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '活出生命的精彩', 'DF0208', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '亲情与生命'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '活出生命的精彩'
);

-- 走进法治天地
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '走进法治天地', 'DF03', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '走进法治天地'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '未成年人保护', 'DF0301', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '未成年人保护'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '依法办事', 'DF0302', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '依法办事'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '宪法是根本法', 'DF0303', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '宪法是根本法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '维护宪法权威', 'DF0304', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '维护宪法权威'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '公民基本权利', 'DF0305', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '公民基本权利'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '依法行使权利', 'DF0306', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '依法行使权利'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '公民基本义务', 'DF0307', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '公民基本义务'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '履行法定义务', 'DF0308', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '履行法定义务'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '违法与犯罪', 'DF0309', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '走进法治天地'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '违法与犯罪'
);

-- 崇尚法治精神
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '崇尚法治精神', 'DF04', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '崇尚法治精神'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '自由与法治', 'DF0401', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '自由与法治'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '平等', 'DF0402', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平等'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '公平正义', 'DF0403', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '公平正义'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '法治政府', 'DF0404', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '法治政府'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '国家权力监督', 'DF0405', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '国家权力监督'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '宪法至上', 'DF0406', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '宪法至上'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '全面依法治国', 'DF0407', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '崇尚法治精神'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '全面依法治国'
);

-- 富强与创新
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '富强与创新', 'DF05', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '富强与创新'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '改革开放', 'DF0501', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '改革开放'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '以人民为中心的发展思想', 'DF0502', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '以人民为中心的发展思想'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '高质量发展', 'DF0503', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '高质量发展'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '新发展理念', 'DF0504', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '新发展理念'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '创新驱动发展战略', 'DF0505', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '创新驱动发展战略'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '科教兴国战略', 'DF0506', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '科教兴国战略'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '人才强国战略', 'DF0507', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '人才强国战略'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '社会主义基本经济制度', 'DF0508', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '社会主义基本经济制度'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '共同富裕', 'DF0509', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '富强与创新'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '共同富裕'
);

-- 民主与法治
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '民主与法治', 'DF06', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '民主与法治'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国特色社会主义进入新时代', 'DF0601', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国特色社会主义进入新时代'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '我国社会主要矛盾', 'DF0602', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '我国社会主要矛盾'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国共产党的初心使命', 'DF0603', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国共产党的初心使命'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '人民代表大会制度', 'DF0604', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '人民代表大会制度'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国共产党领导的多党合作和政治协商制度', 'DF0605', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国共产党领导的多党合作和政治协商制度'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '民族区域自治制度', 'DF0606', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '民族区域自治制度'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '基层群众自治制度', 'DF0607', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '基层群众自治制度'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '全过程人民民主', 'DF0608', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '全过程人民民主'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '依法治国', 'DF0609', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '民主与法治'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '依法治国'
);

-- 文明与家园
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '文明与家园', 'DF07', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '文明与家园'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '社会主义核心价值观', 'DF0701', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '社会主义核心价值观'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中华传统美德', 'DF0702', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中华传统美德'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '民族精神', 'DF0703', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '民族精神'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '伟大建党精神', 'DF0704', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '伟大建党精神'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '文化自信', 'DF0705', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '文化自信'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中华优秀传统文化', 'DF0706', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中华优秀传统文化'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '文化创新', 'DF0707', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '文化创新'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '民族团结', 'DF0708', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '民族团结'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '一国两制', 'DF0709', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一国两制'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '国家安全', 'DF0710', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '国家安全'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '总体国家安全观', 'DF0711', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '总体国家安全观'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '生态文明建设', 'DF0712', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '文明与家园'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '生态文明建设'
);

-- 和谐与梦想
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, NULL, '和谐与梦想', 'DF08', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 9 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '和谐与梦想'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '世界多极化', 'DF0801', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '世界多极化'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '经济全球化', 'DF0802', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '经济全球化'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '国际格局变化', 'DF0803', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '国际格局变化'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国担当', 'DF0804', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国担当'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国智慧', 'DF0805', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国智慧'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '中国方案', 'DF0806', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '中国方案'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 9, p.id, '构建人类命运共同体', 'DF0807', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 9 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '和谐与梦想'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 9 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '构建人类命运共同体'
);
