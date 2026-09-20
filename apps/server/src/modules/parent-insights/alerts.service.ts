import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';
import type { SafetyAlertRowWithStudentName } from '../../database/repositories/safety-alerts.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { StudySessionsService } from '../analytics/study-sessions.service.js';
import type {
  ParentAlertItem,
  ParentAlertPage,
  ParentUnreadAlertItem,
  ParentUnreadAlerts,
} from './dto/parent-insights.dto.js';

/** 列表入参（`page`/`pageSize` 已由 controller 解析并校验过）。 */
export interface AlertsListQuery {
  studentId?: number;
  unreadOnly?: boolean;
  page: number;
  pageSize: number;
}

/**
 * 预警中心 —— 列表 / 标记已读（spec §4.3/§4.4）/ 未读轮询（spec §3.3）。
 *
 * `studentId` 的**学生归属**校验在 controller（`requireOwnedStudent`，只在传了
 * `studentId` 时做）；`markRead` 的**预警归属**校验只能在这里做——它要先 `findById`
 * 才知道这条预警属于哪个家长，controller 无从下手。
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly alertsRepo: SafetyAlertsRepository,
    @Inject(StudySessionsService) private readonly sessions: StudySessionsService,
    @Inject(StudentsRepository) private readonly studentsRepo: StudentsRepository,
  ) {}

  /** spec §4.3：分页偏移由服务端算，仓储只收 limit/offset。 */
  async list(parentId: number, query: AlertsListQuery): Promise<ParentAlertPage> {
    const offset = (query.page - 1) * query.pageSize;
    const { items, total } = await this.alertsRepo.listByParent(
      parentId,
      { studentId: query.studentId, unreadOnly: query.unreadOnly },
      query.pageSize,
      offset,
    );
    return {
      items: items.map(toAlertItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * spec §4.4：`alertId` 正整数（409/1001）→ 存在（404/1002）→ 归属（403/1005）
   * → 置已读。**幂等**：已读的再标记一次不报错（`markRead` 无条件 UPDATE）。
   *
   * 入参收 `string | number`：controller 不做 `ParseIntPipe`——那会把非数字变成 400，
   * 而 spec 要求这一类也是 `409`/`1001`。
   */
  async markRead(parentId: number, rawAlertId: string | number): Promise<void> {
    const alertId = typeof rawAlertId === 'number' ? rawAlertId : Number(rawAlertId);
    if (!Number.isInteger(alertId) || alertId <= 0) {
      throw new ConflictException({
        code: 1001,
        message: `alertId 必须是正整数（收到 ${rawAlertId}）`,
      });
    }

    const alert = await this.alertsRepo.findById(alertId);
    if (!alert) {
      throw new NotFoundException({ code: 1002, message: '预警不存在' });
    }
    // 别人的预警：403/1005，且**不写库**（不泄漏存在性）
    if (alert.parent_id !== parentId) {
      throw new ForbiddenException({ code: 1005, message: '无权操作该预警' });
    }

    await this.alertsRepo.markRead(alertId);
  }

  /**
   * 轮询端点（spec §3.3）：家长端 Banner 每 30s 拉一次。**先补判再查**——
   * 对名下每个孩子跑一次 `closeStale`（内部会补判走神阈值），后台 tab 冻结的学生端
   * 也能在一个轮询周期内把预警送进 banner。
   *
   * 嵌在业务流里的写入：整段 catch、失败只 warn、绝不把轮询打成 500。
   */
  async unread(parentId: number): Promise<ParentUnreadAlerts> {
    try {
      const students = await this.studentsRepo.findByParentId(parentId);
      await Promise.all(students.map((s) => this.sessions.closeStale(s.id)));
    } catch (err) {
      this.logger.warn(`unread 轮询的补判失败（已忽略，按现状返回未读）：${String(err)}`);
    }
    const { items, total } = await this.alertsRepo.listByParent(parentId, { unreadOnly: true }, 5, 0);
    return { items: items.map(toUnreadItem), total };
  }
}

/** 仓储行 → DTO：列名转驼峰、`is_read` 转 boolean、`student_name` 取不到就是 null。 */
function toAlertItem(row: SafetyAlertRowWithStudentName): ParentAlertItem {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name ?? null,
    type: row.type,
    level: row.level,
    message: row.message,
    context: row.context,
    dialogueId: row.dialogue_id,
    isRead: row.is_read === 1,
    createdAt: row.created_at,
  };
}

/** 轮询 DTO：只带 banner 展示字段（spec §3.3），不带 context/dialogueId/isRead。 */
function toUnreadItem(row: SafetyAlertRowWithStudentName): ParentUnreadAlertItem {
  return {
    id: row.id,
    type: row.type,
    level: row.level,
    message: row.message,
    studentName: row.student_name ?? null,
    createdAt: row.created_at,
  };
}
