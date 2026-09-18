import { useEffect, useState, useMemo, useRef, useCallback, Children } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownComponents,
  preprocessMarkdown,
  MarkdownImg,
} from '@/components/markdown';
import { useThemeStore } from '@/store/themeStore';
import { fetchLessonCards, getUnclearedErrors, getMyPoints, updateProgress, judgePractice, getPracticeHint, getPracticeResults, resetPracticeCard, resetPracticeLesson, fetchStarMap, type LessonCard, type LessonCardsData, type PracticeGroupMeta, type PreviousErrorDetail } from '@/services/api';
import { BackButton, LogoutButton, ConfirmDialog } from '@/components/base';
import { CelebrationOverlay, UserBadge } from '@/components/business';
import { AnswerModal, type PracticeQuestion } from '@/components/business/AnswerModal';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import { DiscussDrawer } from '@/components/business/DiscussDrawer';
import { CleanupPhase } from '@/components/business/CleanupPhase';
import { usePracticeStore } from '@/store/practiceStore';
import { usePointsStore } from '@/store/pointsStore';

// --- Icons ---
const ChevronLeftIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);
const ChevronRightIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);
const ChatIcon = () => (
  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const SunIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const CheckCircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="9 12 12 15 16 10" />
  </svg>
);

const CircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
  </svg>
);

const LockIcon2 = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const RefreshIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const CARD_TYPE_LABEL: Record<LessonCard['cardType'], string> = {
  concept: '概念',
  example: '例题',
  practice: '练习',
  explore: '探究',
  summary: '小结',
  reading: '阅读',
};

/** 判断一段文本是否为图片标注（以"图"开头，如"图21.1-1"） */
const FIGURE_CAPTION_RE = /^图[\d\u4e00-\u9fff]/;

/**
 * 检查 ReactMarkdown 的 p 节点 children 是否包含「图片 + 图注」结构。
 * 如果是，返回 { imgEl, caption }；否则返回 null。
 *
 * 注意：因为我们在 components 里提供了自定义的 img 组件，
 * 子元素的 type 是函数而非字符串 'img'，所以用 props.src 来识别图片。
 */
function extractFigureCaption(children: React.ReactNode): {
  imgEl: React.ReactNode;
  caption: string;
} | null {
  const kids = Children.toArray(children);
  const imgKid = kids.find((c) => {
    if (c === null || typeof c !== 'object' || !('props' in c)) return false;
    return !!c.props?.src;
  });
  if (!imgKid) return null;

  const imgIdx = kids.indexOf(imgKid);
  const afterText = kids
    .slice(imgIdx + 1)
    .map((c) => {
      if (typeof c === 'string') return c;
      if (typeof c === 'number') return String(c);
      return '';
    })
    .join('')
    .trim();

  if (!afterText || !FIGURE_CAPTION_RE.test(afterText)) return null;

  return { imgEl: imgKid, caption: afterText };
}

/** 递归提取 React 子节点的纯文本（用于判断段落类型） */
function getNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return getNodeText(node.props?.children);
  }
  return '';
}

/** 练习题子项模式：(1) (2) ... (10) 或 1. 2. 等 */
const EXERCISE_ITEM_RE = /^\(?([1-9]\d?)[.)]/;
/** 题干模式：以：或:结尾 */
const EXERCISE_STEM_RE = /[：:]$/;

/**
 * 预处理卡片内容 markdown：
 * 1. 转义行首 "N." 防止 markdown 解析为有序列表（保留题号文本）
 * 2. 同行/单换行分隔的子题 "；(N)" / "; (N)" / "$ (N)" 拆成独立段落
 * 3. 题干后确保段落分隔
 */
function preprocessContent(raw: string): string {
  let result = raw;
  // 1. 转义行首 N. 防止有序列表
  result = result.replace(/^(\d+)\.\s/gm, '$1\\. ');
  // 1.5 全角括号数字统一为半角，避免（1）和(1)视觉上不对齐
  result = result.replace(/（([1-9]\d?)）/g, '($1)');
  // 2. 同行/单换行分隔的子题 "；(N)" / "; (N)" 拆成独立段落
  //    只匹配标点后（分号、冒号、句号、问号、感叹号）的 (N)，避免误拆正文中的括号，如"与(2)类似"
  result = result.replace(/([；;：:。．.？?！!])\s*\((\d+)\)/g, '$1\n\n($2)');
  // 3. 题干后确保段落分隔：：\n\n(N) 已由 2 保证，这里处理 ：(N) 无空格情况
  result = result.replace(/([：:])\((\d+)\)/g, '$1\n\n($2)');
  // 4. 若内容以 ## 开头且紧接着还有另一行标题，则将首行 ## 提升为 #（大节标题更大）
  result = result.replace(/^(#{2,6})\s(.+?)\n\n(#{1,6}\s)/m, '# $2\n\n$3');
  return result;
}

/** 判断 markdown 内容是否以标题行开头（# ~ ######） */
function contentStartsWithHeading(raw: string): boolean {
  const processed = preprocessContent(raw);
  const firstNonEmptyLine = processed.split('\n').find(line => line.trim().length > 0);
  return !!firstNonEmptyLine && /^#{1,6}\s/.test(firstNonEmptyLine.trim());
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-[var(--bg-subtle)] rounded-lg mx-auto" />
        <div className="h-[24rem] w-[46rem] max-w-[90vw] bg-[var(--bg-subtle)] rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[var(--bg-base)]">
      <p className="text-[var(--text-secondary)] text-lg">{message}</p>
      <button onClick={onRetry} className="px-6 py-2.5 bg-[var(--brand-500)] text-white rounded-[var(--radius-button)] font-medium">
        重试
      </button>
    </div>
  );
}

export default function CourseDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { mode, setMode, autoToggleNightMode } = useThemeStore();

  const lessonId =
    (location.state as { lessonId?: number } | null)?.lessonId ??
    Number(searchParams.get('lessonId'));
  const breadcrumb = (location.state as { breadcrumb?: string } | null)?.breadcrumb ?? '';
  const subjectName = (location.state as { subjectName?: string } | null)?.subjectName ?? '';
  const gradeName = (location.state as { gradeName?: string } | null)?.gradeName ?? '';
  const subjectId = (location.state as { subjectId?: number } | null)?.subjectId ?? 0;
  const username = localStorage.getItem('username') ?? '';
  const [data, setData] = useState<LessonCardsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 错题清零：进每节课前清空错题本里所有 practice 未清题（计数 = cleanupErrors.length）
  const [cleanupErrors, setCleanupErrors] = useState<PreviousErrorDetail[]>([]);
  const [cleanupDone, setCleanupDone] = useState(false);
  // 本课是否已有课堂练习记录（practice_results）--决定侧栏「重置本课课堂练习」按钮显隐
  const [hasLessonResults, setHasLessonResults] = useState(false);
  const [page, setPage] = useState(0);
  const prevPageRef = useRef(0);
  const [showCelebration, setShowCelebration] = useState(false);
  const [nextLessonId, setNextLessonId] = useState<number | null>(null);
  const [isSubjectCompleted, setIsSubjectCompleted] = useState(false);
  // 升级庆祝：`name` 为 null 表示段位名没取到（降级只显示 code 的图标 + 通用标题）
  const [celebrationLevel, setCelebrationLevel] = useState<{ code: string; name: string | null } | null>(null);
  const [celebrationPoints, setCelebrationPoints] = useState(0);
  const pushPointsToast = usePointsStore((s) => s.push);
  /** 晋升走全屏庆祝、不 push 轻反馈，但分已入账——必须显式递增账本版本号，
   *  否则侧栏 UserBadge 停在旧余额，与庆祝层上的 +N 分同屏打架（见 pointsStore.bumpRevision）。 */
  const bumpPointsRevision = usePointsStore((s) => s.bumpRevision);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStart, setModalStart] = useState(0);
  const [resultOpen, setResultOpen] = useState(false);
  const [showCardDiscuss, setShowCardDiscuss] = useState(false);
  const { cardId: sessionCardId, loadResults, record, answers, questions: sessionQuestions, reset, clearAnswers, hints, setHint } = usePracticeStore();
  // 浮层状态：门禁拦截提示 / 重置本课确认 / 重置本卡确认
  const [gateError, setGateError] = useState<string | null>(null);
  const [resetLessonOpen, setResetLessonOpen] = useState(false);
  const [resetCardOpen, setResetCardOpen] = useState(false);

  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    reset(); // 清空上一课的 practice store 状态
    try {
      if (!lessonId) throw new Error('缺少课程信息，请从星图选择小节进入');
      // 错题清零只出现在「新课」（当前学习进度指向的课）进入时；
      // 复习已学过的课（star-map status !== 'current'）不再显示错题清零阶段。
      let isCurrentLesson = true; // 无进度信息 / 拉取失败时保守按新课处理
      const studentId = Number(localStorage.getItem('userId')) || 0;
      if (studentId && subjectId) {
        try {
          const starMap = await fetchStarMap(studentId, subjectId);
          for (const ch of starMap.chapters) {
            const sec = ch.sections.find(s => String(s.id) === String(lessonId));
            if (sec) {
              isCurrentLesson = sec.status === 'current';
              break;
            }
          }
        } catch {
          /* 拉取失败：保守按新课处理 */
        }
      }
      const [result, uncleared] = await Promise.all([
        fetchLessonCards(lessonId),
        // 错题清零门禁只看「当前课之前」的错题（lessonId 过滤）：
        // 本课练习刚产生的错题不触发清零阶段，留待进入下一课时再清
        subjectId && isCurrentLesson
          ? getUnclearedErrors(subjectId, lessonId).catch(() => ({ errors: [] as PreviousErrorDetail[] }))
          : Promise.resolve({ errors: [] as PreviousErrorDetail[] }),
      ]);
      if (result.cards.length === 0) throw new Error('本节暂无卡片内容');
      setData(result);
      setCleanupErrors(uncleared.errors);
      setCleanupDone(false);
      setPage(0);
      // 本课是否已有课堂练习记录（决定侧栏「重置本课课堂练习」按钮显隐）
      const practiceCards = result.cards.filter(c => c.cardType === 'practice');
      setHasLessonResults(
        practiceCards.length > 0 &&
          (await Promise.all(practiceCards.map(c => getPracticeResults(c.id).catch(() => [])))).some(r => r.length > 0),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '加载失败') : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [lessonId]);

  useEffect(() => {
    prevPageRef.current = 0;
    setShowCelebration(false);
    setNextLessonId(null);
    setIsSubjectCompleted(false);
    setCelebrationLevel(null);
    setCelebrationPoints(0);
  }, [lessonId]);

  // 翻页时关闭 modal / 结果列表 / 卡片讨论抽屉
  useEffect(() => {
    setModalOpen(false);
    setResultOpen(false);
    setShowCardDiscuss(false);
  }, [page]);

  useEffect(() => {
    if (!data || !subjectId || !lessonId) return;
    const card = data.cards[page];
    if (!card) return;
    // 仅向前翻且未到最后一页时上报进度（记住学习位置）。
    // 最后一页的课程完成只由「完成」按钮触发，避免跳过练习直接翻到底就自动完成本课。
    if (page > prevPageRef.current && page < data.cards.length - 1) {
      updateProgress({ subjectId, lessonId, cardSortOrder: card.sortOrder })
        .then((res) => {
          if (res.advanced) {
            if (res.completed) {
              setIsSubjectCompleted(true);
            } else if (res.nextLessonId) {
              setNextLessonId(res.nextLessonId);
            }
          }
        })
        .catch(() => {});
    }
    prevPageRef.current = page;
  }, [page, data, subjectId, lessonId]);

  const total = data?.cards.length ?? 0;
  const card = useMemo(() => data?.cards[page] ?? null, [data, page]);

  // 解析当前 practice 卡的 content_metadata（后端返回为 metadata 字段，已 parse 为对象）
  // groups 结构：[{intro, questions:[{n,text}]}]，前端展平为 questions 数组并用 "groupIdx-n" 复合键
  const practiceMeta = useMemo(() => {
    if (card?.cardType !== 'practice' || !card.metadata) return null;
    const md = card.metadata;
    if (md.groups?.length) {
      const flatQuestions: PracticeQuestion[] = [];
      md.groups.forEach((g, gi) => {
        g.questions.forEach(q => {
          flatQuestions.push({ n: `${gi}-${q.n}`, text: q.text });
        });
      });
      return { groups: md.groups, questions: flatQuestions, needsFallback: false };
    }
    if (md.needs_fallback) return { groups: null as PracticeGroupMeta[] | null, questions: [] as PracticeQuestion[], needsFallback: true };
    return { groups: null as PracticeGroupMeta[] | null, questions: [] as PracticeQuestion[], needsFallback: true };
  }, [card]);

  // needs_fallback 卡：从 content 中用正则提取可点题块
  const fallbackPractice = useMemo<{ intro: string; questions: PracticeQuestion[] } | null>(() => {
    if (card?.cardType !== 'practice' || !practiceMeta?.needsFallback) return null;
    // NFKC 归一仅用于 practice 兜底正则提取（修 (2） 半全角混排）；
    // 不在全局 preprocessContent 做，避免影响非练习卡的中文全角标点渲染。
    const processed = preprocessContent(card.content.normalize('NFKC'));
    const paragraphs = processed.split('\n\n').map(p => p.trim()).filter(Boolean);
    const introParts: string[] = [];
    const qs: PracticeQuestion[] = [];
    let n = 1;
    let foundExercise = false;
    for (const para of paragraphs) {
      if (EXERCISE_ITEM_RE.test(para)) {
        qs.push({ n: `0-${n}`, text: para });
        n++;
        foundExercise = true;
      } else if (!foundExercise) {
        introParts.push(para);
      }
    }
    if (qs.length === 0) return null;
    return { intro: introParts.join('\n\n'), questions: qs };
  }, [card, practiceMeta]);

  // 进卡加载持久化判题结果 -> ✓/✗ 回显（跨设备/刷新）。
  // 每次进入练习卡都重新加载（loadResults 按卡清空旧 answers 并填充 DB 结果），
  // 避免翻回已加载卡时 answers 残留上一卡内容、门禁误判"加载中"。
  useEffect(() => {
    if (card?.cardType !== 'practice') return;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return;
    getPracticeResults(card.id)
      .then((results) => loadResults(card.id, questions, results))
      .catch(() => loadResults(card.id, questions, [])); // 失败时也置空 session，避免门禁永久"加载中"
  }, [card?.id]);

  // 重新计算本课是否有课堂练习记录（reset 后刷新侧栏「重置本课课堂练习」按钮显隐）
  const refreshHasLessonResults = async () => {
    if (!data) return;
    const practiceCards = data.cards.filter(c => c.cardType === 'practice');
    if (practiceCards.length === 0) { setHasLessonResults(false); return; }
    try {
      const all = await Promise.all(practiceCards.map(c => getPracticeResults(c.id).catch(() => [])));
      setHasLessonResults(all.some(r => r.length > 0));
    } catch { /* ignore */ }
  };

  // 学生在本课作答后（answers 非空），立即让侧栏「重置本课课堂练习」按钮显示
  useEffect(() => {
    if (card?.cardType === 'practice' && Object.keys(answers).length > 0) {
      setHasLessonResults(true);
    }
  }, [answers, card]);

  // --- 练习作答门禁：练习卡题目未全部作答时阻止翻页/完成 ---
  // 依据 practiceStore.answers（进入练习卡时 loadResults 已用 DB 结果填充；
  // sessionCardId 守卫消除"进入新卡瞬间残留上一卡 answers"的竞态）。
  const practiceGateError = useCallback((): string | null => {
    if (!card || card.cardType !== 'practice') return null;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return null; // 无可作答项，不拦截
    if (sessionCardId !== card.id) return '练习记录加载中，请稍候再试';
    const unanswered = questions.filter(q => !answers[q.n]);
    if (unanswered.length > 0) return `还有 ${unanswered.length} 道练习未作答，请先完成本卡全部练习`;
    return null;
  }, [card, practiceMeta, fallbackPractice, sessionCardId, answers]);

  // 供键盘 handler 读取最新闭包（避免频繁重注册 window listener）
  const practiceGateRef = useRef<() => string | null>(() => null);
  practiceGateRef.current = practiceGateError;

  // 渐进解锁：第 i 题可点当且仅当前面所有题均已作答（answers 以复合键 q.n 存储）。
  // 保证只能顺序作答，末题提交时必然前面已全部完成 -> 对错表合法。
  const isQuestionUnlocked = useCallback((i: number, questions: PracticeQuestion[]): boolean => {
    if (i <= 0) return true;
    return questions.slice(0, i).every(q => answers[q.n]);
  }, [answers]);

  /** 练习卡未全部作答时阻止翻页/完成；返回 true 表示已拦截。 */
  const blockIfPracticeIncomplete = (): boolean => {
    const block = practiceGateRef.current();
    if (block) {
      setGateError(block);
      return true;
    }
    return false;
  };

  const handleNext = () => {
    if (blockIfPracticeIncomplete()) return;
    setPage(p => Math.min(total - 1, p + 1));
  };

  // 打开答题 modal：首次打开时初始化 session
  const handleOpenModal = (index: number) => {
    if (!card) return;
    const questions = (practiceMeta && !practiceMeta.needsFallback)
      ? practiceMeta.questions
      : (fallbackPractice?.questions ?? []);
    if (questions.length === 0) return;
    if (sessionCardId !== card.id) {
      // 首次进卡：DB 结果可能尚未加载，先放空 answers 占位（cardId+questions 就位即可开弹窗）；
      // loadResults effect 随后会用持久化结果填补 answers。
      loadResults(card.id, questions, []);
    }
    // 渐进解锁兜底：请求的题前面有未做题（未解锁）时，改开第一道未做题
    const firstUnanswered = questions.findIndex(q => !answers[q.n]);
    const target = (firstUnanswered !== -1 && index > firstUnanswered) ? firstUnanswered : index;
    setModalStart(target);
    setModalOpen(true);
  };

  const finishLesson = async () => {
    if (!data || !subjectId || !lessonId) return;
    // 门禁：最后一页若是练习卡，须全部作答才能完成
    if (blockIfPracticeIncomplete()) return;
    const lastCard = data.cards[data.cards.length - 1];
    let points: Awaited<ReturnType<typeof updateProgress>>['points'];
    try {
      const res = await updateProgress({ subjectId, lessonId, cardSortOrder: lastCard.sortOrder });
      points = res.points;
      if (res.completed) {
        setIsSubjectCompleted(true);
      } else if (res.nextLessonId) {
        setNextLessonId(res.nextLessonId);
      } else if (res.reason === 'not_current_lesson' && res.currentLessonId) {
        // Progress was already advanced by the page-turn effect
        setNextLessonId(res.currentLessonId);
      } else if (res.reason === 'practice_incomplete') {
        // 后端兜底：仍存在未作答的练习（绕过前端拦截时），阻止完成
        setGateError('本课练习未完成，无法结束课程');
        return;
      }
    } catch {
      // ignore
    }
    // 积分反馈：升级走全屏庆祝（不与轻反馈同弹）；仅正分才发轻反馈，
    // `awarded === 0`（幂等命中 / no_rule）静默——不是「已达上限」。
    const awarded = points?.awarded ?? 0;
    if (points?.levelUp) {
      const to = points.levelUp.to;
      // 晋升只弹全屏庆祝、不发轻反馈；但本课分已入账，必须让徽章重拉余额
      bumpPointsRevision();
      setCelebrationLevel({ code: to, name: null });
      // 段位名的唯一真源在后端：升级后再要一次概览，用升级后的 level（失败则只显示图标）
      getMyPoints()
        .then((me) => {
          setCelebrationLevel((current) =>
            current && current.code === to ? { code: to, name: me.level.name } : current,
          );
        })
        .catch(() => { /* 降级：不显示段位名 */ });
    } else {
      // 非升级路径必须显式清掉上一次的升级态，否则重复完成会一直显示旧段位
      setCelebrationLevel(null);
      if (awarded > 0) pushPointsToast({ points: awarded, title: '完成本课' });
    }
    setCelebrationPoints(awarded);
    setShowCelebration(true);
  };

  const handleStartNewLesson = () => {
    setShowCelebration(false);
    if (isSubjectCompleted) {
      navigate('/student/star-map', { state: { subjectId } });
    } else if (nextLessonId) {
      navigate('/student/course-detail', {
        state: {
          lessonId: nextLessonId,
          subjectName,
          gradeName,
          subjectId,
        },
      });
    } else {
      navigate('/student/star-map', { state: { subjectId } });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 答题弹窗 / 结果列表 / 庆祝覆盖层打开时，禁用左右键翻页
      // 浮层打开时禁用键盘翻页（答题 modal / 结果列表 / 庆祝层 / 门禁提示 / 重置确认）
      if (modalOpen || resultOpen || showCelebration || gateError !== null || resetLessonOpen || resetCardOpen) return;
      // 焦点在输入控件内时，不拦截左右键（让用户正常移动光标）
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (document.activeElement as HTMLElement)?.isContentEditable;
      if (isEditable) return;
      if (e.key === 'ArrowLeft') setPage(p => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') {
        // 练习卡未全部作答时禁止向后翻页（经 ref 读取最新门禁，避免重注册 listener）
        const block = practiceGateRef.current();
        if (block) {
          setGateError(block);
          return;
        }
        setPage(p => Math.min(total - 1, p + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, modalOpen, resultOpen, showCelebration, gateError, resetLessonOpen, resetCardOpen]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!data || !card) return <ErrorState message="暂无课程数据" onRetry={fetchData} />;

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="h-screen flex bg-[var(--bg-page)] text-[var(--text-primary)] overflow-hidden">
        {/* 左侧阶段栏 */}
        <aside
          className="hidden md:flex flex-col shrink-0 bg-[var(--bg-page)] border-r border-[var(--bg-subtle)]"
          style={{ width: 'var(--learn-sidebar-width)' }}
        >
          <div className="p-6 mt-4 pb-2">
            <BackButton to="/student/star-map" label="返回关卡星图" state={{ subjectId }} className="mb-3" />
            <h2 className="text-sm font-medium text-[var(--sidebar-text-muted)] mb-1">今日任务</h2>
            <h1 className="text-xl font-bold tracking-tight text-[var(--sidebar-text-primary)] mb-3">
              {subjectName || '数学'} · {gradeName || '九年级上'}
            </h1>
          </div>

          <nav className="flex-1 px-4 space-y-4 overflow-y-auto mt-2">
            {(() => {
              const practiceStartIndex = data?.cards.findIndex(c => c.cardType === 'practice') ?? -1;
              const hasPractice = practiceStartIndex >= 0;
              const isPracticePhase = hasPractice && page >= practiceStartIndex;

              const hasPreviousErrors = cleanupErrors.length > 0;
              const tasks = hasPreviousErrors
                ? [
                    { id: 1, title: '错题清零', subtitle: cleanupDone ? '已完成' : `有 ${cleanupErrors.length} 道错题未清`, status: cleanupDone ? ('completed' as const) : ('current' as const) },
                    { id: 2, title: data?.lessonName ?? '当前学习', subtitle: '核心知识', status: !cleanupDone ? ('locked' as const) : isPracticePhase ? ('completed' as const) : ('current' as const) },
                    ...(hasPractice
                      ? [{ id: 3, title: '课堂练习', subtitle: '思路提示', status: (cleanupDone && isPracticePhase) ? ('current' as const) : ('locked' as const) }]
                      : []),
                  ]
                : [
                    { id: 1, title: data?.lessonName ?? '当前学习', subtitle: '核心知识', status: isPracticePhase ? ('completed' as const) : ('current' as const) },
                    ...(hasPractice
                      ? [{ id: 2, title: '课堂练习', subtitle: '思路提示', status: isPracticePhase ? ('current' as const) : ('locked' as const) }]
                      : []),
                  ];
              return tasks.map((task, index) => {
                const isLocked = task.status === 'locked';
                const isCurrent = task.status === 'current';
                const isCompleted = task.status === 'completed';
                return (
                  <div
                    key={task.id}
                    className={`relative ${!isLocked ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
                  >
                    {index !== tasks.length - 1 && (
                      <div className="absolute left-4 top-8 bottom-[-16px] w-[2px] bg-[var(--bg-subtle)]" />
                    )}
                    <div
                      className={`flex items-center gap-3 p-3 rounded-xl transition-all duration-300 ${
                        isCurrent
                          ? 'bg-[var(--learn-card-bg)] shadow-sm border border-[var(--learn-card-border)]'
                          : 'border border-transparent hover:bg-[var(--bg-subtle)]/40'
                      }`}
                    >
                      <div className="relative z-10 flex items-center justify-center bg-[var(--bg-page)]">
                        {isCompleted && <CheckCircleIcon className="w-6 h-6 text-green-600" />}
                        {isCurrent && <CircleIcon className="w-6 h-6 text-[var(--learn-btn-primary)]" />}
                        {isLocked && <LockIcon2 className="w-5 h-5 text-[var(--sidebar-text-muted)]/60" />}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${isCurrent ? 'text-[var(--learn-btn-primary)] font-semibold' : 'text-[var(--sidebar-text-primary)]'} ${isLocked ? 'text-[var(--sidebar-text-muted)]' : ''}`}>
                          {task.title}
                        </div>
                        <div className="text-xs text-[var(--sidebar-text-muted)] mt-1">
                          {task.subtitle}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </nav>

          {/* 重置本课课堂练习 - 仅在本课已有练习记录时显示；风格与下方用户信息卡一致；清零阶段隐藏 */}
          {hasLessonResults && !(cleanupErrors.length > 0 && !cleanupDone) && (
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={() => setResetLessonOpen(true)}
                className="w-full flex items-center gap-3 p-3 rounded-xl bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)] shadow-sm hover:bg-[var(--bg-subtle)]/40 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-full bg-[var(--learn-btn-primary)]/10 flex items-center justify-center shrink-0">
                  <RefreshIcon className="w-5 h-5 text-[var(--learn-btn-primary)]" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--sidebar-text-primary)]">重置课堂练习</div>
                </div>
              </button>
            </div>
          )}

          <div className="p-4">
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)] shadow-sm">
              {/* 用户区：段位入口（点击开积分面板，不再退出）+ 右侧独立退出按钮 */}
              <UserBadge
                username={username || '学生'}
                initial={username ? username[0].toUpperCase() : '学'}
                subtitle="专注学习中..."
                className="min-w-0"
              />
              <LogoutButton />
            </div>
          </div>
        </aside>

        {/* 主内容区 — header / Card / footer 三块同宽对齐（与 Card 一致的 max-width 居中） */}
        {/* relative 让卡片级讨论抽屉 absolute 贴右时锚定在主内容区，不覆盖左侧阶段栏 */}
        <main className="relative flex-1 min-w-0 flex flex-col">
          {/* Header — 顶部课本面包屑 + 进度 */}
          <header className="shrink-0 relative flex justify-center px-4 md:px-8 py-4">
            <div
              className="w-full flex items-center justify-between gap-4"
              style={{ maxWidth: 'var(--learn-card-max-w)' }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm text-[var(--text-secondary)] truncate">
                  {breadcrumb ? `${breadcrumb} · ` : ''}{data.lessonName}
                </span>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-sm font-medium text-[var(--text-tertiary)] tabular-nums">
                  {page + 1} / {total}
                </span>
              </div>
            </div>
            {/* 护眼 — 跳出 Card 对齐盒子，右上角 */}
            <button
              onClick={() => setMode(mode === 'student-day' ? 'student-night' : 'student-day')}
              className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-pill)] text-xs text-[var(--text-secondary)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-card)] transition-colors"
              title="切换护眼模式"
            >
              {mode === 'student-day' ? <SunIcon /> : <MoonIcon />}
              <span>护眼</span>
            </button>
          </header>

          {/* Card area — or CleanupPhase when previous lesson has errors */}
          <div className="flex-1 min-h-0 flex flex-col items-center px-4 md:px-8 py-2">
            {cleanupErrors.length > 0 && !cleanupDone ? (
              <CleanupPhase
                errors={cleanupErrors}
                lessonId={lessonId}
                subjectId={subjectId}
                onComplete={(allCleared: boolean) => {
                  setCleanupDone(true);
                  if (allCleared) setCleanupErrors([]);
                }}
              />
            ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2 }}
                className="relative flex-1 min-h-0 w-full flex flex-col"
                style={{ maxWidth: 'var(--learn-card-max-w)' }}
              >
                {/* 小节标题（H1） + 清空本课练习（仅 practice 卡，位于卡片上方） */}
                <div className="shrink-0 mb-3 flex items-center justify-between gap-2">
                  <h1
                    className="font-bold"
                    style={{
                      fontSize: 'var(--fs-learn-h1)',
                      lineHeight: '1.75rem',
                      color: 'var(--learn-heading-1)',
                    }}
                  >
                    {data.lessonName} 知识自学与概念理解
                  </h1>
                  {card.cardType === 'practice' && Object.keys(answers).length > 0 && (
                    <button
                      type="button"
                      title="重置本卡"
                      aria-label="重置本卡"
                      onClick={() => setResetCardOpen(true)}
                      className="shrink-0 p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                        <path d="M22 21H7" />
                        <path d="m5 11 9 9" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* 白卡 — 撑满视口 */}
                <div
                  className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden border border-[var(--learn-card-border)] shadow-sm"
                  style={{ backgroundColor: 'var(--learn-card-bg)' }}
                >
                  {/* 卡片内容 — 垂直居中，无滚动条（内容由管线保证 ≤700 字放得下） */}
                  <div className="flex-1 min-h-0 flex flex-col justify-center px-8 md:px-12 py-6">
                    <div className="mx-auto" style={{ width: '100%', maxWidth: 'var(--learn-prose-w)' }}>
                      {/* 卡片内容标题（H2）— 参考页风格：左侧色条 + 标题文字
                          标题优先用 card.title，无标题则用卡片类型（探究/例题/练习等）
                          若内容本身以 markdown 标题开头，则不再重复渲染固定标题 */}
                      {(() => {
                        const displayTitle = card.title || (CARD_TYPE_LABEL[card.cardType] ?? card.cardType);
                        const hasHeadingContent = contentStartsWithHeading(card.content);
                        return displayTitle && !hasHeadingContent ? (
                          <h2
                            className="font-black leading-snug mb-4 flex items-center gap-2"
                            style={{
                              fontSize: 'var(--fs-learn-h2)',
                              color: 'var(--learn-heading-2)',
                            }}
                          >
                            <span
                              className="w-1.5 h-4 rounded-full shrink-0"
                              style={{ backgroundColor: 'var(--learn-heading-2)' }}
                            />
                            {displayTitle}
                          </h2>
                        ) : null;
                      })()}

                      {/* Markdown body - practice 卡有结构化题目时渲染可点题块，否则走 ReactMarkdown */}
                      {(() => {
                        const questions = (practiceMeta && !practiceMeta.needsFallback)
                          ? practiceMeta.questions
                          : (fallbackPractice?.questions ?? []);
                        const groups = (practiceMeta && !practiceMeta.needsFallback)
                          ? practiceMeta.groups
                          : null;
                        const fallbackIntro = fallbackPractice?.intro;
                        const isStructured = card.cardType === 'practice' && questions.length > 0;
                        if (isStructured) {
                          // 多 group：每组渲染自己的 intro + 可点题块
                          if (groups && groups.length > 1) {
                            let flatIdx = 0;
                            return (
                              <div className="learn-prose space-y-6">
                                {groups.map((g, gi) => (
                                  <div key={gi} className="space-y-3">
                                    {g.intro && (
                                      <div className="[&>*]:font-bold [&>*]:text-[var(--learn-text-primary)]">
                                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                                          {preprocessMarkdown(g.intro)}
                                        </ReactMarkdown>
                                      </div>
                                    )}
                                    {g.questions.map((q) => {
                                      const idx = flatIdx++;
                                      const key = `${gi}-${q.n}`;
                                      const answered = answers[key];
                                      const unlocked = isQuestionUnlocked(idx, questions);
                                      return (
                                        <button
                                          key={key}
                                          onClick={unlocked ? () => handleOpenModal(idx) : undefined}
                                          disabled={!unlocked}
                                          className={`block w-full text-left p-3 rounded-lg border border-[var(--learn-card-border)] transition-colors ${unlocked ? 'hover:bg-[var(--bg-subtle)] cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                                        >
                                          <div className="flex items-start gap-2">
                                            <div className="flex-1">
                                              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                                                {preprocessMarkdown(q.text)}
                                              </ReactMarkdown>
                                            </div>
                                            {answered && (
                                              <span className={`shrink-0 font-semibold ${answered.isCorrect ? 'text-green-600' : 'text-red-600'}`}>
                                                {answered.isCorrect ? '✓' : '✗'}
                                              </span>
                                            )}
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            );
                          }
                          // 单 group 或兜底：intro + 可点题块
                          const intro = (practiceMeta && !practiceMeta.needsFallback && groups?.[0]?.intro)
                            ? groups[0].intro
                            : fallbackIntro;
                          return (
                            <div className="learn-prose space-y-3">
                              {intro && (
                                <div className="[&>*]:font-bold [&>*]:text-[var(--learn-text-primary)]">
                                  <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                                    {preprocessMarkdown(intro)}
                                  </ReactMarkdown>
                                </div>
                              )}
                              {questions.map((q, i) => {
                                const answered = answers[q.n];
                                const unlocked = isQuestionUnlocked(i, questions);
                                return (
                                  <button
                                    key={q.n}
                                    onClick={unlocked ? () => handleOpenModal(i) : undefined}
                                    disabled={!unlocked}
                                    className={`block w-full text-left p-3 rounded-lg border border-[var(--learn-card-border)] transition-colors ${unlocked ? 'hover:bg-[var(--bg-subtle)] cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
                                  >
                                    <div className="flex items-start gap-2">
                                      <div className="flex-1">
                                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                                          {preprocessMarkdown(q.text)}
                                        </ReactMarkdown>
                                      </div>
                                      {answered && (
                                        <span className={`shrink-0 font-semibold ${answered.isCorrect ? 'text-green-600' : 'text-red-600'}`}>
                                          {answered.isCorrect ? '✓' : '✗'}
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          );
                        }
                        return (
                          <div className="learn-prose">
                            <ReactMarkdown
                              remarkPlugins={markdownRemarkPlugins}
                              rehypePlugins={markdownRehypePlugins}
                              components={{
                                p: ({ children, ...props }) => {
                                  // 1. 图片 + 图注
                                  const fig = extractFigureCaption(children);
                                  if (fig) {
                                    return (
                                      <div className="figure-caption-wrap">
                                        {fig.imgEl}
                                        <span className="figure-caption-text">{fig.caption}</span>
                                      </div>
                                    );
                                  }
                                  // 2. 练习题子项 (1) (2) ...（仅在练习卡片中生效，避免误伤正文步骤编号）
                                  const text = getNodeText(children).trim();
                                  if (card.cardType === 'practice' && EXERCISE_ITEM_RE.test(text)) {
                                    return <p className="exercise-item" {...props}>{children}</p>;
                                  }
                                  // 3. 题干（以 ：或 : 结尾）
                                  if (EXERCISE_STEM_RE.test(text)) {
                                    return <p className="exercise-stem" {...props}>{children}</p>;
                                  }
                                  return <p {...props}>{children}</p>;
                                },
                                img: (props: { src?: string; alt?: string }) => (
                                  <MarkdownImg {...props} className="block mx-auto my-4 max-w-full max-h-[60vh] object-contain rounded-lg" />
                                ),
                              }}
                            >
                              {preprocessContent(card.content)}
                            </ReactMarkdown>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* 悬浮答疑按钮（柔和钢蓝，不分散学习注意力）
                      practice 卡的答疑已移入 AnswerModal（提示 / 让 AI 讲一讲），此处不再渲染。
                      非练习卡走卡片级思辨答疑：scope=整张卡片，不入错题本（讨论知识非题目）。
                      抽屉打开时隐藏入口（抽屉自带关闭按钮），避免按钮 z-10 浮在抽屉之上。 */}
                  {card.cardType !== 'practice' && !showCardDiscuss && (
                    <button
                      onClick={() => setShowCardDiscuss(true)}
                      className="absolute right-6 bottom-20 w-14 h-14 rounded-full bg-[var(--learn-btn-primary)] text-white shadow-lg flex items-center justify-center hover:bg-[var(--learn-btn-primary-hover)] transition-colors z-10"
                      title="思辨答疑"
                    >
                      <ChatIcon />
                    </button>
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
            )}
          </div>

          {/* 底部操作栏 — 上一页 / 进度点 / 下一页，与 Card 同宽居中；清零时隐藏 */}
          {!(cleanupErrors.length > 0 && !cleanupDone) && (
          <footer className="shrink-0 flex justify-center px-4 md:px-8 py-4">
            <div
              className="w-full flex items-center justify-between gap-4"
              style={{ maxWidth: 'var(--learn-card-max-w)' }}
            >
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page <= 0}
                className="flex items-center gap-1.5 h-11 px-6 rounded-[var(--radius-button)] text-[var(--text-secondary)] font-medium border border-[var(--learn-card-border)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-subtle)] transition-colors"
              >
                <ChevronLeftIcon />
                <span>上一页</span>
              </button>

              {/* 进度点 — 与 Card 同宽居中 */}
              <div className="flex items-center gap-2">
                {Array.from({ length: total }).map((_, i) => (
                  <span
                    key={i}
                    className={`rounded-full transition-colors ${
                      i === page ? 'h-2 w-6 bg-[var(--learn-btn-primary)]' : 'h-2 w-2 bg-[var(--bg-subtle)]'
                    }`}
                  />
                ))}
              </div>

              {(() => {
                const isLastPage = page === total - 1;
                const nextCard = !isLastPage ? data.cards[page + 1] : null;
                const isCurrentPractice = card?.cardType === 'practice';
                const isNextPractice = nextCard?.cardType === 'practice';

                if (isLastPage) {
                  return (
                    <button
                      onClick={finishLesson}
                      className="flex items-center gap-1.5 h-11 px-6 rounded-[var(--radius-button)] bg-emerald-700 text-white font-medium hover:bg-emerald-800 transition-colors shadow-sm"
                    >
                      <span>完成</span>
                      <ChevronRightIcon />
                    </button>
                  );
                }

                // 只在学习内容区域、即将进入 practice 时显示"课堂练习"
                if (!isCurrentPractice && isNextPractice) {
                  return (
                    <button
                      onClick={handleNext}
                      className="flex items-center gap-1.5 h-11 px-6 rounded-[var(--radius-button)] text-white font-medium shadow-sm transition-colors bg-[var(--learn-btn-primary)] hover:bg-[var(--learn-btn-primary-hover)]"
                    >
                      <span>课堂练习</span>
                      <ChevronRightIcon />
                    </button>
                  );
                }

                return (
                  <button
                    onClick={handleNext}
                    className="flex items-center gap-1.5 h-11 px-6 rounded-[var(--radius-button)] text-white font-medium shadow-sm transition-colors bg-[var(--learn-btn-primary)] hover:bg-[var(--learn-btn-primary-hover)]"
                  >
                    <span>下一页</span>
                    <ChevronRightIcon />
                  </button>
                );
              })()}
            </div>
          </footer>
          )}

          {/* 卡片级「思辨答疑」抽屉：贴右覆盖主内容区，放大封顶 w-[70%]，不盖左侧阶段栏 */}
          {showCardDiscuss && card && (
            <DiscussDrawer
              mode="card"
              cardId={card.id}
              cardTitle={card.title || CARD_TYPE_LABEL[card.cardType] || 'AI 讨论'}
              subjectId={subjectId}
              lessonId={lessonId}
              onClose={() => setShowCardDiscuss(false)}
            />
          )}
        </main>
      </div>

      {/* 庆祝覆盖层 — 课程完成 / 段位晋升（烟花为 Canvas 粒子，不再是装饰字符） */}
      <CelebrationOverlay
        open={showCelebration}
        variant={celebrationLevel ? 'levelup' : 'task'}
        title={
          celebrationLevel
            ? (celebrationLevel.name ? `晋升 ${celebrationLevel.name}！` : '晋升新段位！')
            : (isSubjectCompleted ? '恭喜你，本学科全部完成！' : '恭喜你，本节学习完成！')
        }
        subtitle={[
          // 晋升层标题只说段位，学科完成必须在这里交代，否则整科完成会被升段文案盖掉
          celebrationLevel ? '累计积分达标，段位提升' : null,
          celebrationLevel && isSubjectCompleted ? '本学科全部完成' : null,
          // 倒计时文案是通用「N 秒后自动继续」，目的地由本页 subtitle 给出。
          // 条件必须与 handleStartNewLesson 的主按钮分支**逐字对齐**：没有下一课时
          // 主按钮回星图，这里再说「即将进入下一课」就是谎报目的地。
          (isSubjectCompleted || !nextLessonId) ? '即将返回星图' : '即将进入下一课',
        ]
          .filter(Boolean)
          .join(' · ')}
        pointsAwarded={celebrationPoints}
        level={celebrationLevel ? { code: celebrationLevel.code, name: celebrationLevel.name ?? '' } : undefined}
        // 主按钮文案同理与跳转分支对齐（无下一课时它是「返回星图」，不是「开始新课」）
        primaryLabel={(isSubjectCompleted || !nextLessonId) ? '返回星图' : '开始新课'}
        onPrimary={handleStartNewLesson}
        autoCloseSeconds={10}
      />

      {/* 答题 modal */}
      {modalOpen && (() => {
        const questions = (practiceMeta && !practiceMeta.needsFallback)
          ? practiceMeta.questions
          : (fallbackPractice?.questions ?? []);
        if (questions.length === 0) return null;
        return (
          <AnswerModal
            questions={questions}
            startIndex={modalStart}
            cardId={card.id}
            lessonId={lessonId}
            subjectId={subjectId}
            hints={hints}
            onSubmit={async (questionText, studentAnswer, n) => {
              try {
                const res = await judgePractice({
                  cardId: card.id,
                  lessonId,
                  subjectId,
                  questionN: n,
                  questionText,
                  studentAnswer,
                });
                record(n, studentAnswer, res);
                return res;
              } catch {
                // 判定失败（超时/服务异常）：仍记录一条失败结果，重抛让 AnswerModal 标记该题 failed
                record(
                  n,
                  studentAnswer,
                  { questionId: null, isCorrect: false, method: 'ai', errorType: null, pointsAwarded: 0 },
                  { failed: true },
                );
                throw new Error('判定失败');
              }
            }}
            onRequestHint={async (questionText, n) => {
              const res = await getPracticeHint({
                cardId: card.id,
                lessonId,
                subjectId,
                questionText,
              });
              setHint(n, res.hint);
            }}
            onFinish={() => { setModalOpen(false); setResultOpen(true); }}
            onClose={() => setModalOpen(false)}
          />
        );
      })()}

      {/* 答题结果列表 */}
      {resultOpen && (
        <AnswerResultList
          questions={sessionQuestions}
          // 本地窄化：store 的 AnswerRecord 继承 JudgeResult（isCorrect 可空，主观题待自评为 null），
          // AnswerResultList 只吃 boolean——主观题（method 'self_assess'/'unanswered'）的展示与
          // 对错统计均按 method 分流，不依赖 isCorrect，null 收敛为 false 不影响语义。
          answers={Object.fromEntries(
            Object.entries(answers).map(([n, r]) => [n, { ...r, isCorrect: r.isCorrect === true }]),
          )}
          onClose={() => setResultOpen(false)}
        />
      )}

      {/* 练习作答门禁提示浮层（"提示"标题 + 一句提示 + 圆形 X 关闭） */}
      <ConfirmDialog
        open={gateError !== null}
        title="提示"
        message={gateError ?? ''}
        showCancel={false}
        onConfirm={() => setGateError(null)}
        onCancel={() => setGateError(null)}
      />

      {/* 重置本课课堂练习确认（左上角「提示：」+ 圆形 X / 对勾） */}
      <ConfirmDialog
        open={resetLessonOpen}
        title="提示："
        message="你确定要清除本课全部课堂练习的对错状态吗？"
        onConfirm={() => {
          setResetLessonOpen(false);
          resetPracticeLesson(lessonId).then(() => { reset(); refreshHasLessonResults(); });
        }}
        onCancel={() => setResetLessonOpen(false)}
      />

      {/* 重置本卡练习确认 */}
      <ConfirmDialog
        open={resetCardOpen}
        title="提示："
        message="你确定要清除本卡练习的对错状态吗？"
        onConfirm={() => {
          setResetCardOpen(false);
          // 卡片级橡皮擦：仅删本卡 DB 结果 + 清本卡 answers。
          // 注意用 clearAnswers() 而非 reset()——reset() 是整课级清空，
          // 会连带清掉 session 级 hints/discussDialogues 缓存，且语义上像是「清空整课」。
          resetPracticeCard(card.id).then(() => { clearAnswers(); refreshHasLessonResults(); });
        }}
        onCancel={() => setResetCardOpen(false)}
      />
    </div>
  );
}
