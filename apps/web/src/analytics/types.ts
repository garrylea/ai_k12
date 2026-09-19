/**
 * 埋点会话的封闭字典（与后端 `study-sessions.service.ts` 的白名单**逐字一致**）。
 *
 * 服务端是权威：字典不匹配的 module/scene 会被 1001 拒掉。这里保留 `admin` / `parent`
 * 是因为 spec §5.1 的 module 枚举含它们（用于 `page_view` 之类事件的归属），
 * 但**只有 `isStudyScene` 为真的路由才会开会话**——家长端/管理端永不启动会话。
 */
export type StudyModule =
  | 'mainline'
  | 'aux_qna'
  | 'training_targeted'
  | 'training_error_practice'
  | 'exam'
  | 'chinese_dictation'
  | 'chinese_interpretation'
  | 'chinese_meaning'
  | 'en_vocabulary'
  | 'admin'
  | 'parent';

export type StudyScene =
  | 'course_detail'
  | 'star_map'
  | 'aux_chat'
  | 'targeted_run'
  | 'error_run'
  | 'exam_run'
  | 'dictation_run'
  | 'interpretation_run'
  | 'meaning_run'
  | 'vocabulary_run'
  | 'profile'
  | 'rewards'
  | 'parent_dashboard'
  | 'admin_dashboard';

export type SessionState = 'idle' | 'active' | 'hidden' | 'ended';

export type SessionEvent =
  | 'ROUTE_ENTER'
  | 'ROUTE_LEAVE'
  | 'VISIBLE'
  | 'HIDDEN'
  | 'IDLE_TIMEOUT'
  | 'PAGEHIDE';

export type EndReason = 'route_change' | 'pagehide' | 'idle_timeout' | 'closed' | 'hidden_timeout';

export type ClientState = 'visible' | 'hidden';

export type ScreenClass = 'ipad_landscape' | 'desktop' | 'tablet_portrait' | 'mobile';
export type InputType = 'touch' | 'mouse' | 'hybrid';
export type AppShell = 'web' | 'electron';

export interface SceneInfo {
  module: StudyModule | null;
  scene: StudyScene | null;
  /** `true` = 该路由算「学习」，要开会话；配置页/入口页只管看，不算时长。 */
  isStudyScene: boolean;
}

/** 会话标识：`crypto.randomUUID()`，浏览器不支持时退化为时间戳 + 随机数。 */
export function newSessionUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
