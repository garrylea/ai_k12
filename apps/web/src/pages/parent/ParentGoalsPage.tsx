import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Input, Skeleton, toast } from '@/components/base';
import {
  ApiError,
  getParentGoalAttainment,
  putParentGoalTarget,
  type ParentGoalAttainment,
  type ParentGoalAttainmentItem,
  type ParentGoalMetric,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PERIOD_LABEL: Record<ParentGoalAttainmentItem['period'], string> = {
  daily: '每日',
  weekly: '每周',
};

/**
 * 每个指标的单位。
 * ⚠️ 别统一写「个」：分钟/课/道/篇/词 各不相同，统一了家长就看不出「2」是什么。
 */
const UNIT_BY_METRIC: Record<ParentGoalMetric, string> = {
  daily_study_minutes: '分钟',
  weekly_lessons: '课',
  weekly_clear_errors: '道',
  weekly_passages: '篇',
  daily_words: '词',
};

/**
 * 一行的**唯一键**：`学科:指标`。
 *
 * ⚠️ 2026-09-20（P6.5）起所有目标都按学科，**同一个 metric 会在多个学科各有一行**
 * —— 只用 `metric` 当 key / 草稿键 / 保存态键会互相串（React 复用同一节点、草稿覆盖）。
 */
function rowKey(item: ParentGoalAttainmentItem): string {
  return `${item.subjectId}:${item.metric}`;
}

/**
 * 达成率文案。
 * `null` = 没有达成率可言（目标值为 0），显示「暂无数据」——**不要显示成 0%**。
 * `> 100` 明确写「已超额」：后端不截断，前端也不许截断（截断会让家长以为刚好达标）。
 */
function rateText(item: ParentGoalAttainmentItem): string {
  if (item.rate === null) return '暂无数据';
  const pct = `${item.rate}%`;
  return item.rate > 100 ? `${pct}（已超额）` : pct;
}

/** 目标值只收 1–9999 的整数（与后端 `UpsertGoalSchema` 同一档）。前端先挡一道，避免无谓往返。 */
function parseTarget(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return n;
}

/**
 * 目标设定（PRD P6.5）。2026-09-20 起**按学科**：页面按学科分组，每组下是适用指标。
 *
 * 家长端全程日间：页面**不加** `data-theme`、不用 `.student-theme-container`（`ParentLayout` 统一写）。
 *
 * 三条实现纪律：
 *   1. **派生数据带 `studentId` 归属**：切孩子不重挂载本页，只在 effect 里 `setData(null)` 会慢一帧、
 *      把上一个孩子的数字画出来（effect 在 commit 之后才跑）。故存 `{ studentId, value }`、读取时比对。
 *   2. **行级状态一律用 `rowKey`（学科:指标）**，不能用 metric —— 同 metric 会跨学科重复。
 *   3. **失败保留家长输入不回滚** —— 把用户刚打的数字擦掉是最招人烦的交互。
 */
export default function ParentGoalsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [data, setData] = useState<{ studentId: number; value: ParentGoalAttainment } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(null);

  const value = data && data.studentId === studentId ? data.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentGoalAttainment(studentId)
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
        setFailure(null);
        // 换孩子/重载时清掉上一份草稿与行级错误，否则会把上个孩子没保存的输入带过来
        setDraft({});
        setSaveError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  const save = async (item: ParentGoalAttainmentItem) => {
    if (studentId === null) return;
    const key = rowKey(item);
    const target = parseTarget(draft[key] ?? String(item.target));
    if (target === null) {
      setSaveError({ key, message: '目标值需为 1–9999 的整数' });
      return;
    }
    setSavingKey(key);
    setSaveError(null);
    try {
      const updated = await putParentGoalTarget(studentId, item.metric, target, item.subjectId);
      /**
       * **成功必须有反馈（2026-09-20 走查踩坑，别再删）**：保存「与当前相同的值」时行内容零变化
       * （库里 ODKU 也是无操作，`updated_at` 都不会动），如果只靠「数字变了」当反馈，
       * 家长会以为按钮坏了而反复点击 —— 实际发生了 4 连点。
       * 提示里**回显服务端保存后的值**：万一输入没被采纳（那样发出去的就是旧值），
       * 这句话会直接把差异摆在眼前。
       */
      toast('success', `已保存：${updated.title} ${updated.target} ${UNIT_BY_METRIC[updated.metric]}`);
      // 原地替换该行：用后端回的最新达成情况，避免再发一次 GET
      setData((prev) =>
        prev && prev.studentId === studentId
          ? {
              studentId,
              value: {
                items: prev.value.items.map((it) =>
                  rowKey(it) === rowKey(updated) ? updated : it,
                ),
              },
            }
          : prev,
      );
      setDraft((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '保存失败';
      // 失败同样给全局提示：行内那行小字在窄屏下容易被忽略（走查时「什么都没发生」的观感就是这么来的）
      toast('error', `保存失败：${message}`);
      setSaveError({ key, message });
    } finally {
      setSavingKey(null);
    }
  };

  if (studentId === null) {
    return (
      <Card data-testid="goals-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">还没有选择孩子账号</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  /** 按学科分组（组顺序沿用后端给的顺序，前端不重排）。 */
  const groups: Array<{ subjectId: number; subjectName: string; items: ParentGoalAttainmentItem[] }> =
    [];
  for (const item of value?.items ?? []) {
    const last = groups[groups.length - 1];
    if (last && last.subjectId === item.subjectId) last.items.push(item);
    else groups.push({ subjectId: item.subjectId, subjectName: item.subjectName, items: [item] });
  }

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">目标设定</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          按学科给孩子设定每日/每周目标，达成情况按学习数据实时统计。
        </p>
      </header>

      {err?.code === 1002 ? (
        <Card data-testid="goals-student-missing" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            该孩子账号不存在，请在顶部切换其它孩子
          </p>
        </Card>
      ) : err?.code === 1005 ? (
        <Card data-testid="goals-student-forbidden" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">无权查看该孩子</p>
        </Card>
      ) : err ? (
        <Card
          data-testid="goals-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">目标暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : value === null ? (
        <div data-testid="goals-skeleton" className="space-y-4">
          <Skeleton width="100%" height={92} rounded />
          <Skeleton width="100%" height={92} rounded />
        </div>
      ) : groups.length === 0 ? (
        // 真实空态：孩子在 `progress` 里一门学科都没有（家长还没配教材），后端**不编造**默认目标
        <Card data-testid="goals-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            这个孩子还没有在学学科，所以还没有可设的目标。
          </p>
          <Link
            to={`/parent/students/${studentId}/config`}
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去配置教材
          </Link>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card
              key={group.subjectId}
              className="p-5"
              data-testid={`goals-subject-${group.subjectId}`}
            >
              <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">
                {group.subjectName}
              </h2>
              <ul className="space-y-4">
                {group.items.map((item) => {
                  const key = rowKey(item);
                  return (
                    <li
                      key={key}
                      data-testid={`goal-row-${key}`}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--bg-subtle)] pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="min-w-[10rem]">
                        <div className="text-sm font-bold text-[var(--text-primary)]">
                          {item.title}
                          <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">
                            {PERIOD_LABEL[item.period]}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-secondary)]">
                          {`已达成 ${item.achieved} / ${item.target} ${UNIT_BY_METRIC[item.metric]}`}
                          <span className="ml-2 text-[var(--text-tertiary)]">{rateText(item)}</span>
                        </div>
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="w-28">
                          <Input
                            type="number"
                            min={1}
                            max={9999}
                            aria-label={`${item.title}（${group.subjectName}）目标值`}
                            value={draft[key] ?? String(item.target)}
                            onChange={(e) =>
                              setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                        </div>
                        <Button
                          variant="primary"
                          size="md"
                          disabled={savingKey === key}
                          onClick={() => void save(item)}
                        >
                          {savingKey === key ? '保存中…' : '保存'}
                        </Button>
                      </div>
                      {saveError?.key === key && (
                        <p
                          data-testid={`goal-error-${key}`}
                          className="w-full text-xs text-[var(--error)]"
                        >
                          {saveError.message}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
