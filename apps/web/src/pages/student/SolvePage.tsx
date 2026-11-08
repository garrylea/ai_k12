// apps/web/src/pages/student/SolvePage.tsx
// 自由出题页（PRD §8）：录入（文字/多图）→ 选题 → 作答（+ 草稿）→ AI 答疑/判题。
// 一页一题、无历史、刷新即重置；状态机与 tab 都在本页，三个 hook 只承载 IO：
// - 识别成功由 effect 自动进选题（0 道题则留在录入页给错误提示 + 手动输入）；
// - 答疑与判题共用同一场 `aux_freeform` 会话（先 ensureDialogue 再发首问/判题），
//   保证追问落在同一上下文；
// - 作答 / AI 答疑两个 tab 同时挂载、用 hidden 切换（spec §8.8）：编辑器、草稿、
//   滚动位置与白板快照出口都靠「不卸载」活下来；
// - 草稿面板的 JPEG 快照经 DraftPanel 透传的 snapshotRef 取（全页只挂一个白板）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackButton } from '@/components/base';
import { UserBadge } from '@/components/business';
import { toast } from '@/components/base/Toast';
import { getAuthItem } from '@/services/authStorage';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { useChatStore } from '@/store/chatStore';
import AuxChatPanel from '@/components/business/AuxChatPanel';
import AuxInputBar from '@/components/business/AuxInputBar';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { SolveSourceInput } from './solve/SolveSourceInput';
import { SolveCandidatePicker } from './solve/SolveCandidatePicker';
import { SolveAnswerView } from './solve/SolveAnswerView';
import { useFreeformRecognize } from './solve/useFreeformRecognize';
import { useFreeformJudge } from './solve/useFreeformJudge';
import { useFreeformTutor } from './solve/useFreeformTutor';

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
}

function makeDraftId() {
  return crypto.randomUUID?.() ?? String(Date.now());
}

export default function SolvePage() {
  const [stage, setStage] = useState<Stage>('input');
  const [tab, setTab] = useState<Tab>('answer');
  // 首次答疑/提交前不出现 tab 条：学生此时只有「作答」一个视角，多一个 tab 是噪音
  const [aiOpen, setAiOpen] = useState(false);
  const [source, setSource] = useState<SourceState | null>(null);
  const [picked, setPicked] = useState<PickedQuestion | null>(null);
  const [answer, setAnswer] = useState('');
  const [includeDraft, setIncludeDraft] = useState(true);
  const [draftOpen, setDraftOpen] = useState(true);
  const [answerUploading, setAnswerUploading] = useState(false);
  const [dialogueId, setDialogueId] = useState<string | null>(null);
  const [stemEditing, setStemEditing] = useState(false);
  const [stemDraft, setStemDraft] = useState('');

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
    const id = await ensureDialogue();
    if (!id) return;
    setAiOpen(true);
    setTab('ai');
    await tutor.send(
      id,
      answer.trim()
        ? `我这题不太会，我的尝试是：\n${answer}\n请引导我思考，不要直接给答案。`
        : '这题怎么做？请引导我思考，不要直接给答案。',
      source?.attachments ?? [],
      [],
    );
  };

  const submit = async () => {
    // submittingRef 覆盖整条异步链（快照 → 上传 → 建会话 → 判题）：
    // 只靠 judge.submitting 的话，上传草稿期间连点会起第二条判题流。
    if (!picked || submittingRef.current || judge.submitting || isStreaming) return;
    if (!answer.trim() && !includeDraft) {
      toast('error', '请先写答案或在草稿上作答');
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
      setAiOpen(true);
      setTab('ai');
      await judge.submit(
        {
          dialogueId: id,
          subjectId: picked.subjectId,
          maxScore: picked.maxScore,
          // 重交同一题：后端据此更新原题而非再建一条
          questionId: judge.questionId ?? undefined,
          questionContent: picked.content,
          questionImages: source?.attachments ?? [],
          figureUrls: picked.figureUrls,
          answer,
          draftFileId,
        },
        { images: source?.imageUrls ?? [], answerMarkdown: answer },
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

  const startStemEdit = () => {
    if (!picked) return;
    setTab('answer');
    setStemDraft(picked.content);
    setStemEditing(true);
  };

  const saveStem = () => {
    const next = stemDraft.trim();
    if (!next) return;
    setPicked((prev) => (prev ? { ...prev, content: next } : prev));
    setStemEditing(false);
  };

  const noCandidate = !!recognize.result && recognize.result.candidates.length === 0;
  // 有候选才走「识别结果选题」，否则一律用录入文字造的单候选（与自动进选题的 effect 同口径）
  const hasCandidates = (recognize.result?.candidates.length ?? 0) > 0;
  const inputError =
    recognize.error ??
    (noCandidate ? '没有识别到题目，请换一张更清晰的图片，或手动输入题目' : null);

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--bg-subtle)] pb-3">
          <div className="flex items-center gap-3">
            <BackButton to="/student/entry" label="返回入口" />
            <h1 className="text-lg font-bold">做题</h1>
          </div>
          <UserBadge username={getAuthItem('username') ?? '同学'} />
        </header>

        {stage === 'input' && (
          <main className="flex-1 flex flex-col items-center justify-center px-6">
            <h2 className="text-2xl font-bold mb-2">把题目发给我</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-6">
              可输入文字，或拖入/粘贴题目图片（HEIC、JPG、PNG）
            </p>
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
                void recognize.run(input);
              }}
            />
          </main>
        )}

        {stage === 'select' && recognize.result && hasCandidates && (
          <main className="flex-1 overflow-auto py-6 flex justify-center">
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
          <main className="flex-1 overflow-auto py-6 flex justify-center">
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
              {/* 学科/满分锁定，但识别错字/公式要允许学生修正（spec 决策 9） */}
              <button
                type="button"
                onClick={startStemEdit}
                className="ml-auto h-9 px-3 rounded-lg border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-base)]"
              >
                编辑题干
              </button>
            </div>

            {/* 两个 tab 同时挂载、只切 hidden：卸载会丢编辑器内容、草稿笔迹与滚动位置 */}
            <div className={tab === 'answer' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              {stemEditing && (
                <div className="shrink-0 mb-2 rounded-lg border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] p-3">
                  <textarea
                    aria-label="编辑题干内容"
                    value={stemDraft}
                    onChange={(e) => setStemDraft(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-[var(--bg-subtle)] p-2 text-sm font-mono bg-[var(--bg-base)] text-[var(--text-primary)]"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setStemEditing(false)}
                      className="h-9 px-3 rounded-lg border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)]"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={saveStem}
                      disabled={!stemDraft.trim()}
                      className="h-9 px-4 rounded-lg bg-[var(--brand-500)] text-white text-sm disabled:opacity-50"
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 flex">
                <div className="flex-1 min-w-0 min-h-0">
                  <SolveAnswerView
                    questionContent={picked.content}
                    answer={answer}
                    onAnswerChange={setAnswer}
                    includeDraft={includeDraft}
                    onIncludeDraftChange={setIncludeDraft}
                    submitting={judge.submitting || answerUploading}
                    streaming={isStreaming}
                    onUploadingChange={setAnswerUploading}
                    onAskHelp={() => void askHelp()}
                    onSubmit={() => void submit()}
                  />
                </div>
                {draftOpen ? (
                  <DraftPanel
                    questionId={draftQuestionId}
                    draftKeyPrefix="freeform"
                    onClose={closeDraft}
                    snapshotRef={snapshotRef}
                  />
                ) : (
                  <div className="absolute top-16 right-4">
                    <DraftIconButton onClick={() => setDraftOpen(true)} />
                  </div>
                )}
              </div>
            </div>

            <div className={tab === 'ai' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              <AuxChatPanel
                onRetry={errorStage === 'judge' ? () => void judge.retry() : undefined}
              />
              <div className="shrink-0 p-3 bg-white border-t border-[#E5E5E5]">
                <AuxInputBar
                  isStreaming={isStreaming}
                  onSend={(text, atts, imgs) => {
                    if (dialogueId) void tutor.send(dialogueId, text, atts, imgs);
                  }}
                  onStop={tutor.stop}
                />
              </div>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
