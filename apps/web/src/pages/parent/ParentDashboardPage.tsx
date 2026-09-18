import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Progress, Skeleton, Tag } from '@/components/base';
import { ApiError, getParentDashboard, type ParentDashboard, type ParentDashboardStudent } from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/** `rate` 为 null（一道题都没做过）时必须显示「暂无数据」——显示 0% 会被读成「全错了」。 */
function formatRate(rate: number | null): string {
  return rate === null ? '暂无数据' : `${rate}%`;
}

function formatLastActive(iso: string | null): string {
  if (!iso) return '暂无记录';
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 学科卡片：进度 + 正确率 + 错题 + 考试场次。 */
function SubjectCard({ subject }: { subject: ParentDashboardStudent['subjects'][number] }) {
  return (
    <Card className="p-5" data-testid={`dashboard-subject-${subject.subjectId}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--text-primary)]">{subject.subjectName}</h3>
        <span className="text-sm text-[var(--text-secondary)]">
          {`${subject.progress.completedUnits} / ${subject.progress.totalUnits} 单元`}
        </span>
      </div>

      <div className="mt-3">
        <Progress value={subject.progress.percent} />
      </div>

      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        {subject.progress.currentUnitName
          ? `当前：${subject.progress.currentUnitName}${
              subject.progress.currentLessonName ? ` · ${subject.progress.currentLessonName}` : ''
            }`
          : '尚未开始学习'}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[var(--text-tertiary)]">正确率</dt>
          <dd className="font-semibold text-[var(--text-primary)]">
            {formatRate(subject.accuracy.rate)}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">未清零错题</dt>
          <dd className="font-semibold text-[var(--text-primary)]">{subject.errorBook.uncleared}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">已考场次</dt>
          <dd className="font-semibold text-[var(--text-primary)]">{subject.examCount}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-tertiary)]">主观自评</dt>
          <dd className="font-semibold text-[var(--text-primary)]">
            {`${subject.selfAssessed.correctCount} / ${subject.selfAssessed.count}`}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/** 单个孩子的概览面板（Tab 切换时整块换掉）。 */
function StudentPanel({ student }: { student: ParentDashboardStudent }) {
  const setStudentId = useParentStudentStore((s) => s.setStudentId);
  const navigate = useNavigate();

  /**
   * 快捷入口必须先 `setStudentId` 再跳：报告/错题/回放三页跟随顶栏锚点，
   * 只 navigate 不设锚点会跳到「顶栏那个孩子」身上，而不是当前 Tab 这个。
   *
   * 用 `Button + navigate` 而不是 `<Link><Button/></Link>`：后者是 `<a>` 里套 `<button>`，
   * 属于嵌套交互元素（无效 HTML，键盘/读屏行为不确定）。
   */
  const goto = (path: string) => {
    setStudentId(student.studentId);
    navigate(path);
  };

  return (
    <div data-testid={`dashboard-student-${student.studentId}`}>
      <Card elevation="flat" className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{student.name}</span>
          {student.grade && <Tag>{student.grade}</Tag>}
        </div>
        <span className="text-sm text-[var(--text-secondary)]">
          {`近 7 天活跃 ${student.activeDays7} 天`}
        </span>
        <span className="text-sm text-[var(--text-secondary)]">
          {`最近活跃 ${formatLastActive(student.lastActiveAt)}`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/report')}>
            学情报告
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/errors')}>
            错题查看
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goto('/parent/chat-logs')}>
            对话回放
          </Button>
        </div>
      </Card>

      {student.subjects.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">
            这个孩子还没有开始任何主线学科的学习。
          </p>
          <Link
            to={`/parent/students/${student.studentId}/config`}
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去配置教材
          </Link>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {student.subjects.map((subject) => (
            <SubjectCard key={subject.subjectId} subject={subject} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ParentDashboardPage() {
  const [data, setData] = useState<ParentDashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    getParentDashboard()
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        // 1002/1005 是账号类问题（学生不存在/无权限），重试没有意义 → 引导去账号页
        if (err instanceof ApiError && (err.code === 1002 || err.code === 1005)) {
          navigate('/parent/students');
          return;
        }
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, navigate]);

  const students = data?.students ?? [];
  // 选中的孩子：默认第一个；数据刷新后原 id 若不存在则回落第一个
  const current =
    students.find((s) => s.studentId === activeId) ?? students[0] ?? null;

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">仪表盘</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          一屏掌握所有孩子的学情概览
        </p>
      </header>

      {failed ? (
        <Card
          data-testid="dashboard-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">学情概览暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : data === null ? (
        <div data-testid="dashboard-skeleton" className="space-y-4">
          <Skeleton width="100%" height={72} rounded />
          <Skeleton width="100%" height={196} rounded />
        </div>
      ) : students.length === 0 ? (
        <Card data-testid="dashboard-empty" className="p-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">还没有孩子账号</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            先为孩子开通学生账号，再回来查看学情概览。
          </p>
          <Link
            to="/parent/students"
            className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
          >
            去创建学生账号
          </Link>
        </Card>
      ) : (
        <>
          {students.length > 1 && (
            <div role="tablist" className="mb-4 flex gap-2">
              {students.map((s) => (
                <button
                  key={s.studentId}
                  role="tab"
                  type="button"
                  aria-selected={s.studentId === current?.studentId}
                  onClick={() => setActiveId(s.studentId)}
                  className={clsx(
                    'px-4 py-1.5 rounded-full text-sm font-medium border transition-colors',
                    s.studentId === current?.studentId
                      ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                      : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          {current && <StudentPanel student={current} />}
        </>
      )}
    </div>
  );
}
