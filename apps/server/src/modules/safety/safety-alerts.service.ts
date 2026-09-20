import { Injectable, Logger } from '@nestjs/common';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';

/** 预警类型（与 `SafetyAlertRow['type']` 同源，这里窄化成「本批会写的四种 + abusive 兜底」）。 */
export type SafetyAlertType = 'off_topic' | 'emotional' | 'sensitive' | 'away' | 'idle';

export interface RecordSafetyAlertInput {
  studentId: number;
  dialogueId: number | null;
  type: SafetyAlertType;
  level: 'info' | 'warning' | 'critical';
  /** 面向家长的文案；调用方**不要**自己拼，用 `messageFor()`。 */
  message: string;
  /** 上下文片段：闲聊/情绪/敏感 = 学生消息截断 200 字；走神 = 「切走 N 分钟」。 */
  context: string | null;
}

/** 去重窗口（spec §3.5）。 */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
/** 上下文片段截断长度。 */
const CONTEXT_MAX = 200;

@Injectable()
export class SafetyAlertsService {
  private readonly logger = new Logger(SafetyAlertsService.name);

  constructor(
    private readonly alertsRepo: SafetyAlertsRepository,
    private readonly studentsRepo: StudentsRepository,
  ) {}

  /**
   * 写一条预警。**同步返回、fire-and-forget、永不抛**（spec §6 不变量）。
   *
   * 为什么同步：调用点在辅导链路（同步上下文）与心跳路径（不能拖长响应）上，
   * 让它们 `await` 一个 INSERT + 一次去重 SELECT 是没必要的等待。
   */
  record(input: RecordSafetyAlertInput): void {
    void this.doRecord(input).catch((err) => {
      this.logger.warn(`预警写入失败（已忽略）：${String(err)}`);
    });
  }

  private async doRecord(input: RecordSafetyAlertInput): Promise<void> {
    try {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
      if (await this.alertsRepo.existsRecent(input.studentId, input.type, since)) return;

      const student = await this.studentsRepo.findById(input.studentId);
      if (!student) {
        this.logger.warn(`预警跳过：学生 ${input.studentId} 不存在`);
        return;
      }

      await this.alertsRepo.create({
        parent_id: student.parentId,
        student_id: input.studentId,
        dialogue_id: input.dialogueId,
        message_id: null,
        type: input.type,
        level: input.level,
        message: input.message,
        context: input.context ? input.context.slice(0, CONTEXT_MAX) : null,
      });
    } catch (err) {
      this.logger.warn(`预警写入失败（已忽略）：${String(err)}`);
    }
  }

  /** 面向家长的文案（spec §3.4 表，**唯一真源**，调用方别自己拼）。 */
  messageFor(type: SafetyAlertType, minutes?: number): string {
    switch (type) {
      case 'off_topic': return '检测到孩子在学习中发起了与学习无关的闲聊';
      case 'emotional': return '检测到孩子出现情绪发泄类输入';
      case 'sensitive': return '检测到敏感内容输入，建议尽快关注';
      case 'away': return `孩子离开了学习页面 ${minutes ?? 0} 分钟`;
      case 'idle': return `孩子在学习页面 ${minutes ?? 0} 分钟无操作`;
    }
  }

  /** 走神的 context 文案（与 message 同源，别在调用点重复拼）。 */
  awayContext(type: 'away' | 'idle', minutes: number): string {
    return type === 'away' ? `切走 ${minutes} 分钟` : `无操作 ${minutes} 分钟`;
  }
}
