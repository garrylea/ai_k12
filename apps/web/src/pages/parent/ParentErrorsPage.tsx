import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Pagination, Skeleton, Tag } from '@/components/base';
import {
  ApiError,
  fetchSubjects,
  getParentErrors,
  type ParentErrorItem,
  type ParentErrorPage,
  type SubjectItem,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

type TrackFilter = 'all' | 'main' | 'aux';

const TRACK_TABS: Array<{ key: TrackFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'main', label: '主线' },
  { key: 'aux', label: '辅线' },
];

/**
 * 「来源」下拉的可选项 —— **按轨道分组**，不是一张扁平表。
 *
 * 为什么必须分轨道：后端 `main` 的语义就是 `source <> 'auxiliary'`（反向排除），
 * 与 `source = 'auxiliary'` 互斥。若「主线」Tab 下也能选到「辅线答疑」，请求会变成
 * `track=main&source=auxiliary` → 两个条件 AND 起来**永不匹配** → 后端安静地返回
 * 空列表 + `total: 0`，家长会读成「孩子没有错题」。**这个矛盾组合必须在 UI 上就无法选中**，
 * 而不是靠切轨道时清来源去补救（那只防了一个方向）。
 *
 * 值取自服务端实际写入点（`main_error_books.source` 是自由 `VARCHAR(20)`，DB 层无 enum，
 * 所以前端这份清单就是唯一的枚举处）：`practice` / `discuss` / `exam` / `targeted` /
 * `error_practice` / `auxiliary`。
 */
const SOURCES_BY_TRACK: Record<TrackFilter, Array<{ value: string; label: string }>> = {
  all: [
    { value: '', label: '全部来源' },
    { value: 'practice', label: '课堂练习' },
    { value: 'discuss', label: '讨论' },
    { value: 'exam', label: '真题考试' },
    { value: 'targeted', label: '专项练习' },
    { value: 'error_practice', label: '错题练习' },
    { value: 'auxiliary', label: '辅线答疑' },
  ],
  main: [
    { value: '', label: '全部来源' },
    { value: 'practice', label: '课堂练习' },
    { value: 'discuss', label: '讨论' },
    { value: 'exam', label: '真题考试' },
    { value: 'targeted', label: '专项练习' },
    { value: 'error_practice', label: '错题练习' },
    // 刻意没有 auxiliary：主线 Tab 下它永远匹配不到东西
  ],
  aux: [
    { value: '', label: '全部来源' },
    { value: 'auxiliary', label: '辅线答疑' },
  ],
};

// 行内来源标签要认识**全部** 6 个值 —— 「全部」Tab 下会出现辅线行（含 auxiliary）
const SOURCE_LABEL = new Map(
  SOURCES_BY_TRACK.all.map((o) => [o.value, o.label]),
);

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ErrorRow({ item }: { item: ParentErrorItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-testid={`error-row-${item.id}`} className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tag variant={item.track === 'aux' ? 'auxiliary' : 'mainline'}>
          {item.track === 'aux' ? '辅线' : '主线'}
        </Tag>
        <Tag>{SOURCE_LABEL.get(item.source) ?? item.source}</Tag>
        <span className="text-xs text-[var(--text-tertiary)]">{`难度级别 L${item.level}`}</span>
        <span className="text-xs text-[var(--text-tertiary)]">{formatDay(item.createdAt)}</span>
        <Tag variant={item.isCleared ? 'easy' : 'hard'}>
          {item.isCleared ? '已清零' : '未清零'}
        </Tag>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open && (
        <div
          data-testid={`error-detail-${item.id}`}
          className="mt-3 rounded-[var(--radius-card)] bg-[var(--bg-subtle)] p-4 text-sm"
        >
          {item.question ? (
            <>
              <p className="whitespace-pre-wrap text-[var(--text-primary)]">
                {item.question.content}
              </p>
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {`题型：${item.question.type || '未标注'} · 难度：${
                  item.question.difficulty ?? '未标注'
                }`}
              </p>
              {item.question.knowledgePoints.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.question.knowledgePoints.map((kp) => (
                    <Tag key={kp.id} variant="knowledge">{kp.name}</Tag>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-[var(--text-secondary)]">题目未入库（仅保存了作答内容）</p>
          )}

          <p className="mt-3 text-[var(--text-secondary)]">
            {`学生作答：${item.wrongAnswerText || '（空）'}`}
          </p>
          {item.clearedAt && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              {`清零时间：${formatDay(item.clearedAt)}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ParentErrorsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);
  const [track, setTrack] = useState<TrackFilter>('main');
  const [subject, setSubject] = useState('');
  const [source, setSource] = useState('');
  const [cleared, setCleared] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [data, setData] = useState<{ studentId: number; value: ParentErrorPage } | null>(null);
  const [failure, setFailure] = useState<{ studentId: number; code: number | null } | null>(null);
  const [reload, setReload] = useState(0);

  // 「自报家门」：不归当前孩子、或回显页号与当前页不符，都当作「还没到货」
  const list =
    data && data.studentId === studentId && data.value.page === page ? data.value : null;
  const err = failure && failure.studentId === studentId ? failure : null;

  // 学科下拉走既有的 /content/subjects（不新增端点）。失败就不显示这个筛选，不打扰家长。
  useEffect(() => {
    let cancelled = false;
    fetchSubjects()
      .then((res) => {
        if (!cancelled) setSubjects(res);
      })
      .catch(() => {
        /* 拉不到学科就退化为「不筛学科」 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 换孩子必须回第 1 页：否则会拿「上一个孩子的第 2 页」去请求新孩子，
  // 若新孩子错题不足 20 条，响应 `items: []` 但回显 page 仍是 2（守卫会通过），
  // 页面就停在「当前筛选下没有错题」，而**分页控件只在非空分支里渲染**——家长无法自救。
  useEffect(() => {
    setPage(1);
  }, [studentId]);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentErrors({
      studentId,
      ...(track === 'all' ? {} : { track }),
      ...(subject ? { subject: Number(subject) } : {}),
      ...(source ? { source } : {}),
      ...(cleared ? { cleared: cleared as 'uncleared' | 'cleared' } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      page,
    })
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setFailure({ studentId, code: error instanceof ApiError ? error.code : null });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, track, subject, source, cleared, from, to, page, reload]);

  /** 任何筛选变化都要回第 1 页，否则会停在「第 3 页」而结果只有 1 页。 */
  const changeFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  if (studentId === null) {
    return (
      <Card data-testid="errors-no-student" className="p-10 text-center">
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

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">错题查看</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          孩子的错题本（只读），与学生在错题练习里看到的是同一份数据
        </p>
      </header>

      <div role="tablist" className="mb-4 flex gap-2">
        {TRACK_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={track === t.key}
            // 切轨道时**必须清掉来源筛选**：`track=aux`（source = 'auxiliary'）叠加
            // `source='exam'` 在 SQL 里是永不匹配的组合，后端会安静地返回空列表 +
            // total 0，家长会读成「孩子没有错题」。这属于筛选器自相矛盾，前端负责不让它发生。
            onClick={() =>
              changeFilter(() => {
                setTrack(t.key);
                setSource('');
              })
            }
            className={clsx(
              'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
              track === t.key
                ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          学科
          <select
            aria-label="学科"
            value={subject}
            onChange={(e) => changeFilter(() => setSubject(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部学科</option>
            {subjects.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          来源
          <select
            aria-label="来源"
            value={source}
            onChange={(e) => changeFilter(() => setSource(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            {SOURCES_BY_TRACK[track].map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-tertiary)]">
          清零状态
          <select
            aria-label="清零状态"
            value={cleared}
            onChange={(e) => changeFilter(() => setCleared(e.target.value))}
            className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="">全部</option>
            <option value="uncleared">未清零</option>
            <option value="cleared">已清零</option>
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
      </Card>

      {err?.code === 1002 ? (
        <Card data-testid="errors-student-missing" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            该孩子账号不存在，请在顶部切换其它孩子
          </p>
        </Card>
      ) : err ? (
        <Card
          data-testid="errors-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">错题暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : list === null ? (
        <div data-testid="errors-skeleton" className="space-y-3">
          <Skeleton width="100%" height={56} />
          <Skeleton width="100%" height={56} />
        </div>
      ) : list.items.length === 0 ? (
        <Card data-testid="errors-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">当前筛选下没有错题</p>
        </Card>
      ) : (
        <Card className="p-5">
          <p className="mb-2 text-sm text-[var(--text-secondary)]">{`共 ${list.total} 道`}</p>
          <div className="divide-y divide-[var(--bg-subtle)]">
            {list.items.map((item) => (
              <ErrorRow key={item.id} item={item} />
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
