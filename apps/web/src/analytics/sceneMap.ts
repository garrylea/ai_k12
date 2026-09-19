import type { SceneInfo, StudyModule, StudyScene } from './types';

/** 一条映射规则：正则命中即返回（**按顺序**匹配，具体路径必须在通配之前）。 */
interface Rule {
  pattern: RegExp;
  module: StudyModule | null;
  scene: StudyScene | null;
  isStudyScene: boolean;
}

/**
 * 路由 → scene 的**唯一真源**（spec §5.3）。
 *
 * 服务端**不维护第二份表**：它按 route 前缀推导自己的 module（与前端的 pathname 无关）。
 * 因此这里改规则不需要同步后端——但 `module` / `scene` 的**取值**必须落在后端白名单内
 * （`study-sessions.service.ts` 的 `STUDY_MODULES` / `STUDY_SCENES`），否则会话会被 1001 拒掉。
 *
 * 顺序敏感：`/student/training/chinese/dictation/run` 必须排在
 * `/student/training/...` 的通配之前——所以这里**不用**通配，只列具体路径。
 */
const RULES: Rule[] = [
  // ---- 学习场景（开会话）----
  { pattern: /^\/student\/course-detail/, module: 'mainline', scene: 'course_detail', isStudyScene: true },
  { pattern: /^\/student\/auxiliary\/?$/, module: 'aux_qna', scene: 'aux_chat', isStudyScene: true },
  { pattern: /^\/student\/training\/targeted\/run/, module: 'training_targeted', scene: 'targeted_run', isStudyScene: true },
  { pattern: /^\/student\/training\/errors\/run/, module: 'training_error_practice', scene: 'error_run', isStudyScene: true },
  { pattern: /^\/student\/training\/exam\/run/, module: 'exam', scene: 'exam_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/dictation\/run/, module: 'chinese_dictation', scene: 'dictation_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/interpretation\/run/, module: 'chinese_interpretation', scene: 'interpretation_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/meaning\/run/, module: 'chinese_meaning', scene: 'meaning_run', isStudyScene: true },
  { pattern: /^\/student\/training\/english\/vocabulary\/run/, module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true },

  // ---- 非学习场景（只定位，不算时长）----
  { pattern: /^\/student\/star-map/, module: 'mainline', scene: 'star_map', isStudyScene: false },
  { pattern: /^\/student\/profile/, module: null, scene: 'profile', isStudyScene: false },
  { pattern: /^\/student\/rewards/, module: null, scene: 'rewards', isStudyScene: false },
  { pattern: /^\/parent\//, module: 'parent', scene: 'parent_dashboard', isStudyScene: false },
  { pattern: /^\/admin\//, module: 'admin', scene: 'admin_dashboard', isStudyScene: false },

  // ---- 完全不记（module/scene 都是 null）----
  // 学科选择 / 入口选择 / 配置页：家长在「挑题 10 分钟」不该被算成学习时长。
  { pattern: /^\/student\/(subjects|entry)/, module: null, scene: null, isStudyScene: false },
  { pattern: /^\/(login|register)\/?$/, module: null, scene: null, isStudyScene: false },
];

const NOT_TRACKED: SceneInfo = { module: null, scene: null, isStudyScene: false };

/**
 * pathname → `{ module, scene, isStudyScene }`。
 *
 * 先剥掉 query / hash：同页带参数跳转（如翻页 `?page=2`）不应被当成新场景而重开会话。
 * 未命中任何规则 → 完全不记（返回全 null），**不猜**——猜错会污染时长统计。
 */
export function mapScene(pathname: string): SceneInfo {
  const path = pathname.split('?')[0].split('#')[0];
  for (const rule of RULES) {
    if (rule.pattern.test(path)) {
      return { module: rule.module, scene: rule.scene, isStudyScene: rule.isStudyScene };
    }
  }
  return NOT_TRACKED;
}

/** 会话去重键：同一场景的重复 `onRouteChange` 不重开会话。 */
export function sceneKey(info: SceneInfo): string | null {
  if (!info.isStudyScene || !info.module || !info.scene) return null;
  return `${info.module}/${info.scene}`;
}
