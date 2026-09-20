/**
 * 埋点会话的封闭字典。
 *
 * 后端 `study-sessions.service.ts` 的 `STUDY_MODULES` / `STUDY_SCENES` 是**权威白名单**，
 * 本文件的 `StudyModule` / `StudyScene` 是它的**超集**——多出 `admin` / `parent` /
 * `parent_dashboard` / `admin_dashboard` 四个值（spec §5.1 的枚举含它们，用于 `page_view`
 * 之类事件的**归属**，家长端/管理端永不启动会话）。
 *
 * 这四个值后端**不认**（`start()` 会以 1001 拒掉并且前端无声），所以**开会话的闸门必须是
 * `sceneKey(info) !== null`（或 `info.isStudyScene`），绝不能写成 `module != null`**——
 * 后者会把 `admin` / `parent` 送去 `start()`，会话静默丢失。
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

/**
 * `end()` 的结束原因 / `heartbeat()` 的前端可见性——**成员镜像后端的权威枚举**
 * （`apps/server/src/modules/analytics/study-sessions.service.ts` 的 `END_REASONS` 等）。
 *
 * 后端对这两个字段**硬校验**：认不出的值直接回 1001，且会话被**静默丢弃**
 * （不报错、家长端时长永远少一段）。所以这里是**唯一声明**，
 * `services/api.ts` 从这里导入（别再在 wire 层复制一份）——改后端枚举时，
 * 只需改这一处，且必须与后端同时改。
 */
export type EndReason = 'route_change' | 'pagehide' | 'idle_timeout' | 'closed' | 'hidden_timeout';

export type ClientState = 'visible' | 'hidden';

/**
 * 挂机原因（spec §3.3）。**唯一声明**：服务端 `HeartbeatSchema` 的 `reason` 枚举、
 * 前端 tracker 上报都从这里取——改这里必须同时改后端。
 * `away` = 页面被切走（visibilitychange）；`idle` = 前台无操作（120s 无输入）。
 */
export type HiddenReason = 'away' | 'idle';

export type ScreenClass = 'ipad_landscape' | 'desktop' | 'tablet_portrait' | 'mobile';
export type InputType = 'touch' | 'mouse' | 'hybrid';
export type AppShell = 'web' | 'electron';

export interface SceneInfo {
  module: StudyModule | null;
  scene: StudyScene | null;
  /** `true` = 该路由算「学习」，要开会话；配置页/入口页只管看，不算时长。 */
  isStudyScene: boolean;
}

/**
 * 会话标识（`study_sessions.session_uid`）。
 *
 * 必须是**合法 UUID 形状**：后端 `UUID_RE` 只认 `8-4-4-4-12` 十六进制，不合法就直接 1001，
 * 而那意味着**会话静默全丢**（没有任何提示，家长端时长永远是空）。
 *
 * 为什么不能只用 `crypto.randomUUID()`：它**只在安全上下文**存在。`http://localhost` 算安全，
 * 但本产品的主断点是 **iPad 横屏**，开发时通常用 `http://192.168.x.x:5173` 这类局域网地址打开——
 * 那不是安全上下文，`randomUUID` 是 undefined。所以回退分支**不是**防御性代码，是会被真实走到的。
 *
 * `crypto.getRandomValues` 不受安全上下文限制，用它拼 v4 形状；只有连它都没有时才退到 Math.random。
 */
export function newSessionUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 按 RFC 4122 打上 v4 的版本位与变体位——形状对了后端才收
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
