import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Progress, Skeleton, Tag } from '@/components/base';
import {
  ApiError,
  getParentDashboard,
  getParentStudyTime,
  getParentTodayUsage,
  type ParentDashboard,
  type ParentDashboardStudent,
  type ParentStudyTime,
  type ParentTodayUsage,
} from '@/services/api';
import { formatDuration } from '@/utils/duration';
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

/**
 * 学习时长区块（会话口径）。
 *
 * ⚠️ 它与同页的「近 7 天活跃 N 天」是**两套口径**（spec §10）：
 * 旧活跃 = 四路时间戳代理（答题/积分/考试/对话），新时长 = 显式会话。
 * 孩子挂机不答题时旧口径不活跃、新口径有时长；两者数字不同是**正常的**。
 * 因此这里**并列展示 + 文案区分**，绝不替换或合并。
 *
 * 「暂无数据」看**数组**而不是数字：两个端点**总会**返回对象（`totalSeconds` /
 * `activeSeconds` 只是普通数字，契约里没有「无数据」信号），所以「无会话」只能靠
 * 空数组判。数组与数字走同一个「有效会话」谓词，故**空数组 ⟹ 数字为 0**（单向，
 * 反之不然——`active_seconds = 0` 的会话会让数组非空而数字仍为 0）。
 * 不能改判 `totalSeconds === 0`，详见 `ParentReportPage` 同处注释。
 */
function StudyTimePanel({
  studentId,
  study,
  usage,
}: {
  studentId: number;
  study: ParentStudyTime | null;
  usage: ParentTodayUsage | null;
}) {
  return (
    <div className="mb-4 grid gap-4 md:grid-cols-2">
      <Card className="p-5" data-testid={`dashboard-study-time-${studentId}`}>
        <h3 className="text-base font-bold text-[var(--text-primary)]">学习时长（近 7 天）</h3>
        <p className="mt-2 text-2xl font-black text-[var(--text-primary)]">
          {study && study.byDay.length > 0 ? formatDuration(study.totalSeconds) : '暂无数据'}
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          会话口径：只统计进入学习页且有操作的时间，与「近 7 天活跃天数」不是同一口径。
        </p>
      </Card>

      <Card className="p-5" data-testid={`dashboard-today-usage-${studentId}`}>
        <h3 className="text-base font-bold text-[var(--text-primary)]">今日已用</h3>
        <p className="mt-2 text-2xl font-black text-[var(--text-primary)]">
          {usage && usage.byModule.length > 0 ? formatDuration(usage.activeSeconds) : '暂无数据'}
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {usage
            ? usage.limitMinutes === null
              ? '家长未设置每日上限'
              : `每日上限 ${usage.limitMinutes} 分钟${usage.exceeded ? ' · 已达上限' : ''}`
            : ' '}
        </p>
      </Card>
    </div>
  );
}

/** 单个孩子的概览面板（Tab 切换时整块换掉）。 */
function StudentPanel({ student }: { student: ParentDashboardStudent }) {
  const setStudentId = useParentStudentStore((s) => s.setStudentId);
  const navigate = useNavigate();

  const [study, setStudy] = useState<{ studentId: number; value: ParentStudyTime } | null>(null);
  const [usage, setUsage] = useState<{ studentId: number; value: ParentTodayUsage } | null>(null);

  /**
   * 派生数据带 `studentId` 归属：切 Tab 不重挂载本组件，只在 `useEffect` 里清空
   * 会让上一帧画出**上一个孩子**的时长（effect 在 commit 之后才跑）。
   * 按当前 `studentId` 比对后派生即可，不需要也不应该 setState(null)。
   */
  const studyValue = study && study.studentId === student.studentId ? study.value : null;
  const usageValue = usage && usage.studentId === student.studentId ? usage.value : null;

  useEffect(() => {
    let cancelled = false;
    const id = student.studentId;
    void Promise.all([getParentStudyTime(id), getParentTodayUsage(id)])
      .then(([studyRes, usageRes]) => {
        if (cancelled) return;
        setStudy({ studentId: id, value: studyRes });
        setUsage({ studentId: id, value: usageRes });
      })
      .catch(() => {
        // 时长是**增值信息**：取不到不影响既有概览显示，静默降级为「暂无数据」
      });
    return () => {
      cancelled = true;
    };
  }, [student.studentId]);

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

      <StudyTimePanel studentId={student.studentId} study={studyValue} usage={usageValue} />

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
