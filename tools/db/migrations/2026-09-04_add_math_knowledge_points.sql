-- 生成于 2026-09-04，模型：Qwen3.8-27B，一级 8 个 / 二级 63 个。
-- 初中数学知识点两级树种子（subject_id=1, grade_band='junior'）。
-- 由 tools/data-refinery/src/generate_kp_tree.py 生成，产出需人工过目后执行。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 数与式
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '数与式', 'M01', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '数与式'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '有理数的概念与分类', 'M0101', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '有理数的概念与分类'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '数轴与相反数', 'M0102', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '数轴与相反数'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '绝对值', 'M0103', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '绝对值'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '有理数的运算', 'M0104', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '有理数的运算'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '科学记数法', 'M0105', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '科学记数法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '近似数', 'M0106', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '近似数'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '实数与平方根、立方根', 'M0107', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '实数与平方根、立方根'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '整式的概念', 'M0108', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '整式的概念'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '整式的加减', 'M0109', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '整式的加减'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '幂的运算', 'M0110', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '幂的运算'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '整式的乘法与公式', 'M0111', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '整式的乘法与公式'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '因式分解', 'M0112', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '因式分解'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '分式的概念与性质', 'M0113', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '分式的概念与性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '分式的运算', 'M0114', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '数与式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '分式的运算'
);

-- 方程与不等式
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '方程与不等式', 'M02', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '方程与不等式'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一元一次方程的解法', 'M0201', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一元一次方程的解法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '二元一次方程组的解法', 'M0202', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '二元一次方程组的解法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一元二次方程的解法', 'M0203', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一元二次方程的解法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '分式方程的解法', 'M0204', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '分式方程的解法'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一元二次方程根的判别式', 'M0205', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一元二次方程根的判别式'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一元一次不等式（组）的解法', 'M0206', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '方程与不等式'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一元一次不等式（组）的解法'
);

-- 函数
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '函数', 'M03', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '函数'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '平面直角坐标系', 'M0301', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平面直角坐标系'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '函数的概念', 'M0302', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '函数的概念'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一次函数的图象与性质', 'M0303', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一次函数的图象与性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '一次函数与方程、不等式的关系', 'M0304', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '一次函数与方程、不等式的关系'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '反比例函数的图象与性质', 'M0305', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '反比例函数的图象与性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '二次函数的图象与性质', 'M0306', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '二次函数的图象与性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '二次函数与一元二次方程', 'M0307', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '二次函数与一元二次方程'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '用函数观点看实际问题', 'M0308', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '函数'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '用函数观点看实际问题'
);

-- 三角形
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '三角形', 'M04', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '三角形'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '三角形的相关概念', 'M0401', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '三角形的相关概念'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '三角形内角和定理', 'M0402', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '三角形内角和定理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '三角形的外角性质', 'M0403', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '三角形的外角性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '三角形三边关系', 'M0404', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '三角形三边关系'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '全等三角形的判定', 'M0405', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '全等三角形的判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '全等三角形的性质', 'M0406', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '全等三角形的性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '等腰三角形的性质与判定', 'M0407', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '等腰三角形的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '直角三角形的性质', 'M0408', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '直角三角形的性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '勾股定理及其逆定理', 'M0409', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '勾股定理及其逆定理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '三角形的中位线定理', 'M0410', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '三角形的中位线定理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '相似三角形的判定与性质', 'M0411', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '三角形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '相似三角形的判定与性质'
);

-- 四边形
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '四边形', 'M05', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '四边形'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '多边形及其内角和', 'M0501', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '多边形及其内角和'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '平行四边形的性质与判定', 'M0502', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '平行四边形的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '矩形的性质与判定', 'M0503', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '矩形的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '菱形的性质与判定', 'M0504', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '菱形的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '正方形的性质与判定', 'M0505', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '正方形的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '梯形的性质与判定', 'M0506', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '四边形'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '梯形的性质与判定'
);

-- 圆
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '圆', 'M06', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '圆'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '圆的有关性质', 'M0601', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '圆的有关性质'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '点、直线、圆的位置关系', 'M0602', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '点、直线、圆的位置关系'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '圆周角定理', 'M0603', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '圆周角定理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '垂径定理', 'M0604', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '垂径定理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '切线的性质与判定', 'M0605', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '切线的性质与判定'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '弧长与扇形面积', 'M0606', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '圆'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '弧长与扇形面积'
);

-- 图形变换
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '图形变换', 'M07', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '图形变换'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '图形的平移', 'M0701', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '图形变换'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '图形的平移'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '图形的旋转', 'M0702', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '图形变换'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '图形的旋转'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '图形的轴对称', 'M0703', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '图形变换'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '图形的轴对称'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '图形的位似', 'M0704', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '图形变换'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '图形的位似'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '投影与视图', 'M0705', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '图形变换'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '投影与视图'
);

-- 统计与概率
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, NULL, '统计与概率', 'M08', 'junior' FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points
  WHERE subject_id = 1 AND grade_band = 'junior'
    AND parent_kp_id IS NULL AND name = '统计与概率'
);

INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '数据的收集与整理', 'M0801', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '数据的收集与整理'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '条形统计图与折线统计图', 'M0802', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '条形统计图与折线统计图'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '扇形统计图', 'M0803', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '扇形统计图'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '数据的代表数（平均数、中位数、众数）', 'M0804', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '数据的代表数（平均数、中位数、众数）'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '数据的波动程度（方差、极差）', 'M0805', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '数据的波动程度（方差、极差）'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '随机事件与概率', 'M0806', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '随机事件与概率'
);
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 1, p.id, '用列举法求概率', 'M0807', 'junior'
FROM (SELECT id FROM knowledge_points
      WHERE subject_id = 1 AND grade_band = 'junior'
        AND parent_kp_id IS NULL AND name = '统计与概率'
      LIMIT 1) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points c
  WHERE c.subject_id = 1 AND c.grade_band = 'junior'
    AND c.parent_kp_id = p.id AND c.name = '用列举法求概率'
);
