import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMarkdown,
} from '@/components/markdown';
import { getParentErrors, type ParentErrorItem } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

const PAGE_SIZE = 20;
type TrackFilter = 'all' | 'main' | 'training';

const TRACKS: Array<{ key: TrackFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'main', label: '主线' },
  { key: 'training', label: '训练' },
];

// 与桌面端 ParentErrorsPage 的 SOURCE_LABEL 同口径（source 是自由 VARCHAR(20)，
// 服务端 TRACK_SOURCES 分档表是唯一真源，这里只认这 6 个值，认不出就原样展示）。
const SOURCE_LABEL: Record<string, string> = {
  practice: '课堂练习',
  discuss: '讨论',
  exam: '真题考试',
  targeted: '专项练习',
  error_practice: '错题练习',
  auxiliary: '辅线答疑',
};

function questionText(item: ParentErrorItem): string {
  // ⚠️ api.ts ParentErrorItem 硬注释：wrongAnswerText 装的是「题库未命中时的题面原文」，
  // 不是学生作答；questionId 非空时题面在 question.content。
  return item.question?.content ?? item.wrongAnswerText ?? '（题面缺失）';
}

/**
 * 题面渲染走共享 Markdown 配置（KaTeX + 原生 HTML 表格 + 图片 resolveAsset +
 * repairHtml 修残缺标签），与学生端 / 桌面端家长错题页同一套，不另起炉灶。
 */
function StemMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {preprocessMarkdown(text)}
    </ReactMarkdown>
  );
}

/**
 * /m/parent/errors 移动端错题本（Task 7）。
 *
 * `data-testid="mobile-page-errors"` 被 Task 2 路由测试消费，参考 MobileAlertsPage
 * 的做法：testid 挂在**所有状态共用的外层容器**上，不只在数据就绪分支。
 *
 * 展示口径对齐桌面端 ParentErrorsPage：题面二选一（question.content ?? wrongAnswerText）；
 * `ParentErrorQuestion` 只有 content/type/difficulty/knowledgePoints，**没有 answer 字段**，
 * 所以展开详情只做题面 + 「答案与解析请在电脑端查看」引导，不新造数据源。
 */
export default function MobileErrorsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [items, setItems] = useState<ParentErrorItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [track, setTrack] = useState<TrackFilter>('all');
  const [error, setError] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const seqRef = useRef(0);
  const load = useCallback((id: number, p: number, t: TrackFilter) => {
    setError(false);
    const seq = ++seqRef.current;
    getParentErrors({
      studentId: id, page: p,
      ...(t === 'all' ? {} : { track: t }),
    })
      .then((res) => {
        if (seq !== seqRef.current) return; // 旧请求后到，丢弃（响应里带回显 page）
        setItems(res.items); setTotal(res.total); setPage(res.page);
      })
      .catch(() => { if (seq === seqRef.current) setError(true); });
  }, []);

  // 单一 effect 负责所有重拉（换孩子 / 翻页 / 筛选）：
  // - 换孩子（硬规则）：回第 1 页 + 清展开态，track 保持不变；
  // - 用 key 去重：换孩子时 setPage(1) 引发的二次运行不再发请求（首拉只发一次）。
  const lastStudentRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (studentId === null) return;
    const changedStudent = lastStudentRef.current !== studentId;
    lastStudentRef.current = studentId;
    let p = page;
    if (changedStudent) {
      p = 1; // 硬规则：换孩子必须回第 1 页
      if (page !== 1) setPage(1);
      setOpenId(null);
    }
    const key = `${studentId}|${p}|${track}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    load(studentId, p, track);
  }, [studentId, page, track, load]);

  if (studentId === null) {
    return (
      <div data-testid="mobile-page-errors">
        <p className="text-black/60">先在上方选择孩子</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div data-testid="mobile-page-errors" className="space-y-3">
      <div className="flex gap-2">
        {TRACKS.map((t) => (
          <button
            key={t.key}
            data-testid={`track-filter-${t.key}`}
            onClick={() => { setTrack(t.key); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-sm ${track === t.key ? 'bg-[var(--brand-500)] text-white' : 'bg-white text-black/60'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-black/60">加载失败</p>
          <button data-testid="errors-retry" onClick={() => load(studentId, page, track)} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      ) : items === null ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white" />
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-black/60">暂无错题</p>
      ) : (
        <ul className="space-y-2">
          {items.map((e) => (
            <li key={e.id} className="rounded-2xl bg-white p-4">
              <button className="w-full text-left" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                <div className="flex items-center justify-between text-xs text-black/40">
                  <span>{e.track === 'main' ? '主线' : '训练'} · {SOURCE_LABEL[e.source] ?? e.source}</span>
                  <span>{e.isCleared ? '已清零' : `错 ${e.level} 次`}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-sm"><StemMarkdown text={questionText(e)} /></div>
              </button>
              {openId === e.id && (
                <div className="mt-3 border-t border-black/5 pt-3 text-sm">
                  <StemMarkdown text={questionText(e)} />
                  <p className="mt-2 text-xs text-black/40">
                    {e.question
                      ? '题目详情请在电脑端查看完整解析'
                      : (e.wrongAnswerText ? '题目未入库（以上为入库时保存的题面原文）' : '题目未入库，且未保存题面')}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between px-2 text-sm">
        <button data-testid="errors-prev" disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-30">上一页</button>
        <span>{page} / {totalPages}</span>
        <button data-testid="errors-next" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="disabled:opacity-30">下一页</button>
      </div>
    </div>
  );
}
