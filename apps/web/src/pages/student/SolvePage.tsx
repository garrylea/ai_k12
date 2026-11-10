// apps/web/src/pages/student/SolvePage.tsx
// 自由出题页（PRD §8）：录入（文字/多图）→ 选题 → 作答（+ 草稿）→ AI 答疑/判题。
// 一页一题、无历史、刷新即重置；状态机与 tab 都在本页，三个 hook 只承载 IO：
// - 识别成功由 effect 自动进选题（0 道题则留在录入页给错误提示 + 手动输入）；
// - 答疑与判题共用同一场 `aux_freeform` 会话（先 ensureDialogue 再发首问/判题），
//   保证追问落在同一上下文；
// - 作答 / AI 答疑两个 tab 同时挂载、用 hidden 切换（spec §8.8）：编辑器、草稿、
//   滚动位置与白板快照出口都靠「不卸载」活下来；
// - 草稿面板的 JPEG 快照经 DraftPanel 透传的 snapshotRef 取（全页只挂一个白板）。
// - 整页复用 `AuxiliaryLayout`（不传 sidebar）：与答疑页同一张 max-w-6xl / 80vh 的卡，
//   尺寸只有那一处真源，别再在本页另写全屏布局。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { StudentAccountActions } from '@/components/business';
import { toast } from '@/components/base/Toast';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { useChatStore } from '@/store/chatStore';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { SolveSourceInput } from './solve/SolveSourceInput';
import { SolveCandidatePicker } from './solve/SolveCandidatePicker';
import { SolveAnswerView } from './solve/SolveAnswerView';
import { SolveJudgeResult } from './solve/SolveJudgeResult';
import { useFreeformRecognize } from './solve/useFreeformRecognize';
import { useFreeformJudge } from './solve/useFreeformJudge';
import { useFreeformTutor } from './solve/useFreeformTutor';
import {
  clearRedoQueue,
  extractRedoFigures,
  readRedoQueue,
  updateRedoIndex,
  type FreeformRedoItem,
  type FreeformRedoQueue,
} from './training/freeformRedoQueue';

type Stage = 'input' | 'select' | 'answer';
type Tab = 'answer' | 'ai';

interface SourceState {
  text: string;
  attachments: AttachmentRequest[];
  imageUrls: string[];
}

interface PickedQuestion {
  content: string;
  figureUrls: string[];
  subjectId: number;
  maxScore: number;
  /** 错题重练：重判同一条题（普通做题为空，走 judge.questionId） */
  questionId?: number;
}

/** 错题重练的题单条目 → 作答页的 picked（题干只读，学科/满分锁定）。 */
function redoPicked(item: FreeformRedoItem, subjectId: number): PickedQuestion {
  return {
    content: item.questionText,
    figureUrls: extractRedoFigures(item.questionText),
    subjectId,
    maxScore: item.fullScore ?? 10,
    questionId: item.questionId,
  };
}

function makeDraftId() {
  return crypto.randomUUID?.() ?? String(Date.now());
}

export default function SolvePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redoMode = searchParams.get('redo') === '1';
  // 队列只在首帧读一次：刷新恢复当前题；不合法 → bootRedo 为 null，effect 回错题本
  const bootRedo = useMemo<FreeformRedoQueue | null>(
    () => (redoMode ? readRedoQueue() : null),
    [redoMode],
  );
  const [redo, setRedo] = useState<FreeformRedoQueue | null>(bootRedo);
  const [stage, setStage] = useState<Stage>(bootRedo ? 'answer' : 'input');
  const [tab, setTab] = useState<Tab>('answer');
  // 首次答疑/提交前不出现 tab 条：学生此时只有「作答」一个视角，多一个 tab 是噪音
  const [aiOpen, setAiOpen] = useState(false);
  const [source, setSource] = useState<SourceState | null>(null);
  const [picked, setPicked] = useState<PickedQuestion | null>(() =>
    bootRedo ? redoPicked(bootRedo.items[bootRedo.index], bootRedo.subjectId) : null,
  );
  const [answer, setAnswer] = useState('');
  // 草稿默认收起：多数题用文字/公式就能答完，白板是「需要时再开」的辅助；
  // 打开后才默认附上草稿（与 closeDraft 的取消勾选互为镜像，避免开了却没送判题）。
  const [includeDraft, setIncludeDraft] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [answerUploading, setAnswerUploading] = useState(false);
  const [dialogueId, setDialogueId] = useState<string | null>(null);
  // 判题结果卡：提交后留在作答 tab 直接看结论/我的答案/正确答案，
  // 不自动跳聊天；「再答一次」把编辑器放回来。
  const [editAfterJudge, setEditAfterJudge] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState('');
  const [judgeReport, setJudgeReport] = useState('');
  // 首次提交后锁定学科/满分（重判必须与已入库的题一致）
  const [paramsLocked, setParamsLocked] = useState(!!bootRedo);

  const draftQuestionId = useMemo(makeDraftId, []);
  const snapshotRef = useRef<(() => Promise<string | null>) | null>(null);
  // 会话 id / 建会话中的 promise / 提交中：三个 ref 都是同步护栏，
  // state 要等下一次渲染才生效，挡不住连点与并发事件处理器。
  const dialogueRef = useRef<string | null>(null);
  const dialoguePromiseRef = useRef<Promise<string | null> | null>(null);
  const submittingRef = useRef(false);
  const recognize = useFreeformRecognize();
  const judge = useFreeformJudge();
  const tutor = useFreeformTutor();
  const stopJudge = judge.stop;
  const stopTutor = tutor.stop;
  const isStreaming = useChatStore((s) => s.isStreaming);
  // 只取「最后一条助手消息的错误阶段」这个标量：不订阅整个 messages，
  // 否则每个流式增量都会重渲染整页（含作答编辑器）。
  const errorStage = useChatStore((s) => {
    const last = s.messages[s.messages.length - 1];
    return last?.role === 'assistant' && last.error ? (last.error.stage ?? null) : null;
  });
  const judgeError = useChatStore((s) => {
    const last = s.messages[s.messages.length - 1];
    return last?.role === 'assistant' && last.error?.stage === 'judge' ? last.error.message : null;
  });

  // 本页的对话气泡只属于本题：进页清空、离页再清空并中断仍在跑的流
  // （否则离页后 SSE 还在写已清空的 store，甚至盖掉下一题的首条消息）
  useEffect(() => {
    useChatStore.getState().reset();
    return () => {
      stopJudge();
      stopTutor();
      useChatStore.getState().reset();
    };
  }, [stopJudge, stopTutor]);

  // 重练队列失效（手工打开 ?redo=1 / 队列被清）→ 回错题本，不停在空作答页
  useEffect(() => {
    if (!redoMode || bootRedo) return;
    toast('error', '重练题单已失效，请回错题本重新选择');
    navigate('/student/training/errors?subjectId=1', { replace: true });
  }, [redoMode, bootRedo, navigate]);

  // 判题结束才取一次完整报告：不订阅 messages 的流式增量（会让整页每个 token 重渲染）
  useEffect(() => {
    if (!judge.lastResult) return;
    const messages = useChatStore.getState().messages;
    const last = messages[messages.length - 1];
    setJudgeReport(last?.role === 'assistant' ? last.content : '');
  }, [judge.lastResult]);

  // 识别成功 → 自动进选题。0 道题不进（否则是一个空列表 + 返回按钮也救不回来）
  useEffect(() => {
    if (stage === 'input' && recognize.result && recognize.result.candidates.length > 0) {
      setStage('select');
    }
  }, [recognize.result, stage]);

  /** 返回录入：必须清掉识别结果，否则自动进选题的 effect 会立刻把学生弹回来 */
  const backToInput = () => {
    recognize.reset();
    setStage('input');
  };

  /**
   * 判题与答疑共用一场会话：先建对话再发首问/提交，追问才落在同一上下文里。
   * `dialoguePromiseRef` 让两次快速点击复用同一个请求（否则会建出两场对话）。
   */
  const ensureDialogue = (): Promise<string | null> => {
    if (dialogueRef.current) return Promise.resolve(dialogueRef.current);
    if (dialoguePromiseRef.current) return dialoguePromiseRef.current;
    if (!picked) return Promise.resolve(null);

    const pending = (async () => {
      try {
        const id = await tutor.ensureDialogue(picked.content, picked.subjectId);
        dialogueRef.current = id;
        setDialogueId(id);
        return id;
      } catch {
        toast('error', 'AI 服务暂时不可用，请稍后重试');
        return null;
      }
    })();
    dialoguePromiseRef.current = pending;
    void pending.finally(() => {
      if (dialoguePromiseRef.current === pending) dialoguePromiseRef.current = null;
    });
    return pending;
  };

  const askHelp = async () => {
    if (isStreaming || judge.submitting) return;
    // 答疑要占满整屏看对话：草稿直接收起（笔迹保留，回来点图标就在），
    // 否则 AI tab 被草稿栏挤掉一大块宽度。
    closeDraft();
    setAiOpen(true);
    setTab('ai');

    const id = await ensureDialogue();
    if (!id) return;
    // 已判过题：会话里已有完整判题报告，答疑直接从「还有哪里不懂」接着讲，
    // 不再把学生答案原样重发一遍（那只会让模型再判一次）。
    // 未判题：学生写什么就发什么（讲解纪律由提示词负责）。
    // 年级/教材/已学内容由服务端从学生档案与学习配置里取，前端不再上报。
    const message = judge.lastResult
      ? '这道题我还是没太懂，请按你的讲解结构再讲一遍。'
      : answer.trim() || '这题怎么做？';
    await tutor.send(id, message, undefined, undefined, {
      subjectId: picked?.subjectId ?? 1,
    });
  };

  const submit = async () => {
    // submittingRef 覆盖整条异步链（快照 → 上传 → 建会话 → 判题）：
    // 只靠 judge.submitting 的话，上传草稿期间连点会起第二条判题流。
    if (!picked || submittingRef.current || judge.submitting || isStreaming) return;
    if (!answer.trim() && !includeDraft) {
      toast('error', '请先写答案或在草稿上作答');
      return;
    }
    // 文字路径的满分在作答区顶部手填，可能被清空成 NaN
    if (!Number.isInteger(picked.maxScore) || picked.maxScore < 1 || picked.maxScore > 100) {
      toast('error', '满分需为 1–100 的整数');
      return;
    }

    submittingRef.current = true;
    try {
      let draftFileId: string | undefined;
      if (includeDraft) {
        const url = await snapshotRef.current?.();
        if (url) {
          try {
            const blob = await (await fetch(url)).blob();
            const up = await uploadFile(
              new File([blob], 'draft.jpg', { type: 'image/jpeg' }),
              undefined,
              'freeform',
            );
            draftFileId = String(up.fileId);
          } catch {
            toast('error', '草稿上传失败，请重试');
            return;
          }
        } else if (!answer.trim()) {
          toast('error', '草稿为空，请先作答');
          return;
        }
      }

      const id = await ensureDialogue();
      if (!id) return;
      // 结果卡要整宽看：草稿同样收起（笔迹保留，再答一次时可从右上角图标重开）
      closeDraft();
      // 判题不跳聊天：结果卡就在作答 tab 里展示，聊天只留给【答疑】。
      setSubmittedAnswer(answer);
      setJudgeReport('');
      setEditAfterJudge(false);
      setParamsLocked(true);
      await judge.submit(
        {
          dialogueId: id,
          subjectId: picked.subjectId,
          maxScore: picked.maxScore,
          // 重交同一题：重练用队列里的 questionId，普通做题用上次判题结果
          questionId: picked.questionId ?? judge.questionId ?? undefined,
          questionContent: picked.content,
          // 判题只吃「识别后 + 勾选配图」的题干，不再附原题照片（原图只用于识题）。
          figureUrls: picked.figureUrls,
          answer,
          draftFileId,
        },
        // 气泡只显示学生自己的作答；原题照片不进判题上下文，也不在气泡里冒充输入。
        { answerMarkdown: answer },
      );
    } finally {
      submittingRef.current = false;
    }
  };

  /** 收起草稿面板 = 没有草稿可附：勾选态同步取消，避免提交时误报「草稿为空」 */
  const closeDraft = () => {
    snapshotRef.current = null;
    setDraftOpen(false);
    setIncludeDraft(false);
  };

  const openDraft = () => {
    setDraftOpen(true);
    setIncludeDraft(true);
  };

  /** 退出重练：清队列回错题本（未提交的作答丢弃，与普通做题离开一致） */
  const exitRedo = () => {
    clearRedoQueue();
    navigate(`/student/training/errors?subjectId=${redo?.subjectId ?? picked?.subjectId ?? 1}`, {
      replace: true,
    });
  };

  /** 换到重练队列里的下一题：判题状态、会话、草稿、输入全部复位 */
  const applyRedoItem = (item: FreeformRedoItem, subjectId: number) => {
    judge.reset();
    dialogueRef.current = null;
    dialoguePromiseRef.current = null;
    setDialogueId(null);
    setPicked(redoPicked(item, subjectId));
    setStage('answer');
    setAnswer('');
    setSubmittedAnswer('');
    setJudgeReport('');
    setEditAfterJudge(false);
    setIncludeDraft(false);
    setDraftOpen(false);
    setTab('answer');
    setAiOpen(false);
    setParamsLocked(true);
    submittingRef.current = false;
  };

  const hasNextRedo = !!redo && redo.index < redo.items.length - 1;
  const goNextRedo = () => {
    if (!redo) return;
    if (!hasNextRedo) {
      exitRedo();
      return;
    }
    const nextIndex = redo.index + 1;
    updateRedoIndex(nextIndex);
    setRedo({ ...redo, index: nextIndex });
    applyRedoItem(redo.items[nextIndex], redo.subjectId);
  };

  const noCandidate = !!recognize.result && recognize.result.candidates.length === 0;
  // 有候选才走「识别结果选题」，否则一律用录入文字造的单候选（与自动进选题的 effect 同口径）
  const hasCandidates = (recognize.result?.candidates.length ?? 0) > 0;
  // 判题中 / 有结果 / 判题失败 → 显示结果卡；「再答一次」放回编辑器
  const showResult =
    !editAfterJudge &&
    (judge.submitting ||
      judge.stopped ||
      judge.lastResult !== null ||
      (errorStage === 'judge' && judgeError != null));
  const inputError =
    recognize.error ??
    (noCandidate ? '没有识别到题目，请换一张更清晰的图片，或手动输入题目' : null);

  return (
    // 草稿是「桌上另一张纸」：走 sidePanel 槽挂在作答大卡**外面**（页面右下同一行），
    // 展开时大卡整体向左让位；收起时右上角只留入口图标（pageAction）。
    <AuxiliaryLayout
      sidePanel={
        stage === 'answer' && draftOpen ? (
          <DraftPanel
            questionId={draftQuestionId}
            draftKeyPrefix="freeform"
            defaultWidthPct={45}
            onClose={closeDraft}
            snapshotRef={snapshotRef}
          />
        ) : undefined
      }
      pageAction={
        // AI 答疑页不提供草稿入口：那一屏要整宽看对话（答疑前已自动收起草稿）
        stage === 'answer' && tab === 'answer' && !draftOpen ? (
          <DraftIconButton onClick={openDraft} />
        ) : undefined
      }
    >
      <div className="relative flex flex-1 min-h-0 flex-col p-4 sm:p-5 text-[var(--text-primary)]">
        <PageHeader
          to={redoMode ? undefined : '/student/entry'}
          onBack={redoMode ? exitRedo : undefined}
          backAriaLabel={redoMode ? '返回错题本' : undefined}
          caption={redoMode ? '返回错题本' : '返回入口'}
          title={redoMode ? '错题重练' : '做题'}
          actions={
            <div className="flex items-center gap-3">
              {redoMode && redo && (
                <span className="text-sm text-[var(--text-tertiary)]">
                  第 {redo.index + 1}/{redo.items.length} 题
                </span>
              )}
              <StudentAccountActions />
            </div>
          }
        />

        {stage === 'input' && (
          <main className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 pb-10">
            {/* 与答疑首屏同一套标题层级/字号/间距：h2 + 一行副文案 + max-w-2xl 输入框 */}
            <h2 className="text-2xl sm:text-3xl font-bold text-[#1D1D1F] mb-2">
              把题目发给我
            </h2>
            <p className="text-sm text-[#86868B] mb-8">输入题目文字直接作答；只放图片则自动识别</p>
            <div className="w-full max-w-2xl">
              <SolveSourceInput
                busy={recognize.busy}
                error={inputError}
                onRetry={() => {
                  if (source) void recognize.run(source);
                }}
                onManual={() => {
                  // 与 backToInput 同理：识别结果（哪怕是 candidates: []）不清掉，
                  // 选题分支就会按「识别到 0 道题」渲染空列表，学生手动输入的题干直接丢失。
                  recognize.reset();
                  setPicked({
                    content: source?.text ?? '',
                    figureUrls: [],
                    subjectId: 1,
                    maxScore: 10,
                  });
                  setStage('select');
                }}
                onRecognize={(input) => {
                  setSource(input);
                  // 文字题（可带配图）不走识题：文字就是题干，图片按配图顺序拼到题干末尾；
                  // 只有纯图片才交给 MinerU + 切题。
                  if (input.text.trim()) {
                    const figureLines = input.imageUrls.map(
                      (url, i) => `![配图${i + 1}](${url})`,
                    );
                    const content = [input.text.trim(), ...figureLines].join('\n\n');
                    setPicked({
                      content,
                      figureUrls: input.imageUrls,
                      subjectId: 1,
                      maxScore: 10,
                    });
                    setStage('answer');
                    return;
                  }
                  void recognize.run(input);
                }}
              />
            </div>
          </main>
        )}

        {stage === 'select' && recognize.result && hasCandidates && (
          <main className="flex-1 min-h-0 overflow-auto py-6 flex justify-center">
            <SolveCandidatePicker
              candidates={recognize.result.candidates}
              figures={recognize.result.figures}
              onBack={backToInput}
              onConfirm={(p) => {
                setPicked(p);
                setStage('answer');
              }}
            />
          </main>
        )}

        {/* 识别失败改手动：没有 candidates，用录入文字造一条单候选（空则让学生就地编辑题干） */}
        {stage === 'select' && !hasCandidates && picked && (
          <main className="flex-1 min-h-0 overflow-auto py-6 flex justify-center">
            <SolveCandidatePicker
              candidates={[
                {
                  id: 'c1',
                  no: '1',
                  content: picked.content,
                  figureUrls: [],
                  suggestedSubject: null,
                  confidence: 1,
                },
              ]}
              figures={[]}
              onBack={backToInput}
              onConfirm={(p) => {
                setPicked(p);
                setStage('answer');
              }}
            />
          </main>
        )}

        {stage === 'answer' && picked && (
          <main className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-1 border-b border-[var(--bg-subtle)] mb-2">
              {aiOpen &&
                (
                  [
                    ['answer', '作答'],
                    ['ai', 'AI 答疑'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={`px-3 h-9 text-sm rounded-lg ${
                      tab === key
                        ? 'bg-[var(--brand-100)] text-[var(--brand-500)] font-medium'
                        : 'text-[var(--text-tertiary)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              {/* 文字题不走选题页，学科/满分在这里给；识别题也显示，方便核对 */}
              <div className="ml-auto flex items-center gap-2 pb-1 text-xs text-[var(--text-secondary)]">
                <select
                  aria-label="学科"
                  value={picked.subjectId}
                  disabled={paramsLocked || judge.submitting}
                  onChange={(e) =>
                    setPicked((p) => (p ? { ...p, subjectId: Number(e.target.value) } : p))
                  }
                  className="h-7 rounded-md border border-[var(--bg-subtle)] bg-transparent px-1 disabled:opacity-60"
                >
                  <option value={1}>数学</option>
                  <option value={4}>物理</option>
                  <option value={5}>化学</option>
                </select>
                <label className="flex items-center gap-1">
                  满分
                  <input
                    aria-label="满分"
                    type="number"
                    min={1}
                    max={100}
                    value={picked.maxScore}
                    disabled={paramsLocked || judge.submitting}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setPicked((p) => (p ? { ...p, maxScore: n } : p));
                    }}
                    className="w-14 h-7 rounded-md border border-[var(--bg-subtle)] bg-transparent px-1 disabled:opacity-60"
                  />
                  分
                </label>
              </div>
            </div>

            {/* 两个 tab 同时挂载、只切 hidden：卸载会丢编辑器内容与滚动位置；
                草稿面板已移到页面级右栏（AuxiliaryLayout sidePanel），不随 tab 卸载 */}
            <div className={tab === 'answer' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              <div className="flex-1 min-h-0 flex">
                <div className="flex-1 min-w-0 min-h-0">
                  {showResult ? (
                    <SolveJudgeResult
                      result={judge.lastResult}
                      submitting={judge.submitting}
                      stopped={judge.stopped}
                      onStop={judge.stop}
                      myAnswer={submittedAnswer}
                      report={judgeReport}
                      error={judgeError}
                      onRetry={() => void judge.retry()}
                      onAskHelp={() => void askHelp()}
                      onEditAgain={() => setEditAfterJudge(true)}
                      nextLabel={
                        redo ? (hasNextRedo ? '下一题' : '返回错题本') : undefined
                      }
                      onNext={redo ? goNextRedo : undefined}
                    />
                  ) : (
                    <SolveAnswerView
                      questionContent={picked.content}
                      answer={answer}
                      onAnswerChange={setAnswer}
                      includeDraft={includeDraft}
                      onIncludeDraftChange={setIncludeDraft}
                      draftAvailable={draftOpen}
                      submitting={judge.submitting || answerUploading}
                      streaming={isStreaming}
                      onUploadingChange={setAnswerUploading}
                      onAskHelp={() => void askHelp()}
                      onSubmit={() => void submit()}
                    />
                  )}
                </div>
              </div>
            </div>

            <div className={tab === 'ai' ? 'flex-1 min-h-0 overflow-hidden flex flex-col' : 'hidden'}>
              <AuxChatPanel
                onRetry={errorStage === 'judge' ? () => void judge.retry() : undefined}
              />
              <div className="shrink-0 p-3 bg-white border-t border-[#E5E5E5]">
                <AuxInputBar
                  isStreaming={isStreaming}
                  onSend={(text, atts, imgs) => {
                    if (!dialogueId) return;
                    void tutor.send(dialogueId, text, atts, imgs, {
                      subjectId: picked.subjectId,
                    });
                  }}
                  onStop={tutor.stop}
                />
              </div>
            </div>
          </main>
        )}
      </div>
    </AuxiliaryLayout>
  );
}
