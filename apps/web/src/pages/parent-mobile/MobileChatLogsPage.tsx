import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
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
  type ParentChatLogMessage,
  type ParentChatLogPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * /m/parent/chatlogs 移动端 AI 对话记录页（Task 4）。
 *
 * 列表态与整页回放态共用一个组件（activeId 切换）。语义以桌面 ParentChatLogsPage
 * 为真源（2026-10-06 核对）：
 * - 孩子的输入**原样展示不走 markdown**（学生端 AuxChatPanel 同因：`2*3*4`、`#`
 *   之类会被 markdown 当语法吃掉，家长会看到孩子没看到过的排版）；AI 回复走共享配置。
 * - 偏离标记文案是「偏离学习」而非「闲聊」——`safety_flag = 1` 有两个来源
 *   （2026-09-20 裁决）：模型自报闲聊、或助手消息 type === 'block'（情绪/敏感被阻断）。
 * - 标题搜索**不防抖**：显式应用（移动端用回车键，桌面是搜索按钮），keyword 与
 *   appliedKeyword 分离。
 * - scene/from/to 日期筛选移动端 v1 隐藏（计划已声明的简化），仅保留 track + 标题搜索。
 *
 * 数据归属（CLAUDE.md 硬规则，桌面同款）：list / detail / detailFailure 都连同
 * studentId（失败态再加 dialogueId）一起存，读取时现算归属——切孩子不重挂载本页，
 * effect 清空慢一帧，旧孩子的数据必须在那一帧就不可见。加载/详情请求带 cancelled
 * 守卫（MobileControlsPage 先例）：快速切孩子时旧响应晚 resolve 不许写回。
 *
 * `data-testid="mobile-page-chatlogs"` 挂所有状态共用的外层容器（Task 1 路由测试消费，
 * MobileAlertsPage/MobileControlsPage 先例）。
 */

type TrackFilter = '' | 'mainline' | 'auxiliary';

/** 时刻格式化：与桌面同口径，只给「几月几日 几点几分」。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MessageRow({ message }: { message: ParentChatLogMessage }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const isBlocked = message.safetyFlag === 1;
  const isUser = message.role === 'user';

  return (
    <div
      className={`rounded-2xl p-3 text-sm ${isUser ? 'bg-[var(--brand-100)]' : 'bg-white'} ${isBlocked ? 'border border-[var(--error)]' : ''}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-[var(--text-secondary)]">{isUser ? '孩子' : 'AI'}</span>
        {isBlocked && <span className="text-xs font-bold text-[var(--error)]">偏离学习</span>}
        <span className="ml-auto text-xs text-[var(--text-tertiary)]">{formatDateTime(message.createdAt)}</span>
      </div>

      {/*
        孩子随消息发的图片（服务端已从 attachments 解析成 images[]），位置在正文之上
        （与学生端 AuxChatPanel 一致）。`/uploads/...` 已是绝对路径，**不要**用
        resolveAsset（那是给 /assets/ 相对路径补前缀的，api.ts 硬注释）。
      */}
      {message.images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {message.images.map((src, i) => (
            <img key={`${src}-${i}`} src={src} alt="孩子发送的图片" className="max-w-[220px] max-h-[220px] rounded-md object-cover" />
          ))}
        </div>
      )}

      {isUser ? (
        <p className="whitespace-pre-wrap text-[var(--text-primary)]">{message.content}</p>
      ) : (
        // AI 回复走共享渲染配置（KaTeX + 原生 HTML 表格 + 图片），与学生端一致
        <div className="text-[var(--text-primary)] leading-[1.7] [&_img]:max-w-full">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
            {preprocessMarkdown(message.content)}
          </ReactMarkdown>
        </div>
      )}

      {message.reasoning && (
        <>
          <button
            type="button"
            onClick={() => setShowReasoning((v) => !v)}
            className="mt-2 text-xs font-medium text-[var(--brand-600)]"
          >
            {showReasoning ? '收起 AI 思路' : '看 AI 思路'}
          </button>
          {showReasoning && (
            // 思路是模型原文（软换行有意义、且常带公式），用带换行保留的插件集渲染
            <div className="mt-2 text-xs leading-[1.7] text-[var(--text-secondary)]">
              <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                {preprocessMarkdown(message.reasoning)}
              </ReactMarkdown>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function MobileChatLogsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<TrackFilter>('');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ studentId: number; value: ParentChatLogPage } | null>(null);
  const [failure, setFailure] = useState(false);
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  /**
   * 详情**必须连同 studentId 一起存**（桌面同款注释）：切孩子不重挂载本页，
   * 光按 activeId 守卫，切孩子首帧会把上一个孩子的对话内容整屏画出来。
   */
  const [detail, setDetail] = useState<{ studentId: number; value: ParentChatLogDetail } | null>(null);
  /**
   * 失败态连同「哪个孩子的哪条会话」一起存：仅当失败会话仍是当前选中态时才显示
   * （桌面 detailFailure 语义）。
   */
  const [detailFailure, setDetailFailure] = useState<{ studentId: number; dialogueId: number } | null>(null);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    setFailure(false);
    getParentChatLogs({
      studentId,
      ...(track ? { track } : {}),
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
  }, [studentId, track, appliedKeyword, page, reload]);

  useEffect(() => {
    if (studentId === null || activeId === null) return;
    // 失败标记指向的必须是「这一次请求」的孩子/会话，而不是渲染时的最新值
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

  // 换孩子：回第 1 页 + 清掉上一个孩子的选中会话（detail/detailFailure 带归属，
  // effect 晚一帧不影响正确性——那一帧画不出旧孩子的任何内容）
  useEffect(() => {
    setPage(1);
    setActiveId(null);
    setDetailFailure(null);
  }, [studentId]);

  // 「自报家门」+ 归属：不是当前孩子的、或不是当前选中会话的，都当作还没到货
  const detailData =
    detail && detail.studentId === studentId && detail.value.id === activeId ? detail.value : null;
  const pageData =
    list && list.studentId === studentId && list.value.page === page ? list.value : null;
  // 失败标记同样要「自报家门」：不是当前孩子/当前选中会话的失败，不当作本屏的失败态
  const detailFailed =
    detailFailure !== null &&
    detailFailure.studentId === studentId &&
    detailFailure.dialogueId === activeId;

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-chatlogs">
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">先在上方选择孩子</p>
      </div>
    );
  }

  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;
  const activeItem: ParentChatLogItem | null =
    pageData?.items.find((x) => x.id === activeId) ??
    (detailData !== null && detailData.id === activeId ? detailData : null);

  // ===== 整页回放态 =====
  if (activeId !== null) {
    return (
      <div data-testid="mobile-page-chatlogs" className="space-y-3">
        <button
          type="button"
          data-testid="chatlogs-back"
          onClick={() => {
            setActiveId(null);
            setDetail(null);
            setDetailFailure(null);
          }}
          className="text-sm text-[var(--brand-600)]"
        >
          ← 返回列表
        </button>
        <div className="rounded-2xl bg-white p-4">
          <p className="text-sm font-bold text-[var(--text-primary)]">
            {(activeItem?.title || detailData?.title) || '未命名会话'}
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {(activeItem ?? detailData) !== null && (
              <>
                {(activeItem ?? detailData)!.track === 'mainline' ? '主线' : '辅线'} ·{' '}
                {formatDateTime((activeItem ?? detailData)!.createdAt)}
              </>
            )}
          </p>
        </div>
        {detailFailed ? (
          <div
            data-testid="chatlogs-detail-error"
            className="rounded-2xl bg-white p-8 text-center text-sm text-[var(--text-secondary)]"
          >
            这条对话暂时无法查看
          </div>
        ) : detailData === null ? (
          <div className="h-24 animate-pulse rounded-2xl bg-white" />
        ) : (
          <div data-testid="chatlogs-detail" className="space-y-2">
            {detailData.messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ===== 列表态 =====
  return (
    <div data-testid="mobile-page-chatlogs" className="space-y-3">
      <div className="flex gap-2">
        {([['', '全部'], ['mainline', '主线'], ['auxiliary', '辅线']] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            data-testid={`chatlogs-track-${k === '' ? 'all' : k}`}
            onClick={() => {
              setTrack(k);
              setPage(1);
            }}
            className={`rounded-full px-4 py-1.5 text-sm ${track === k ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-[var(--text-secondary)]'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        aria-label="搜索会话标题"
        placeholder="搜索会话标题（回车搜索）"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setAppliedKeyword(keyword.trim());
            setPage(1);
          }
        }}
        className="w-full rounded-xl border border-[var(--bg-subtle)] bg-white px-3 py-2 text-sm"
      />
      {failure ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">对话记录暂时加载失败</p>
          <button type="button" data-testid="chatlogs-retry" onClick={() => setReload((n) => n + 1)} className="mt-2 text-[var(--brand-600)]">
            重试
          </button>
        </div>
      ) : pageData === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : pageData.items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-[var(--text-secondary)]">当前筛选下没有对话记录</p>
      ) : (
        <ul className="space-y-2">
          {pageData.items.map((c: ParentChatLogItem) => (
            <li key={c.id} className="rounded-2xl bg-white p-4">
              <button
                type="button"
                data-testid={`chatlog-open-${c.id}`}
                onClick={() => setActiveId(c.id)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-[var(--text-primary)]">{c.title || '未命名会话'}</p>
                  {c.blockCount > 0 && (
                    <span data-testid={`chatlog-block-badge-${c.id}`} className="shrink-0 rounded-full bg-[var(--error)] px-2 py-0.5 text-[10px] font-bold text-white">
                      {`偏离学习 ${c.blockCount}`}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {c.track === 'mainline' ? '主线' : '辅线'} · {c.messageCount} 句 · {formatDateTime(c.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button
          type="button"
          data-testid="chatlogs-prev"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
          className="disabled:opacity-30"
        >
          上一页
        </button>
        <span>
          {page} / {totalPages}
        </span>
        <button
          type="button"
          data-testid="chatlogs-next"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
          className="disabled:opacity-30"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
