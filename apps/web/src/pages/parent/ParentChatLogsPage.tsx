import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Pagination, Skeleton, Tag } from '@/components/base';
import {
  getParentChatLogDetail,
  getParentChatLogs,
  type ParentChatLogDetail,
  type ParentChatLogItem,
  type ParentChatLogPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type TrackFilter = '' | 'mainline' | 'auxiliary';

const SCENE_OPTIONS = [
  { value: '', label: '全部场景' },
  { value: 'aux_qna', label: '辅线答疑' },
  { value: 'aux_training', label: '训练讲一讲' },
  { value: 'mainline_card', label: '主线卡片讨论' },
  { value: 'mainline_question', label: '主线题目讨论' },
];

const SCENE_LABEL = new Map(SCENE_OPTIONS.map((o) => [o.value, o.label]));

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MessageRow({ message }: { message: ParentChatLogDetail['messages'][number] }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const isBlocked = message.safetyFlag === 1;
  const isUser = message.role === 'user';

  return (
    <div
      data-testid={`chatlog-message-${message.id}`}
      className={clsx(
        'rounded-[var(--radius-card)] p-3 text-sm',
        isUser ? 'bg-[var(--brand-100)]' : 'bg-[var(--bg-subtle)]',
        // 闲聊/偏离学习：红色边框 + 红字标签（本批唯一有真数据的预警信号）
        isBlocked && 'border border-[var(--error)]',
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-secondary)]">
          {isUser ? '孩子' : 'AI'}
        </span>
        {isBlocked && <Tag variant="hard">闲聊/偏离学习</Tag>}
        {message.type && !isBlocked && (
          <span className="text-xs text-[var(--text-tertiary)]">{message.type}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-tertiary)]">
          {formatDateTime(message.createdAt)}
        </span>
      </div>

      <p className="whitespace-pre-wrap text-[var(--text-primary)]">{message.content}</p>

      {message.reasoning && (
        <>
          <button
            type="button"
            onClick={() => setShowReasoning((v) => !v)}
            className="mt-2 text-xs font-medium text-[var(--brand-600)] hover:underline"
          >
            {showReasoning ? '收起 AI 思路' : '看 AI 思路'}
          </button>
          {showReasoning && (
            <p
              data-testid={`chatlog-reasoning-${message.id}`}
              className="mt-2 whitespace-pre-wrap text-xs text-[var(--text-secondary)]"
            >
              {message.reasoning}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function ParentChatLogsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<TrackFilter>('');
  const [scene, setScene] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ studentId: number; value: ParentChatLogPage } | null>(null);
  const [failure, setFailure] = useState(false);
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  /**
   * 详情**必须连同 studentId 一起存**，光按 `activeId` 守卫不够。
   *
   * 顶栏 `StudentSwitcher` 切孩子时不导航，而 `ParentLayout` 的 `<Outlet />` **没有 key**，
   * 所以本页**不会重挂载**——`activeId` 与 `detail` 都会跨孩子活下来。若只判
   * `detail.id === activeId`，切孩子的第一帧就会把**上一个孩子的对话内容整屏画出来**
   * （含可展开的 AI 思路），而顶栏已经显示新孩子的名字。等详情请求回来才纠正，
   * 慢网下这个窗口有好几秒。
   * 注意**加一个 `useEffect(() => setActiveId(null), [studentId])` 是不够的**：
   * effect 在 commit 之后才跑，那一帧照样会画出来。
   */
  const [detail, setDetail] = useState<{ studentId: number; value: ParentChatLogDetail } | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  // 换孩子必须回第 1 页（与 `ParentErrorsPage` 同因）：否则会拿上一个孩子的第 N 页去请求新孩子，
  // 若新孩子页数不够，响应回显的 page 仍是 N（守卫会通过）→ 停在「当前筛选下没有对话记录」，
  // 而**分页控件只在非空分支里渲染**，家长无法自救。
  useEffect(() => {
    setPage(1);
  }, [studentId]);

  /** 「自报家门」+ 归属：不是当前孩子的、或不是当前选中会话的，都当作还没到货。 */
  const detailData =
    detail && detail.studentId === studentId && detail.value.id === activeId ? detail.value : null;

  // 「自报家门」：不归当前孩子、或回显页号对不上 → 当作还没到货
  const pageData =
    list && list.studentId === studentId && list.value.page === page ? list.value : null;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    setFailure(false);
    getParentChatLogs({
      studentId,
      ...(track ? { track } : {}),
      ...(scene ? { scene } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(appliedKeyword ? { q: appliedKeyword } : {}),
      page,
    })
      .then((res) => {
        if (cancelled) return;
        setList({ studentId, value: res });
      })
      .catch(() => {
        if (cancelled) return;
        setList(null);
        setFailure(true);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, track, scene, from, to, appliedKeyword, page, reload]);

  useEffect(() => {
    if (studentId === null || activeId === null) return;
    let cancelled = false;
    setDetailFailed(false);
    getParentChatLogDetail(studentId, activeId)
      .then((res) => {
        if (cancelled) return;
        setDetail({ studentId, value: res });
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, activeId]);

  /** 任何筛选变化都回第 1 页。 */
  const changeFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  if (studentId === null) {
    return (
      <Card data-testid="chatlogs-no-student" className="p-10 text-center">
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

  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">AI 对话回放</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          逐句查看孩子与 AI 的完整对话（含主线讨论与辅线答疑）
        </p>
      </header>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          轨道
          <select
            aria-label="轨道"
            value={track}
            onChange={(e) => changeFilter(() => setTrack(e.target.value as TrackFilter))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部</option>
            <option value="mainline">主线讨论</option>
            <option value="auxiliary">辅线答疑</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          场景
          <select
            aria-label="场景"
            value={scene}
            onChange={(e) => changeFilter(() => setScene(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            {SCENE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          起始日期
          <input
            aria-label="起始日期"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          截止日期
          <input
            aria-label="截止日期"
            type="date"
            value={to}
            onChange={(e) => changeFilter(() => setTo(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          搜索会话标题
          <input
            aria-label="搜索会话标题"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="只搜会话标题"
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => changeFilter(() => setAppliedKeyword(keyword))}
        >
          搜索
        </Button>
      </Card>

      {failure ? (
        <Card
          data-testid="chatlogs-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">对话记录暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Card className="p-4">
            {pageData === null ? (
              <div data-testid="chatlogs-skeleton" className="space-y-3">
                <Skeleton width="100%" height={56} />
                <Skeleton width="100%" height={56} />
              </div>
            ) : pageData.items.length === 0 ? (
              <p data-testid="chatlogs-empty" className="py-8 text-center text-sm text-[var(--text-secondary)]">
                当前筛选下没有对话记录
              </p>
            ) : (
              <>
                <div className="divide-y divide-[var(--bg-subtle)]">
                  {pageData.items.map((item: ParentChatLogItem) => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`chatlog-item-${item.id}`}
                      onClick={() => setActiveId(item.id)}
                      className={clsx(
                        'w-full py-3 text-left transition-colors',
                        activeId === item.id && 'bg-[var(--brand-100)]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {item.title || '未命名会话'}
                        </span>
                        {item.blockCount > 0 && (
                          <span
                            data-testid={`chatlog-block-badge-${item.id}`}
                            className="rounded-full bg-[var(--error)] px-2 py-0.5 text-[10px] font-bold text-white"
                          >
                            {`闲聊 ${item.blockCount}`}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                        <span>{item.track === 'mainline' ? '主线' : '辅线'}</span>
                        <span>{SCENE_LABEL.get(item.scene) ?? item.scene}</span>
                        <span>{`${item.messageCount} 句`}</span>
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
                {totalPages > 1 && (
                  <div className="mt-3">
                    <Pagination page={pageData.page} totalPages={totalPages} onChange={setPage} />
                  </div>
                )}
              </>
            )}
          </Card>

          <Card className="p-4">
            {activeId === null ? (
              <p
                data-testid="chatlog-detail-placeholder"
                className="py-16 text-center text-sm text-[var(--text-secondary)]"
              >
                选择左侧一条对话查看逐句回放
              </p>
            ) : detailFailed ? (
              <p className="py-16 text-center text-sm text-[var(--text-secondary)]">
                这条对话暂时无法查看
              </p>
            ) : detailData === null ? (
              <div className="space-y-3">
                <Skeleton width="100%" height={64} />
                <Skeleton width="100%" height={64} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-[var(--text-primary)]">
                    {detailData.title || '未命名会话'}
                  </h2>
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {`${detailData.messageCount} 句 · ${formatDateTime(detailData.createdAt)}`}
                  </span>
                </div>
                {detailData.messages.map((m) => (
                  <MessageRow key={m.id} message={m} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
