import { Injectable } from '@nestjs/common';
import { BehaviorEventsRepository, type BehaviorEventRow } from '../../database/repositories/behavior-events.repo.js';

/** 母 spec §5.2 字典（study_session_heartbeat 不落事件流故不在册）。唯一真源，调用方不可覆盖 tier。 */
export const EVENT_TIER = {
  study_session_started: 'parent',
  study_session_ended: 'parent',
  study_session_idle: 'ops',
  page_view: 'ops',
  answer_submitted: 'parent',
  hint_requested: 'ops',
  answer_revealed: 'ops',
  self_assess_answered: 'ops',
  consecutive_failures: 'ops',
  card_flipped: 'ops',          // 本期无发射点（全仓无翻卡 UI），保留字典位
  ai_message_sent: 'parent',
  error_book_added: 'parent',
  error_book_cleared: 'parent',
  points_awarded: 'parent',
  exam_submitted: 'parent',
  special_unit_judged: 'parent',
  llm_fallback_triggered: 'ops',
} as const;

export type BehaviorEventName = keyof typeof EVENT_TIER;
export type EventTier = (typeof EVENT_TIER)[BehaviorEventName];

/** client 可上报白名单（delta spec §6）：服务端权威事件（answer_submitted 等）伪造直接拒。 */
export const CLIENT_ALLOWED_EVENTS: ReadonlySet<string> = new Set<string>([
  'study_session_started', 'study_session_ended', 'page_view',
  'card_flipped', 'answer_revealed', 'ai_message_sent', 'study_session_idle',
]);

export type TrackEventInput = {
  event: string;
  actorRole?: string;
  studentId?: number | null;
  module?: string | null;
  scene?: string | null;
  subjectId?: number | null;
  refType?: string | null;
  refId?: number | null;
  sessionUid?: string | null;
  requestId?: string | null;
  source: 'server' | 'client';
  props?: Record<string, unknown> | null;
  clientTsMs?: number | null;
};

const MODULE_WHITELIST = new Set([
  'mainline', 'aux_qna', 'training_targeted', 'training_error_practice', 'exam',
  'chinese_dictation', 'chinese_interpretation', 'chinese_meaning', 'en_vocabulary',
  'admin', 'parent',
]);
const SCENE_WHITELIST = new Set([
  'course_detail', 'star_map', 'aux_chat', 'targeted_run', 'error_run', 'exam_run',
  'dictation_run', 'interpretation_run', 'meaning_run', 'vocabulary_run',
  'profile', 'rewards', 'parent_dashboard', 'admin_dashboard',
]);
const ACTOR_ROLES = new Set(['student', 'parent', 'admin', 'system']);

function sanitize(input: TrackEventInput): BehaviorEventRow | null {
  const tier = (EVENT_TIER as Record<string, EventTier | undefined>)[input.event];
  if (!tier) return null; // 未登记 → 拒写
  // 第二道锁（delta spec §6）：client 只能上报白名单内事件，服务端权威事件伪造直接拒。
  if (input.source === 'client' && !CLIENT_ALLOWED_EVENTS.has(input.event)) return null;
  const module = input.module && MODULE_WHITELIST.has(input.module) ? input.module : null;
  const scene = input.scene && SCENE_WHITELIST.has(input.scene) ? input.scene : null;
  let props: string | null = null;
  if (input.props && Object.keys(input.props).length > 0) {
    const json = JSON.stringify(input.props);
    if (json.length > 2048) return null; // props 超限 → 拒写该条
    props = json;
  }
  return {
    actor_role: input.actorRole && ACTOR_ROLES.has(input.actorRole) ? input.actorRole : 'student',
    student_id: input.studentId ?? null,
    event: input.event,
    tier,
    module, scene,
    subject_id: input.subjectId ?? null,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    session_uid: input.sessionUid ?? null,
    request_id: input.requestId ?? null,
    source: input.source,
    props,
    client_ts_ms: input.clientTsMs ?? null,
  };
}

@Injectable()
export class EventsService {
  constructor(private readonly repo: BehaviorEventsRepository) {}

  /** 服务端打点入口：fire-and-forget，一切异常只 warn（埋点永不影响主链路）。 */
  track(input: TrackEventInput): void {
    const row = sanitize(input);
    if (!row) return;
    void this.repo.insertMany([row]).catch((err) => {
      console.warn('[events] track failed:', (err as Error)?.message);
    });
  }

  /** 采集端点入口：逐条校验计 rejected；DB 失败向上抛（由 controller 变 500）。 */
  async recordMany(inputs: TrackEventInput[]): Promise<{ accepted: number; rejected: number }> {
    const rows: BehaviorEventRow[] = [];
    let rejected = 0;
    for (const input of inputs) {
      const row = sanitize(input);
      if (row) rows.push(row); else rejected += 1;
    }
    if (rows.length > 0) {
      await this.repo.insertMany(rows);
    }
    return { accepted: rows.length, rejected };
  }
}
