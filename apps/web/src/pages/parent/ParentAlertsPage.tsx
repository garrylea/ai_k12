import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Pagination, Skeleton, Tag, toast } from '@/components/base';
import {
  ApiError,
  getParentAlerts,
  listMyStudents,
  markParentAlertRead,
  type MyStudentItem,
  type ParentAlertItem,
  type ParentAlertPage,
} from '@/services/api';

/**
 * 「建议家长行动」按 `type` **前端静态映射**（spec §3.4：不入库）。
 *
 * `safety_alerts` 没有对应列，为一段展示文案改表不划算；文案随产品迭代也不需要迁移。
 * 键集是 6 值，与 `ParentAlertItem['type']` 同源——`Record<…, string>` 会让漏一个键在
 * **编译期**报错（而不是运行期渲染出空白）。
 */
const TYPE_ACTION: Record<ParentAlertItem['type'], string> = {
  off_topic: '和孩子聊聊学习之外的话题，或约定学习时段内保持专注',
  emotional: '关注孩子情绪，必要时先安抚再沟通',
  sensitive: '建议尽快与孩子沟通，必要时寻求专业帮助',
  abusive: '建议尽快与孩子沟通，必要时寻求专业帮助',
  away: '了解孩子离开页面的原因，确认是否需要休息',
  idle: '提醒孩子回到学习页面继续学习',
};

const TYPE_LABEL: Record<ParentAlertItem['type'], string> = {
  off_topic: '偏离学习',
  emotional: '情绪',
  sensitive: '敏感内容',
  abusive: '不当用语',
  away: '离开页面',
  idle: '长时间无操作',
};

const LEVEL_LABEL: Record<ParentAlertItem['level'], string> = {
  info: '提示',
  warning: '警告',
  critical: '严重',
};

const LEVEL_VARIANT: Record<ParentAlertItem['level'], 'neutral' | 'medium' | 'hard'> = {
  info: 'neutral',
  warning: 'medium',
  critical: 'hard',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function AlertRow({ item, onMarkRead }: { item: ParentAlertItem; onMarkRead: (id: number) => void }) {
  return (
    <div data-testid={`alert-row-${item.id}`} className="py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag variant={LEVEL_VARIANT[item.level]}>{LEVEL_LABEL[item.level]}</Tag>
        <Tag variant="source">{TYPE_LABEL[item.type]}</Tag>
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {item.studentName ?? '未知学生'}
        </span>
        <span className="text-xs text-[var(--text-tertiary)]">{formatDateTime(item.createdAt)}</span>
        {!item.isRead && (
          <Tag variant="neutral" className="ml-auto">
            未读
          </Tag>
        )}
      </div>

      <p className="mt-2 text-sm text-[var(--text-primary)]">{item.message}</p>
      {item.context && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">{`上下文：${item.context}`}</p>
      )}
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        {`建议行动：${TYPE_ACTION[item.type]}`}
      </p>

      <div className="mt-2 flex items-center gap-3">
        {item.dialogueId !== null && (
          <Link
            to="/parent/chat-logs"
            className="text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            查看对话
          </Link>
        )}
        {!item.isRead && (
          <button
            type="button"
            onClick={() => onMarkRead(item.id)}
            className="text-sm font-medium text-[var(--text-secondary)] hover:underline"
          >
            标记已读
          </button>
        )}
      </div>
    </div>
  );
}

export default function ParentAlertsPage() {
  /** 孩子筛选：`null` = **全部孩子**（spec §3.7，本页默认口径，与顶栏切换器无关）。 */
  const [filterStudentId, setFilterStudentId] = useState<number | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [students, setStudents] = useState<MyStudentItem[]>([]);
  /**
   * 派生状态**带请求参数归属**：切孩子/切筛选/翻页后，在途的旧响应不得盖到新视图上
   * （家长端切孩子不重挂载，见 CLAUDE.md 硬规则）。
   */
  const [data, setData] = useState<{
    studentId: number | null;
    unreadOnly: boolean;
    page: number;
    value: ParentAlertPage;
  } | null>(null);
  const [failure, setFailure] = useState<{
    studentId: number | null;
    unreadOnly: boolean;
    page: number;
    code: number | null;
  } | null>(null);
  const [reload, setReload] = useState(0);

  const sameKey = (t: { studentId: number | null; unreadOnly: boolean; page: number }) =>
    t.studentId === filterStudentId && t.unreadOnly === unreadOnly && t.page === page;
  const list = data && sameKey(data) ? data.value : null;
  const err = failure && sameKey(failure) ? failure : null;

  // 孩子下拉的选项。拉不到就退化为「不能按孩子筛」，不打扰家长（同 ParentErrorsPage 的学科下拉）。
  useEffect(() => {
    let cancelled = false;
    listMyStudents()
      .then((res) => {
        if (!cancelled) setStudents(res);
      })
      .catch(() => {
        /* 拉不到孩子列表 → 只剩「全部孩子」一个选项 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 换孩子 / 切「只看未读」都必须回第 1 页，否则会停在「第 3 页」而结果只有 1 页，
  // 且分页控件只在非空分支渲染 → 家长无法自救（与 ParentErrorsPage 同一纪律）。
  useEffect(() => {
    setPage(1);
  }, [filterStudentId, unreadOnly]);

  useEffect(() => {
    let cancelled = false;
    getParentAlerts({
      ...(filterStudentId !== null ? { studentId: filterStudentId } : {}),
      ...(unreadOnly ? { unreadOnly: true } : {}),
      page,
    })
      .then((res) => {
        if (cancelled) return;
        setData({ studentId: filterStudentId, unreadOnly, page, value: res });
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure({
          studentId: filterStudentId,
          unreadOnly,
          page,
          code: error instanceof ApiError ? error.code : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [filterStudentId, unreadOnly, page, reload]);

  /** 标记已读：成功后**就地更新**（不整页重拉）；「只看未读」下直接移除该行。 */
  const onMarkRead = (id: number) => {
    markParentAlertRead(id)
      .then(() => {
        setData((prev) => {
          if (!prev) return prev;
          /**
           * 判定用 `prev.unreadOnly`（**该份数据的请求口径**）而不是闭包里的 `unreadOnly`。
           *
           * 两者在「点了标记已读、PATCH 还没回来时家长切了只看未读」这段窗口里会不一致：
           * 闭包值停留在发起时的旧筛选，而 `prev` 已是新筛选取回的数据 —— 拿旧口径去过滤
           * 新数据会把一条已读行留在「只看未读」列表里（2026-09-20 评审 Minor-1）。
           * `data` 里存了 `unreadOnly`，就用它自己那份，天然免疫。
           */
          const items = prev.unreadOnly
            ? prev.value.items.filter((it) => it.id !== id)
            : prev.value.items.map((it) => (it.id === id ? { ...it, isRead: true } : it));
          const removed = prev.value.items.length - items.length;
          return { ...prev, value: { ...prev.value, items, total: prev.value.total - removed } };
        });
      })
      .catch((error: unknown) => {
        toast('error', error instanceof ApiError ? error.message : '标记失败，请重试');
      });
  };

  /**
   * 本页被清空 → 回上一页。
   *
   * 为什么必须有：标记已读会把行从「只看未读」列表里摘掉，若摘掉的是**本页最后一条**
   * （如第 2 页只剩 1 条），`items` 变空 → 渲染落到「当前筛选下没有预警」空态，而
   * `Pagination` 只在非空分支渲染（`page` 也没变，不触发重拉）→ 家长看到的是**假的空态**
   * （第 1 页其实还有 20 条未读）且**无路可退**，只剩「清除筛选」这一条会连筛选一起丢的出路。
   * 这是 CLAUDE.md 记过的同类陷阱（分页控件只在非空分支渲染）。
   *
   * 放在 effect 里按**当前派生值**判定，而不是在 `setData` 的 updater 里顺手 `setPage`
   * （updater 必须是纯函数）；这样也顺带覆盖「服务端返回空页」等同形情况。
   * 回退会改 `page` → 依赖 `page` 的拉取 effect 重新请求；若第 1 页也空则 `page > 1` 不成立、
   * 停在空态（此时空态是真的），不会无限回退。
   */
  useEffect(() => {
    if (list && list.items.length === 0 && page > 1) setPage((p) => p - 1);
  }, [list, page]);

  const hasFilter = filterStudentId !== null || unreadOnly;
  const clearFilters = () => {
    setFilterStudentId(null);
    setUnreadOnly(false);
  };
  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">异常预警中心</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          孩子学习过程中的异常提醒（默认展示全部孩子）
        </p>
      </header>

      <Card className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          孩子
          <select
            aria-label="孩子"
            value={filterStudentId === null ? '' : String(filterStudentId)}
            onChange={(e) => setFilterStudentId(e.target.value === '' ? null : Number(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部孩子</option>
            {students.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
          className={clsx(
            'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
            unreadOnly
              ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
              : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
          )}
        >
          只看未读
        </button>
      </Card>

      {err ? (
        <Card
          data-testid="alerts-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">预警暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : list === null ? (
        <div data-testid="alerts-skeleton" className="space-y-3">
          <Skeleton width="100%" height={72} />
          <Skeleton width="100%" height={72} />
        </div>
      ) : list.items.length === 0 ? (
        <Card data-testid="alerts-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            {hasFilter ? '当前筛选下没有预警' : '暂无预警'}
          </p>
          {hasFilter && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={clearFilters}>
              清除筛选
            </Button>
          )}
        </Card>
      ) : (
        <Card className="p-5">
          <p className="mb-2 text-sm text-[var(--text-secondary)]">{`共 ${list.total} 条`}</p>
          <div className="divide-y divide-[var(--bg-subtle)]">
            {list.items.map((item) => (
              <AlertRow key={item.id} item={item} onMarkRead={onMarkRead} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-4">
              <Pagination page={list.page} totalPages={totalPages} onChange={setPage} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
