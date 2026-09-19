import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Skeleton } from '@/components/base';
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
 * 目标设定（PRD P6.5）。从占位页变真页：读四个维度目标 + 逐行改目标值。
 *
 * 家长端全程日间：页面**不加** `data-theme`、不用 `.student-theme-container`（`ParentLayout` 统一写）。
 *
 * 两条实现纪律：
 *   1. **派生数据带 `studentId` 归属**：切孩子不重挂载本页，只在 effect 里 `setData(null)` 会慢一帧、
 *      把上一个孩子的数字画出来（effect 在 commit 之后才跑）。故存 `{ studentId, value }`、读取时比对。
 *   2. **行级保存态**：`savingMetric` 是单值（同一时刻只可能点一个按钮），失败时**保留家长输入不回滚**
 *      ——把用户刚打的数字擦掉是最招人烦的交互。
 */
export default function ParentGoalsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [data, setData] = useState<{ studentId: number; value: ParentGoalAttainment } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingMetric, setSavingMetric] = useState<ParentGoalMetric | null>(null);
  const [saveError, setSaveError] = useState<{ metric: ParentGoalMetric; message: string } | null>(null);

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
    const target = parseTarget(draft[item.metric] ?? String(item.target));
    if (target === null) {
      setSaveError({ metric: item.metric, message: '目标值需为 1–9999 的整数' });
      return;
    }
    setSavingMetric(item.metric);
    setSaveError(null);
    try {
      const updated = await putParentGoalTarget(studentId, item.metric, target);
      // 原地替换该行：用后端回的最新达成情况，避免再发一次 GET
      setData((prev) =>
        prev && prev.studentId === studentId
          ? {
              studentId,
              value: {
                items: prev.value.items.map((it) => (it.metric === updated.metric ? updated : it)),
              },
            }
          : prev,
      );
      setDraft((prev) => {
        const next = { ...prev };
        delete next[item.metric];
        return next;
      });
    } catch (error: unknown) {
      setSaveError({
        metric: item.metric,
        message: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setSavingMetric(null);
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

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">目标设定</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          给孩子设定每日/每周目标，达成情况按学习数据实时统计。
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
      ) : (
        <Card className="p-5" data-testid="goals-card">
          {value.items.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">暂无目标</p>
          ) : (
            <ul className="space-y-4">
              {value.items.map((item) => (
                <li
                  key={item.metric}
                  data-testid={`goal-row-${item.metric}`}
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
                      {`已达成 ${item.achieved} / ${item.target}`}
                      <span className="ml-2 text-[var(--text-tertiary)]">{rateText(item)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      aria-label={`${item.title}目标值`}
                      value={draft[item.metric] ?? String(item.target)}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, [item.metric]: e.target.value }))
                      }
                      className="w-24 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={savingMetric === item.metric}
                      onClick={() => void save(item)}
                    >
                      {savingMetric === item.metric ? '保存中…' : '保存'}
                    </Button>
                  </div>
                  {saveError?.metric === item.metric && (
                    <p
                      data-testid={`goal-error-${item.metric}`}
                      className="w-full text-xs text-[var(--error)]"
                    >
                      {saveError.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
