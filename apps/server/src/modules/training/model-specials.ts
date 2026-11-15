/** 已审核上线的模型专项白名单。加模型只改这里。 */
export interface ModelSpecial {
  category: string;
  categoryName: string;
  model: string;
  modelName: string;
}

export const MODEL_SPECIALS: readonly ModelSpecial[] = [
  // 几何综合
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'median_doubling',
    modelName: '倍长中线',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'hand_in_hand',
    modelName: '手拉手',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'rotation_similarity',
    modelName: '旋转相似',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'midpoint_model',
    modelName: '中点模型',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'axisymmetry_construction',
    modelName: '轴对称构造',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'three_equal_angles',
    modelName: '一线三等角',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'angle_bisector',
    modelName: '角平分线模型',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'area_method',
    modelName: '面积法',
  },
  {
    category: 'geometry_synthesis',
    categoryName: '几何综合',
    model: 'translation_construction',
    modelName: '平移构造',
  },
  // 圆综
  {
    category: 'circle_synthesis',
    categoryName: '圆综',
    model: 'tangent',
    modelName: '切线判定与性质',
  },
  {
    category: 'circle_synthesis',
    categoryName: '圆综',
    model: 'inscribed_angle',
    modelName: '圆周角与圆内接四边形',
  },
  {
    category: 'circle_synthesis',
    categoryName: '圆综',
    model: 'perpendicular_chord',
    modelName: '垂径定理',
  },
  {
    category: 'circle_synthesis',
    categoryName: '圆综',
    model: 'similarity_trig',
    modelName: '相似与三角函数',
  },
  // 最值问题
  {
    category: 'extremum',
    categoryName: '最值问题',
    model: 'hidden_circle',
    modelName: '隐圆',
  },
  {
    category: 'extremum',
    categoryName: '最值问题',
    model: 'point_circle_extremum',
    modelName: '点圆最值',
  },
  {
    category: 'extremum',
    categoryName: '最值问题',
    model: 'hu_bu_gui',
    modelName: '胡不归',
  },
  // 代数综合
  {
    category: 'algebra_synthesis',
    categoryName: '代数综合',
    model: 'quadratic_equation',
    modelName: '二次函数与方程',
  },
  {
    category: 'algebra_synthesis',
    categoryName: '代数综合',
    model: 'parameter_discussion',
    modelName: '含参讨论',
  },
  {
    category: 'algebra_synthesis',
    categoryName: '代数综合',
    model: 'vieta',
    modelName: '根与系数关系',
  },
  // 函数与图象
  {
    category: 'function_graph',
    categoryName: '函数与图象',
    model: 'basic_graphs',
    modelName: '一次/反比例/二次图象',
  },
  {
    category: 'function_graph',
    categoryName: '函数与图象',
    model: 'graph_transform',
    modelName: '图象变换',
  },
  {
    category: 'function_graph',
    categoryName: '函数与图象',
    model: 'graph_inequality',
    modelName: '图象与不等式',
  },
  // 统计与概率
  {
    category: 'stats_probability',
    categoryName: '统计与概率',
    model: 'probability_calc',
    modelName: '概率计算',
  },
  {
    category: 'stats_probability',
    categoryName: '统计与概率',
    model: 'data_representatives',
    modelName: '数据代表数',
  },
  {
    category: 'stats_probability',
    categoryName: '统计与概率',
    model: 'statistical_charts',
    modelName: '统计图表',
  },
  {
    category: 'stats_probability',
    categoryName: '统计与概率',
    model: 'variance',
    modelName: '方差',
  },
  // 实际应用
  {
    category: 'application',
    categoryName: '实际应用',
    model: 'equation_modeling',
    modelName: '方程建模',
  },
  {
    category: 'application',
    categoryName: '实际应用',
    model: 'function_modeling',
    modelName: '函数建模',
  },
  // 新定义
  {
    category: 'new_definition',
    categoryName: '新定义',
    model: 'coordinate_new_definition',
    modelName: '坐标新定义',
  },
  {
    category: 'new_definition',
    categoryName: '新定义',
    model: 'algebra_new_definition',
    modelName: '代数新定义',
  },
];

export function findModelSpecial(
  category: unknown,
  model: unknown,
): ModelSpecial | null {
  if (typeof category !== 'string' || typeof model !== 'string') return null;
  return MODEL_SPECIALS.find(
    (s) => s.category === category && s.model === model,
  ) ?? null;
}
