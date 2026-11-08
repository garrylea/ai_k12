// apps/web/src/pages/student/SolvePage.tsx
// 自由出题页（PRD §8）：录入（文字/多图）→ 选题 → 作答（+ 草稿）→ AI 答疑/判题。
// 一页一题、无历史、刷新即重置；状态机与 tab 都在本页，三个 hook 只承载 IO：
// - 识别成功由 effect 自动进选题；失败可「手动输入题目」走单候选；
// - 答疑与判题共用同一场 `aux_freeform` 会话（先 ensureDialogue 再发首问/判题），
//   保证追问落在同一上下文；
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

  const draftQuestionId = useMemo(makeDraftId, []);
  const snapshotRef = useRef<(() => Promise<string | null>) | null>(null);
  const recognize = useFreeformRecognize();
  const judge = useFreeformJudge();
  const tutor = useFreeformTutor();
  const isStreaming = useChatStore((s) => s.isStreaming);

  // 本页的对话气泡只属于本题：进页清空、离页再清空，避免带回上一题的答疑记录
  useEffect(() => {
    useChatStore.getState().reset();
    return () => useChatStore.getState().reset();
  }, []);

  // 识别成功 → 自动进选题
  useEffect(() => {
    if (stage === 'input' && recognize.result) setStage('select');
  }, [recognize.result, stage]);

  /** 判题与答疑共用一场会话：先建对话再发首问/提交，追问才落在同一上下文里 */
  const ensureDialogue = async () => {
    if (dialogueId) return dialogueId;
    if (!picked) return null;
    try {
      const id = await tutor.ensureDialogue(picked.content, picked.subjectId);
      setDialogueId(id);
      return id;
    } catch {
      toast('error', 'AI 服务暂时不可用，请稍后重试');
      return null;
    }
  };

  const askHelp = async () => {
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
    if (!picked || judge.submitting) return;
    if (!answer.trim() && !includeDraft) {
      toast('error', '请先写答案或在草稿上作答');
      return;
    }

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
  };

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
              error={recognize.error}
              onRetry={() => {
                if (source) void recognize.run(source);
              }}
              onManual={() => {
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

        {stage === 'select' && recognize.result && (
          <main className="flex-1 overflow-auto py-6 flex justify-center">
            <SolveCandidatePicker
              candidates={recognize.result.candidates}
              figures={recognize.result.figures}
              onBack={() => setStage('input')}
              onConfirm={(p) => {
                setPicked(p);
                setStage('answer');
              }}
            />
          </main>
        )}

        {/* 识别失败改手动：没有 candidates，用录入文字造一条单候选（空则让学生就地编辑题干） */}
        {stage === 'select' && !recognize.result && picked && (
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
              onBack={() => setStage('input')}
              onConfirm={(p) => {
                setPicked(p);
                setStage('answer');
              }}
            />
          </main>
        )}

        {stage === 'answer' && picked && (
          <main className="flex-1 min-h-0 flex flex-col">
            {aiOpen && (
              <div className="shrink-0 flex items-center gap-1 border-b border-[var(--bg-subtle)] mb-2">
                {(
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
              </div>
            )}

            {tab === 'answer' ? (
              <div className="flex-1 min-h-0 flex">
                <div className="flex-1 min-w-0 min-h-0">
                  <SolveAnswerView
                    questionContent={picked.content}
                    answer={answer}
                    onAnswerChange={setAnswer}
                    includeDraft={includeDraft}
                    onIncludeDraftChange={setIncludeDraft}
                    submitting={judge.submitting || answerUploading}
                    onUploadingChange={setAnswerUploading}
                    onAskHelp={() => void askHelp()}
                    onSubmit={() => void submit()}
                  />
                </div>
                {draftOpen ? (
                  <DraftPanel
                    questionId={draftQuestionId}
                    draftKeyPrefix="freeform"
                    onClose={() => setDraftOpen(false)}
                    snapshotRef={snapshotRef}
                  />
                ) : (
                  <div className="absolute top-16 right-4">
                    <DraftIconButton onClick={() => setDraftOpen(true)} />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <AuxChatPanel />
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
            )}
          </main>
        )}
      </div>
    </div>
  );
}
