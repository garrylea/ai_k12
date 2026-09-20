import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import { Button, Card, ImageLightbox, Pagination, Skeleton, Tag } from '@/components/base';
import {
  markdownRemarkPlugins,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  preprocessMarkdown,
} from '@/components/markdown';
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

function MessageRow({
  message,
  onPreview,
}: {
  message: ParentChatLogDetail['messages'][number];
  /** 点图片开大图；由页面持有 lightbox 状态，保证同时只有一个预览层。 */
  onPreview: (src: string) => void;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const isBlocked = message.safetyFlag === 1;
  const isUser = message.role === 'user';

  return (
    <div
      data-testid={`chatlog-message-${message.id}`}
      className={clsx(
        'rounded-[var(--radius-card)] p-3 text-sm',
        isUser ? 'bg-[var(--brand-100)]' : 'bg-[var(--bg-subtle)]',
        // 偏离学习：红色边框 + 红字标签（本批唯一有真数据的预警信号）。
        // `safety_flag = 1` 有两个来源（2026-09-20 裁决）：模型自报闲聊、或助手消息
        // `type === 'block'`（现在只剩 anomaly：情绪 / 敏感被阻断）。两类都算「偏离学习」，
        // 故文案不用「闲聊」（那会把情绪/敏感轮次误标成闲聊）。
        isBlocked && 'border border-[var(--error)]',
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-secondary)]">
          {isUser ? '孩子' : 'AI'}
        </span>
        {isBlocked && <Tag variant="hard">偏离学习</Tag>}
        {message.type && !isBlocked && (
          <span className="text-xs text-[var(--text-tertiary)]">{message.type}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-tertiary)]">
          {formatDateTime(message.createdAt)}
        </span>
      </div>

      {/*
        孩子随消息发的图片（服务端已从 attachments 解析成 images[]）。位置与学生端
        `AuxChatPanel` 一致：图片在正文之上。`/uploads/...` 已是绝对路径，**不要**
        用 resolveAsset（那是给 /assets/ 相对路径补前缀的）。
      */}
      {message.images.length > 0 && (
        <div
          data-testid={`chatlog-images-${message.id}`}
          className="mb-2 flex flex-wrap gap-1"
        >
          {message.images.map((src, i) => (
            <img
              key={`${src}-${i}`}
              src={src}
              alt="孩子发送的图片"
              onClick={() => onPreview(src)}
              className="max-w-[220px] max-h-[220px] rounded-md object-cover cursor-zoom-in hover:opacity-90 transition"
            />
          ))}
        </div>
      )}

      {/*
        孩子自己输入的文本**原样展示**，不走 markdown —— 学生端（`AuxChatPanel`）也是如此。
        若这里渲染 markdown，家长会看到孩子没看到过的排版，且孩子输入的 `2*3*4`、`#` 之类
        会被 markdown 当语法吃掉。AI 侧的富文本渲染见下面。
      */}
      {isUser ? (
        <p className="whitespace-pre-wrap text-[var(--text-primary)]">{message.content}</p>
      ) : (
        // AI 回复走共享渲染配置（KaTeX + 原生 HTML 表格 + 图片），与学生端一致
        <div className="text-[var(--text-primary)] leading-[1.7]">
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={markdownComponents}
          >
            {preprocessMarkdown(message.content)}
          </ReactMarkdown>
        </div>
      )}

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
            // 思路是模型原文（软换行有意义、且常带公式），用带换行保留的插件集渲染
            <div
              data-testid={`chatlog-reasoning-${message.id}`}
              className="mt-2 text-xs text-[var(--text-secondary)] leading-[1.7]"
            >
              <ReactMarkdown
                remarkPlugins={markdownRemarkPluginsWithBreaks}
                rehypePlugins={markdownRehypePlugins}
                components={markdownComponents}
              >
                {preprocessMarkdown(message.reasoning)}
              </ReactMarkdown>
            </div>
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
  /**
   * 失败态**必须连同「哪个孩子的哪条会话」一起存**，与 `ParentReportPage` 的
   * `failure: { studentId, period }` 同形：在途请求失败时，才不会把责任记到「当前选中」上。
   *
   * 但光有归属还不够：切孩子时 `activeId` 仍是上一个孩子的会话，会立刻对新孩子发一次
   * **注定失败**（1002）的请求，而它的 `(studentId, dialogueId)` 恰好就等于当下的选中态——
   * 所以必须同时清掉选中态（见下面 `[studentId]` 的 effect），右侧才会回到占位态。
   */
  const [detailFailure, setDetailFailure] = useState<{ studentId: number; dialogueId: number } | null>(null);
  /** 大图预览的当前图片；null = 没开。放在页面级，保证同时只有一个预览层。 */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  /**
   * 换孩子必须：① 回第 1 页 ② 清掉上一个孩子的选中会话。
   *
   * ① 与 `ParentErrorsPage` 同因：否则会拿上一个孩子的第 N 页去请求新孩子，若新孩子页数不够，
   * 响应回显的 page 仍是 N（守卫会通过）→ 停在「当前筛选下没有对话记录」，而分页控件只在
   * 非空分支里渲染，家长无法自救。
   * ② 不清会话会拿「新孩子 × 旧会话」发一次必失败（1002）的详情请求，把右侧钉在
   * 「这条对话暂时无法查看」。这个 effect 在 commit 之后才跑不影响正确性——`detail` 与
   * `detailFailure` 都带 studentId 归属，那一帧画不出旧孩子的任何内容。
   */
  useEffect(() => {
    setPage(1);
    setActiveId(null);
    setDetailFailure(null);
  }, [studentId]);

  /** 「自报家门」+ 归属：不是当前孩子的、或不是当前选中会话的，都当作还没到货。 */
  const detailData =
    detail && detail.studentId === studentId && detail.value.id === activeId ? detail.value : null;

  // 「自报家门」：不归当前孩子、或回显页号对不上 → 当作还没到货
  const pageData =
    list && list.studentId === studentId && list.value.page === page ? list.value : null;

  // 失败标记同样要「自报家门」：不是当前孩子/当前选中会话的失败，不当作本屏的失败态
  const detailFailed =
    detailFailure !== null &&
    detailFailure.studentId === studentId &&
    detailFailure.dialogueId === activeId;

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
    // 闭包捕获当次请求的两个维度：失败标记指向的必须是「这一次请求」，而不是渲染时的最新值
    const requestedStudentId = studentId;
    const requestedDialogueId = activeId;
    let cancelled = false;
    setDetailFailure(null);
    getParentChatLogDetail(requestedStudentId, requestedDialogueId)
      .then((res) => {
        if (cancelled) return;
        setDetail({ studentId: requestedStudentId, value: res });
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setDetailFailure({ studentId: requestedStudentId, dialogueId: requestedDialogueId });
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
                            {`偏离学习 ${item.blockCount}`}
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
                  <MessageRow key={m.id} message={m} onPreview={setPreviewSrc} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {previewSrc && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </div>
  );
}
