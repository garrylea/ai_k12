-- 初中物理知识点两级树种子（subject_id=4, grade_band='junior'）。
-- 2026-10-30 人工拟定：一级 12 类，二级 72 个，对标人教版初中物理四册教材目录
--   （八上：机械运动/声/物态变化/光/透镜/质量密度；八下：力/运动/压强/浮力/功和能/简单机械；
--     九年级：内能/内能的利用/电流电路/电压电阻/欧姆定律/电功率/生活用电/电与磁/信息能源）。
-- code 前缀 P（数学为 M、语文为 C），一级 P01 / 二级 P0101。
-- 幂等：knowledge_points 无唯一约束，逐行 NOT EXISTS 防重，可重复执行。

-- 一级
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, NULL, p.name, p.code, 'junior' FROM (
  SELECT 'P01' AS code, '机械运动与声' AS name UNION ALL
  SELECT 'P02', '物态变化' UNION ALL
  SELECT 'P03', '光现象与透镜' UNION ALL
  SELECT 'P04', '质量与密度' UNION ALL
  SELECT 'P05', '力与运动' UNION ALL
  SELECT 'P06', '压强与浮力' UNION ALL
  SELECT 'P07', '功、机械能与简单机械' UNION ALL
  SELECT 'P08', '内能与热机' UNION ALL
  SELECT 'P09', '电流与电路' UNION ALL
  SELECT 'P10', '电压、电阻与欧姆定律' UNION ALL
  SELECT 'P11', '电功率与生活用电' UNION ALL
  SELECT 'P12', '电与磁、能源'
) p
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior'
    AND k.parent_kp_id IS NULL AND k.code = p.code
);

-- 机械运动与声
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0101' AS code, '长度与时间的测量' AS name UNION ALL
  SELECT 'P0102', '运动的描述与参照物' UNION ALL
  SELECT 'P0103', '速度的计算与测量' UNION ALL
  SELECT 'P0104', '声音的产生与传播' UNION ALL
  SELECT 'P0105', '声音的特性' UNION ALL
  SELECT 'P0106', '噪声的危害与控制'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P01'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 物态变化
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0201' AS code, '温度与温度计' AS name UNION ALL
  SELECT 'P0202', '熔化和凝固' UNION ALL
  SELECT 'P0203', '汽化和液化' UNION ALL
  SELECT 'P0204', '升华和凝华'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P02'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 光现象与透镜
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0301' AS code, '光的直线传播' AS name UNION ALL
  SELECT 'P0302', '光的反射与平面镜成像' UNION ALL
  SELECT 'P0303', '光的折射' UNION ALL
  SELECT 'P0304', '光的色散' UNION ALL
  SELECT 'P0305', '凸透镜成像规律' UNION ALL
  SELECT 'P0306', '眼睛与视力矫正'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P03'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 质量与密度
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0401' AS code, '质量及其测量' AS name UNION ALL
  SELECT 'P0402', '密度的概念与计算' UNION ALL
  SELECT 'P0403', '测量物质的密度' UNION ALL
  SELECT 'P0404', '密度与社会生活'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P04'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 力与运动
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0501' AS code, '力的作用效果与三要素' AS name UNION ALL
  SELECT 'P0502', '弹力与弹簧测力计' UNION ALL
  SELECT 'P0503', '重力' UNION ALL
  SELECT 'P0504', '摩擦力' UNION ALL
  SELECT 'P0505', '牛顿第一定律与惯性' UNION ALL
  SELECT 'P0506', '二力平衡' UNION ALL
  SELECT 'P0507', '力与运动的关系'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P05'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 压强与浮力
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0601' AS code, '压力与压强' AS name UNION ALL
  SELECT 'P0602', '液体压强' UNION ALL
  SELECT 'P0603', '大气压强' UNION ALL
  SELECT 'P0604', '流体压强与流速的关系' UNION ALL
  SELECT 'P0605', '浮力与阿基米德原理' UNION ALL
  SELECT 'P0606', '物体的浮沉条件及应用'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P06'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 功、机械能与简单机械
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0701' AS code, '功的计算与判断' AS name UNION ALL
  SELECT 'P0702', '功率' UNION ALL
  SELECT 'P0703', '动能与势能' UNION ALL
  SELECT 'P0704', '机械能及其转化' UNION ALL
  SELECT 'P0705', '杠杆及其平衡条件' UNION ALL
  SELECT 'P0706', '滑轮与滑轮组' UNION ALL
  SELECT 'P0707', '机械效率'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P07'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 内能与热机
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0801' AS code, '分子热运动' AS name UNION ALL
  SELECT 'P0802', '内能' UNION ALL
  SELECT 'P0803', '比热容' UNION ALL
  SELECT 'P0804', '热量的计算' UNION ALL
  SELECT 'P0805', '热机与热机效率'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P08'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 电流与电路
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P0901' AS code, '电荷与摩擦起电' AS name UNION ALL
  SELECT 'P0902', '电路的组成与连接' UNION ALL
  SELECT 'P0903', '串联和并联电路' UNION ALL
  SELECT 'P0904', '电流及其测量' UNION ALL
  SELECT 'P0905', '串并联电路的电流规律' UNION ALL
  SELECT 'P0906', '电路故障分析'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P09'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 电压、电阻与欧姆定律
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P1001' AS code, '电压及其测量' AS name UNION ALL
  SELECT 'P1002', '串并联电路的电压规律' UNION ALL
  SELECT 'P1003', '电阻及其影响因素' UNION ALL
  SELECT 'P1004', '变阻器' UNION ALL
  SELECT 'P1005', '欧姆定律' UNION ALL
  SELECT 'P1006', '伏安法测电阻' UNION ALL
  SELECT 'P1007', '动态电路分析'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P10'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 电功率与生活用电
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P1101' AS code, '电功与电能' AS name UNION ALL
  SELECT 'P1102', '电功率' UNION ALL
  SELECT 'P1103', '额定功率与实际功率' UNION ALL
  SELECT 'P1104', '焦耳定律' UNION ALL
  SELECT 'P1105', '测量小灯泡的电功率' UNION ALL
  SELECT 'P1106', '家庭电路与安全用电'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P11'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);

-- 电与磁、能源
INSERT INTO knowledge_points (subject_id, parent_kp_id, name, code, grade_band)
SELECT 4, p.id, c.name, c.code, 'junior' FROM (
  SELECT 'P1201' AS code, '磁现象与磁场' AS name UNION ALL
  SELECT 'P1202', '电流的磁效应' UNION ALL
  SELECT 'P1203', '电磁铁与电磁继电器' UNION ALL
  SELECT 'P1204', '电动机' UNION ALL
  SELECT 'P1205', '电磁感应与发电机' UNION ALL
  SELECT 'P1206', '信息的传递' UNION ALL
  SELECT 'P1207', '能源的分类与核能' UNION ALL
  SELECT 'P1208', '能量守恒定律'
) c JOIN knowledge_points p ON p.subject_id = 4 AND p.grade_band = 'junior' AND p.parent_kp_id IS NULL AND p.code = 'P12'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_points k
  WHERE k.subject_id = 4 AND k.grade_band = 'junior' AND k.code = c.code
);
