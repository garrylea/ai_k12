import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import type { RunnerAnswerRecord, RunnerQuestion } from '@/components/business/answer/types';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import type { PracticeQuestion } from '@/components/business/AnswerModal';
import {
  getTrainingHint,
  judgeTraining,
  type TargetedPracticeQuestion,
} from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

/** 配置页写入的题单键（读后即删，防止刷新后重复进入旧题单）。 */
const SESSION_KEY = 'training:targeted';

type Phase = 'answering' | 'result';

/**
 * 后端 options 是字符串数组（如 "A. 1"），QuestionRunner 需要 {label, text}。
 * 提取前导字母作 label（判题/答案比对用字母），剩余作选项文本；
 * 无法解析时按序号补字母 label，保证选择题可点选。
 */
function normalizeOptions(raw: unknown[] | null | undefined): Array<{ label: string; text: string }> | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((item, i) => {
    if (typeof item === 'string') {
      const m = item.match(/^\(?([A-Za-z])[.、．)）]\s*(.*)$/);
      if (m) return { label: m[1].toUpperCase(), text: m[2] || m[1].toUpperCase() };
      return { label: String.fromCharCode(65 + i), text: item };
    }
    if (item != null && typeof item === 'object' && 'label' in item && 'text' in item) {
      const o = item as { label: unknown; text: unknown };
      if (typeof o.label === 'string' && typeof o.text === 'string') return { label: o.label, text: o.text };
    }
    return { label: String.fromCharCode(65 + i), text: String(item) };
  });
}

export default function TargetedRunPage() {
  const navigate = useNavigate();
  const { mode, autoToggleNightMode } = useThemeStore();

  const [phase, setPhase] = useState<Phase>('answering');
  const [hints, setHints] = useState<Record<string, string>>({});
  const [finalResults, setFinalResults] = useState<Record<string, RunnerAnswerRecord> | null>(null);
  // null = mount 读取中（本页无异步请求，仅同步解析 sessionStorage 后立即落值）
  const [entries, setEntries] = useState<TargetedPracticeQuestion[] | null>(null);

  // StrictMode 下 effect 会跑两次：ref 守卫保证「读 + 删」只执行一次，
  // 否则第二次读到空会误判为无题单而踢回配置页。
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    let parsed: TargetedPracticeQuestion[] = [];
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (Array.isArray(value)) parsed = value as TargetedPracticeQuestion[];
      }
    } catch {
      // 解析失败视为空题单，回配置页
    }
    // 读后即删：无论内容是否有效都清掉，避免刷新/回退后带着旧题单重复进入
    sessionStorage.removeItem(SESSION_KEY);
    setEntries(parsed);
  }, []);

  // 空题单（直接访问 / 解析失败 / 刷新后读不到）回配置页
  useEffect(() => {
    if (entries !== null && entries.length === 0) {
      navigate('/student/training/targeted', { replace: true });
    }
  }, [entries, navigate]);

  // 沉浸层夜间模式：挂一次 + 每分钟检查（镜像 Task 4/5 页面用法）
  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  // n（= String(questionId)）-> 题单条目映射
  const entryByN = useMemo(() => {
    const map = new Map<string, TargetedPracticeQuestion>();
    for (const e of entries ?? []) map.set(String(e.questionId), e);
    return map;
  }, [entries]);

  const questions: RunnerQuestion[] = useMemo(
    () =>
      (entries ?? []).map((e) => ({
        n: String(e.questionId),
        text: e.text,
        type: e.type,
        options: normalizeOptions(e.options),
      })),
    [entries],
  );

  // AnswerResultList 的题目输入（n/text 与 RunnerQuestion 一致，共用 questionId 键）
  const resultQuestions: PracticeQuestion[] = useMemo(
    () => (entries ?? []).map((e) => ({ n: String(e.questionId), text: e.text })),
    [entries],
  );

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      const entry = entryByN.get(q.n);
      if (!entry) {
        throw new Error('题单条目缺失，无法判题');
      }
      return judgeTraining({
        questionId: entry.questionId,
        subjectId: MATH_SUBJECT_ID,
        studentAnswer: answer,
        source: 'targeted',
      });
    },
    [entryByN],
  );

  const handleRequestHint = useCallback(
    async (q: RunnerQuestion) => {
      const entry = entryByN.get(q.n);
      if (!entry) {
        throw new Error('题单条目缺失，无法获取提示');
      }
      // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 hintState.error
      const res = await getTrainingHint(entry.questionId);
      setHints((prev) => ({ ...prev, [q.n]: res.hint }));
      return res.hint;
    },
    [entryByN],
  );

  const handleFinish = useCallback(async (results: Record<string, RunnerAnswerRecord>) => {
    setFinalResults(results);
    // 与错题重做的差异点：专项练习答错已由后端 judge 端点自动入错题本，
    // 收尾无需 bump，直接进结果页。
    setPhase('result');
  }, []);

  // mount 读取中 / 空题单（正在被踢回配置页）：不渲染内容
  if (entries == null || entries.length === 0) return null;

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="h-screen flex flex-col bg-[var(--bg-page)] text-[var(--text-primary)]">
        {phase === 'result' ? (
          <AnswerResultList
            questions={resultQuestions}
            answers={finalResults ?? {}}
            onClose={() => navigate('/student/training/targeted')}
          />
        ) : (
          <QuestionRunner
            questions={questions}
            subjectId={MATH_SUBJECT_ID}
            draftKeyPrefix="tp"
            variant="embedded"
            enableHint
            hints={hints}
            onRequestHint={handleRequestHint}
            onSubmit={handleSubmit}
            onFinish={handleFinish}
          />
        )}
      </div>
    </div>
  );
}
