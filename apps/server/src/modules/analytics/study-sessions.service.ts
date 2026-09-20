import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { StudySessionsRepository } from '../../database/repositories/study-sessions.repo.js';
import type { StudySessionRow } from '../../database/repositories/study-sessions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { SafetyAlertsService } from '../safety/safety-alerts.service.js';
import { parseUserAgent } from '../../common/utils/user-agent.util.js';
import type { PlatformClass } from '../../common/utils/user-agent.util.js';

/**
 * 三个时长阈值（45s 单次封顶 / 5min 惰性收尾 / 前端 30s 心跳间隔）在此**不导出为常量**：
 * 它们只作为 SQL 字面量出现（见 `study-sessions.repo.ts` 的两处 `LEAST(..., 45)` 与
 * `INTERVAL 5 MINUTE`），导出会变成没人引用的死代码。要改封顶值，得同时改那两处 SQL
 * 和守着顺序的 index 钉子测试——不是改一个常量。
 */

/** `module` / `scene` 是封闭字典（spec §5.1）——**唯一真源在后端**，前端 `sceneMap.ts` 只能取这里的值。 */
export const STUDY_MODULES = [
  'mainline',
  'aux_qna',
  'training_targeted',
  'training_error_practice',
  'exam',
  'chinese_dictation',
  'chinese_interpretation',
  'chinese_meaning',
  'en_vocabulary',
] as const;
export type StudyModule = (typeof STUDY_MODULES)[number];

export const STUDY_SCENES = [
  'course_detail',
  'star_map',
  'aux_chat',
  'targeted_run',
  'error_run',
  'exam_run',
  'dictation_run',
  'interpretation_run',
  'meaning_run',
  'vocabulary_run',
  'profile',
  'rewards',
] as const;
export type StudyScene = (typeof STUDY_SCENES)[number];

export const END_REASONS = [
  'route_change',
  'pagehide',
  'idle_timeout',
  'closed',
  'hidden_timeout',
] as const;
export type EndReason = (typeof END_REASONS)[number];

const SCREEN_CLASSES = ['ipad_landscape', 'desktop', 'tablet_portrait', 'mobile'] as const;
const INPUT_TYPES = ['touch', 'mouse', 'hybrid'] as const;
const APP_SHELLS = ['web', 'electron'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 走神原因白名单（spec §3.3）。与前端 `analytics/types.ts` 的 `HiddenReason` **同源**，
 * 也是 `HeartbeatSchema` 的 `reason` 枚举。
 */
type HiddenReason = 'away' | 'idle';
const HIDDEN_REASONS: readonly HiddenReason[] = ['away', 'idle'];

export interface StartSessionInput {
  studentId: number;
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number | null;
  refType?: string | null;
  refId?: number | null;
  screenClass?: string | null;
  inputType?: string | null;
  appShell?: string | null;
  /** 服务端从请求头取，**不接受客户端上报**（伪造 UA 是弱信号，但至少比自报强）。 */
  userAgent?: string | null;
}

/** 白名单命中就取原值，否则 NULL——设备信息是**尽力而为**，非法值不报错（spec §8.1）。 */
function pick<T extends string>(allowed: readonly T[], value: string | null | undefined): T | null {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

@Injectable()
export class StudySessionsService {
  private readonly logger = new Logger(StudySessionsService.name);

  constructor(
    @Inject(StudySessionsRepository) private readonly repo: StudySessionsRepository,
    @Inject('SUBJECTS_REPO_FOR_ANALYTICS') private readonly subjectsRepo: SubjectsRepoLike,
    @Inject(SafetyAlertsService) private readonly safetyAlerts: SafetyAlertsService,
    @Inject(ControlsRepository) private readonly controlsRepo: ControlsRepository,
  ) {}

  /**
   * 开始（或幂等复用）一段学习会话。
   *
   * 幂等：`session_uid` 由前端生成，重复 POST 必须返回**既有**会话而不是新建
   * （前端路由抖动 / 重试会重复发）。但若该 uid 已被**别的学生**占用 → 1001：
   * 静默返回别人的 startedAt 会让前端以为自己的会话在跑，而后续心跳全会落空。
   */
  async start(input: StartSessionInput): Promise<{ sessionUid: string; startedAt: Date }> {
    if (!UUID_RE.test(input.sessionUid)) {
      throw new BadRequestException({ code: 1001, message: 'sessionUid 必须是 UUID' });
    }
    if (!(STUDY_MODULES as readonly string[]).includes(input.module)) {
      throw new BadRequestException({ code: 1001, message: `未知 module：${input.module}` });
    }
    if (!(STUDY_SCENES as readonly string[]).includes(input.scene)) {
      throw new BadRequestException({ code: 1001, message: `未知 scene：${input.scene}` });
    }

    const existing = await this.repo.findByUid(input.sessionUid);
    if (existing) {
      if (existing.student_id !== input.studentId) {
        throw new BadRequestException({ code: 1001, message: '会话标识冲突' });
      }
      return { sessionUid: input.sessionUid, startedAt: existing.started_at };
    }

    // 只校验「是在售学科」，不校验「学生是否有权学该学科」——本期有意放宽（见 plan）。
    if (input.subjectId != null) {
      const subjects = await this.subjectsRepo.findAll();
      if (!subjects.some((s) => s.id === input.subjectId)) {
        throw new BadRequestException({ code: 1001, message: `未知学科：${input.subjectId}` });
      }
    }

    const inputType = pick(INPUT_TYPES, input.inputType);
    const ua = parseUserAgent(input.userAgent);
    const platformClass = correctIpad(ua.platformClass, inputType);

    const created = await this.repo.insert({
      studentId: input.studentId,
      sessionUid: input.sessionUid,
      module: input.module,
      scene: input.scene,
      subjectId: input.subjectId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      platformClass,
      browser: ua.browser,
      screenClass: pick(SCREEN_CLASSES, input.screenClass),
      inputType,
      appShell: pick(APP_SHELLS, input.appShell),
    });

    // 竞态兜底：findByUid 与 insert 之间被并发插入 → INSERT IGNORE 返回 false，回读既有行。
    if (!created) {
      const row = await this.repo.findByUid(input.sessionUid);
      if (row) return { sessionUid: input.sessionUid, startedAt: row.started_at };
    }
    return { sessionUid: input.sessionUid, startedAt: new Date() };
  }

  /** 心跳。未命中一律**静默返回 null**（spec §8.1：心跳是尽力而为，报错会污染前端日志）。 */
  async heartbeat(input: {
    studentId: number;
    sessionUid: string;
    state: string;
    subjectId?: number;
    reason?: string;
  }): Promise<{ activeSeconds: number | null }> {
    if (input.state !== 'visible' && input.state !== 'hidden') {
      throw new BadRequestException({ code: 1001, message: "state 必须是 visible 或 hidden" });
    }
    // subjectId 是**尽力而为**的补写线索（P6.5）：非法/缺失一律按 null 处理（=「这次没带」），
    // 不 400 —— 心跳报错只会污染前端日志，还会让时长白丢。
    const subjectId =
      Number.isInteger(input.subjectId) && (input.subjectId as number) > 0
        ? (input.subjectId as number)
        : null;
    // reason 同 subjectId 的口径：非法/缺失一律归一为 null（=「没带原因」，旧客户端即如此），
    // 不 400 —— 走神原因丢了只是这一段归不了 away/idle 两口径，不该把整条心跳打掉。
    const reason = pick(HIDDEN_REASONS, input.reason);

    const result = await this.repo.heartbeat(
      input.sessionUid,
      input.studentId,
      input.state,
      subjectId,
      reason,
    );
    if (result) {
      await this.maybeRecordHiddenAlert(input.studentId, result.hiddenReason, result.hiddenSince);
    }
    return { activeSeconds: result?.activeSeconds ?? null };
  }

  /** 结束。未命中（已结束/不存在）→ 回读现有值，幂等（spec §8.1）。 */
  async end(input: {
    studentId: number;
    sessionUid: string;
    reason: string;
  }): Promise<{ activeSeconds: number | null; endedAt: Date | null }> {
    if (!(END_REASONS as readonly string[]).includes(input.reason)) {
      throw new BadRequestException({ code: 1001, message: `未知 end reason：${input.reason}` });
    }
    const done = await this.repo.end(input.sessionUid, input.studentId, input.reason);
    if (done) {
      // 结束路径也判一次阈值（spec §3.3「判定时机两处，缺一不可」）：覆盖「学生最小化后
      // 直接关掉页面」——pagehide 触发 end 之后不再有任何心跳，只靠心跳路径这条永远报不出来。
      await this.maybeRecordHiddenAlert(input.studentId, done.hiddenReason, done.hiddenSince);
      return { activeSeconds: done.activeSeconds, endedAt: done.endedAt };
    }

    const row = await this.repo.findByUid(input.sessionUid);
    if (!row || row.student_id !== input.studentId) return { activeSeconds: null, endedAt: null };
    return { activeSeconds: row.active_seconds, endedAt: row.ended_at };
  }

  /**
   * 走神阈值判定 + 写预警（spec §3.3）。**心跳与结束两条路径共用**。
   *
   * 判定口径：**当前这一段连续挂机**（`hidden_since`）已持续 ≥ 家长设定的分钟数。
   * ⚠️ 注意 `hidden_since` 是客户端 120s 空闲判定（`tracker.ts` 的 `IDLE_TIMEOUT_MS`，
   * **写死、不接家长配置**）之后才建立的，所以家长感知的「多久没操作」= 120s + 该阈值
   * （默认档约 17 分钟）。别把 `alert_idle_minutes` 当成「无操作 N 分钟」。
   *
   * 为什么在**阈值处**就报、不等挂机段结束：学生切走后再不回来正是家长最需要知道的场景；
   * 只在「回到前台」判定的话，这个场景永远报不出来（spec §9 已记录该副作用）。
   *
   * **整段 try/catch、失败只 warn**：判定与写入绝不阻断主链路——心跳响应与 `active_seconds`
   * 的累加不能因为这里失败而受影响（`record()` 自身也永不抛，见 `SafetyAlertsService`）。
   * 30 分钟去重窗口在 `SafetyAlertsService` 里，所以挂机期间每次心跳重复命中也只写一条。
   */
  private async maybeRecordHiddenAlert(
    studentId: number,
    hiddenReason: string | null,
    hiddenSince: Date | null,
  ): Promise<void> {
    try {
      if (hiddenReason !== 'away' && hiddenReason !== 'idle') return;
      if (!hiddenSince) return;

      const elapsedSeconds = Math.floor((Date.now() - hiddenSince.getTime()) / 1000);
      const thresholds = await this.controlsRepo.findAlertThresholds(studentId);
      const thresholdMinutes =
        hiddenReason === 'away' ? thresholds.awayMinutes : thresholds.idleMinutes;
      if (elapsedSeconds < thresholdMinutes * 60) return;

      const minutes = Math.floor(elapsedSeconds / 60);
      void this.safetyAlerts.record({
        studentId,
        dialogueId: null,
        type: hiddenReason,
        level: 'info',
        message: this.safetyAlerts.messageFor(hiddenReason, minutes),
        context: this.safetyAlerts.awayContext(hiddenReason, minutes),
      });
    } catch (err) {
      this.logger.warn(`走神预警判定失败（已忽略，不影响心跳）：${String(err)}`);
    }
  }

  /**
   * 惰性收尾（家长端查询前；不传 studentId 的全库形态是**预留入口**，当前无调用方、
   * 夜间定时任务未实现）。见 repo 的同名方法。
   */
  async closeStale(studentId?: number): Promise<number> {
    return this.repo.closeStale(studentId);
  }
}

/** 只用到 `findAll().id`，用最小结构声明依赖，避免 import 整个 SubjectsRepository 的类型。 */
export interface SubjectsRepoLike {
  findAll(): Promise<Array<{ id: number }>>;
}

/**
 * iPad 校正（spec §4.2 的硬要求）。
 *
 * iPadOS 13+ 的 Safari UA 写的是 `Macintosh`，只看 UA **必然**把 iPad 判成 Mac；
 * 而 iPad 横屏正是这个产品的主断点。前端上报的 `input_type` 与 UA 在同一个请求里，
 * 当场可校正：`mac + touch → ipad`。
 */
export function correctIpad(
  platformClass: PlatformClass | null,
  inputType: 'touch' | 'mouse' | 'hybrid' | null,
): PlatformClass | null {
  if (platformClass === 'mac' && inputType === 'touch') return 'ipad';
  return platformClass;
}
