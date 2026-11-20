import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMarkdown,
} from '@/components/markdown';
import { ConfirmDialog } from '@/components/base/ConfirmDialog';
import { toast } from '@/components/base/Toast';
import { ensureJpeg } from '@/utils/image-convert';
import { compressImageFile, MAX_IMAGE_BYTES } from '@/utils/image-compress';
import {
  deleteResearchImages,
  updateResearchQuestion,
  uploadResearchImage,
  type ResearchQuestionDetail,
} from '@/services/api';

/** 抽屉宽度会话记忆：模块级，本会话内跨开关 / 跨试卷保持，刷新归 null。 */
let lastWidthPx: number | null = null;
/** 宽度上限：视口 92%（与原 class 的 92vw 一致）；下限保书写空间，窄屏时等于上限=禁调。 */
const WIDTH_MAX_PX = () => window.innerWidth * 0.92;
const WIDTH_MIN_PX = () => Math.min(360, WIDTH_MAX_PX());

export interface ResearchQuestionEditDrawerProps {
  question: ResearchQuestionDetail; // 五字段原值，勿剥离
  onClose: () => void;
  onSaved: () => void;
}

type FieldKey = 'content' | 'options' | 'answer' | 'explanation' | 'approach';
const FIELD_KEYS: readonly FieldKey[] = ['content', 'options', 'answer', 'explanation', 'approach'];
type Drafts = Record<FieldKey, string>;

/**
 * 状态机：closed/loading 在父组件（详情页加载数据后才挂载本抽屉），本组件从 editing 起步。
 * editing →(传图) uploading →(全部完成) editing
 * editing →(保存) validating →(校验过) saving →(成功) saved / (失败) error
 * editing →(取消且 dirty/有会话图) closing →(确认) 清理并 closed
 */
type Status = 'editing' | 'uploading' | 'validating' | 'saving' | 'saved' | 'error' | 'closing';

const FIELD_LABEL: Record<FieldKey, string> = {
  content: '题干',
  options: '选项',
  answer: '标准答案',
  explanation: '解析',
  approach: '思路',
};
/** 既是 Markdown 预览域，也是唯一允许贴图的域：选项（JSON 文本域）不在其中，
 *  给它上传按钮会把 `![图N](url)` 写进 JSON，直接把题目变成不可保存状态。 */
const MARKDOWN_FIELDS: ReadonlySet<FieldKey> = new Set<FieldKey>([
  'content', 'answer', 'explanation', 'approach',
]);

const NOTICE = '本次修正仅影响之后的判题，不会修改已有作答记录、错题本、积分与掌握度。';
const failedToken = (n: number) => `［图${n} 上传失败］`;
/** 失败标记由本组件生成，预览里补一层标红 span；rehype-raw 会把内联 HTML 渲染成真实元素。 */
const FAILED_TOKEN_RE = /［图\d+ 上传失败］/g;

function initialDrafts(q: ResearchQuestionDetail): Drafts {
  return {
    content: q.content,
    // 无选项题（填空/简答/证明）后端 parse 出 null：留空而不是写出 "null" 字面量。
    options: q.options === null ? '' : JSON.stringify(q.options, null, 2),
    answer: q.answer,
    explanation: q.explanation ?? '',
    approach: q.approach ?? '',
  };
}

/** 选项卡片仅在这三种题型 + 合法非空 options 时渲染；与判题侧选择题类型一致。 */
const CHOICE_TYPES: ReadonlySet<string> = new Set(['choice', 'multi_choice', 'true_false']);

interface ChoiceOption {
  label: string;
  text: string;
}

/** 从实时选项 JSON 派生卡片数据；JSON 正在编辑或不合法时返回 null，不报错。 */
function parseChoiceOptions(type: string, optionsJson: string): ChoiceOption[] | null {
  if (!CHOICE_TYPES.has(type)) return null;
  if (!optionsJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(optionsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (
      !parsed.every(
        (o) => o !== null && typeof o === 'object' &&
          typeof (o as { label?: unknown }).label === 'string' &&
          typeof (o as { text?: unknown }).text === 'string',
      )
    ) return null;
    return parsed as ChoiceOption[];
  } catch {
    return null;
  }
}

/** 点选写 answer：单选/判断再点同一项取消；多选按 options 出现顺序拼接。 */
function toggleAnswer(
  current: string,
  label: string,
  multi: boolean,
  options: ChoiceOption[],
): string {
  if (!multi) return current === label ? '' : label;
  const picked = new Set(current.split(''));
  if (picked.has(label)) picked.delete(label);
  else picked.add(label);
  return options.map((o) => o.label).filter((l) => picked.has(l)).join('');
}

/** 统一 markdown 渲染：/uploads/ 由 markdown.tsx 的 resolveAsset 特判透传。
 *  上传失败占位（spec §6.1「标红失败图」）在预览中染成错误色。 */
function MarkdownBlock({ text }: { text: string }) {
  const decorated = text.replace(
    FAILED_TOKEN_RE,
    (marker) => `<span class="research-upload-failure" style="color:var(--error)">${marker}</span>`,
  );
  return (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {preprocessMarkdown(decorated)}
    </ReactMarkdown>
  );
}

interface ChoiceOptionCardsProps {
  options: ChoiceOption[];
  answer: string;
  multi: boolean;
  disabled: boolean;
  onSelect: (answer: string) => void;
}

/** 选项卡片：点选即写标准答案（label 字符串），只改 answer，不动 options。 */
function ChoiceOptionCards({ options, answer, multi, disabled, onSelect }: ChoiceOptionCardsProps) {
  return (
    <div data-testid="choice-options" className="mt-2 flex flex-col gap-2">
      {options.map((opt) => {
        const selected = multi ? answer.split('').includes(opt.label) : answer === opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={`将${opt.label}设为正确答案`}
            onClick={() => onSelect(toggleAnswer(answer, opt.label, multi, options))}
            className={`w-full flex items-start gap-2 rounded-lg border p-2 text-left text-sm transition-colors ${selected ? 'border-[var(--brand-500)] bg-orange-50' : 'border-gray-200 hover:bg-gray-50'}`}
          >
            <span className="shrink-0 font-semibold" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
            <span className="min-w-0"><MarkdownBlock text={opt.text} /></span>
          </button>
        );
      })}
    </div>
  );
}

interface EditFieldProps {
  fieldKey: FieldKey;
  value: string;
  markdown: boolean;
  busy: boolean;
  onChange: (v: string) => void;
  onFiles: (files: File[]) => void;
}

/** 每个字段一个实例：上传控件、token 桶、draft 写入都由 fieldKey 路由，互不串字段。 */
function EditField({ fieldKey, value, markdown, busy, onChange, onFiles }: EditFieldProps) {
  const label = FIELD_LABEL[fieldKey];
  const id = `research-field-${fieldKey}`;
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div data-field={fieldKey} className="mt-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </label>
        {markdown && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-label={`上传图片到${label}`}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = ''; // 同一文件可重复选
                if (files.length > 0) onFiles(files);
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="px-2.5 py-1 rounded-lg border border-gray-200 text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              上传图片
            </button>
          </>
        )}
      </div>
      <textarea
        id={id}
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          if (!markdown) return; // JSON 域不接图，保持原生文本粘贴
          const files: File[] = [];
          // 事件对象在 await 后失效：同步读完 clipboardData 再交给上传流程
          for (const item of Array.from(e.clipboardData?.items ?? [])) {
            if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
            const file = item.getAsFile();
            if (file) files.push(file);
          }
          if (files.length === 0) return; // 纯文本走浏览器原生粘贴
          e.preventDefault();
          onFiles(files);
        }}
        onDrop={(e) => {
          if (!markdown) {
            // 选项 JSON 域：拦下文件拖拽避免浏览器导航，但绝不写进草稿
            if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
            return;
          }
          const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) {
            if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
            return;
          }
          e.preventDefault();
          onFiles(files);
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
        }}
        placeholder={fieldKey === 'options' ? '按 [{"label":"A","text":"选项内容"}] 格式填写；无选项题留空' : `编辑${label}`}
        className="w-full min-h-[5rem] p-2 rounded-lg border border-gray-200 bg-transparent text-sm resize-y outline-none"
        style={{ color: 'var(--text-primary)' }}
      />
      {markdown && (
        <div data-testid={`preview-${fieldKey}`} className="mt-1 rounded-lg border border-gray-100 p-2 text-sm">
          <MarkdownBlock text={value} />
        </div>
      )}
    </div>
  );
}

export default function ResearchQuestionEditDrawer({
  question,
  onClose,
  onSaved,
}: ResearchQuestionEditDrawerProps) {
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(question));
  // 与 LatexEditor 的 valueRef 同口径：异步上传 await 期间也能拿到最新文本，
  // 避免旧快照覆盖老师在占位之后继续敲的内容。
  const draftsRef = useRef(drafts);
  const initialRef = useRef<Drafts>(initialDrafts(question));
  const questionIdRef = useRef(question.id);
  const [status, setStatus] = useState<Status>('editing');
  const [confirmedSource, setConfirmedSource] = useState(false);
  const [note, setNote] = useState('');
  const [uploadCount, setUploadCount] = useState(0);

  /** 选项卡片数据：从实时 JSON 派生，改 JSON 即时更新；非选择题/非法 JSON → null。 */
  const choiceOptions = parseChoiceOptions(question.type, drafts.options);

  const [widthPx, setWidthPx] = useState<number | null>(() =>
    lastWidthPx === null ? null : Math.min(WIDTH_MAX_PX(), Math.max(WIDTH_MIN_PX(), lastWidthPx)),
  );
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const widthPxRef = useRef(widthPx);
  const resizeStartRef = useRef<{ startX: number; startPx: number } | null>(null);

  const applyWidth = useCallback((px: number) => {
    const clamped = Math.min(WIDTH_MAX_PX(), Math.max(WIDTH_MIN_PX(), px));
    widthPxRef.current = clamped;
    setWidthPx(clamped);
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startPx =
      drawerRef.current?.getBoundingClientRect().width ||
      widthPxRef.current ||
      Math.min(512, WIDTH_MAX_PX());
    resizeStartRef.current = { startX: e.clientX, startPx };
    setDragging(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    // 向左拖 clientX 变小 → 变宽；向右拖变窄（右侧抽屉的直觉方向）
    applyWidth(start.startPx + (start.startX - e.clientX));
  };

  const endResize = () => {
    if (!resizeStartRef.current) return; // pointerup / lostpointercapture 各触发一次，幂等收尾
    resizeStartRef.current = null;
    setDragging(false);
    lastWidthPx = widthPxRef.current; // 落定即写会话记忆
  };

  const tokensRef = useRef<Map<FieldKey, Set<string>>>(
    new Map(FIELD_KEYS.map((key) => [key, new Set<string>()])),
  );
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const sessionUrlsRef = useRef<Set<string>>(new Set());
  const seqRef = useRef(0);

  const setField = useCallback((key: FieldKey, value: string) => {
    draftsRef.current = { ...draftsRef.current, [key]: value };
    setDrafts(draftsRef.current);
  }, []);

  /** 精确替换「指定字段」的占位串；找不到（老师已删掉占位）就丢弃结果，绝不追加。 */
  const replaceToken = useCallback((key: FieldKey, token: string, replacement: string) => {
    const cur = draftsRef.current[key];
    const idx = cur.indexOf(token);
    if (idx < 0) return;
    setField(key, cur.slice(0, idx) + replacement + cur.slice(idx + token.length));
  }, [setField]);

  /** 切题/关闭时按「发起时归属」失效在途上传：abort + 清占位。
   *  绝不在 setState 的函数式 updater 里写 ref（updater 可能被 React 延后到渲染阶段执行，
   *  会覆盖调用方随后同步写入的 ref，造成切题后旧题草稿复活）。 */
  const abortAllUploads = useCallback(() => {
    const tokensByField = Array.from(tokensRef.current.entries());
    for (const ctrl of abortRef.current.values()) ctrl.abort();
    abortRef.current.clear();
    const cleaned = { ...draftsRef.current };
    let changed = false;
    for (const [key, tokens] of tokensByField) {
      if (tokens.size === 0) continue;
      let text = cleaned[key];
      for (const token of tokens) text = text.split(token).join('');
      if (text !== cleaned[key]) {
        cleaned[key] = text;
        changed = true;
      }
    }
    if (changed) {
      draftsRef.current = cleaned;
      setDrafts(cleaned); // 值式提交：ref 与 state 同一次写入，顺序确定
    }
    for (const tokens of tokensRef.current.values()) tokens.clear();
  }, []);

  // 父组件可能在抽屉开着时换成另一题：重置全部草稿并让旧上传按归属失效。
  useEffect(() => {
    if (question.id === questionIdRef.current) return;
    questionIdRef.current = question.id;
    abortAllUploads();
    const fresh = initialDrafts(question);
    initialRef.current = fresh;
    draftsRef.current = fresh;
    setDrafts(fresh);
    setConfirmedSource(false);
    setNote('');
    setUploadCount(0);
    setStatus('editing');
    sessionUrlsRef.current.clear();
  }, [question, abortAllUploads]);

  useEffect(() => () => abortAllUploads(), [abortAllUploads]);

  useEffect(() => {
    if (uploadCount > 0 && (status === 'editing' || status === 'error')) {
      setStatus('uploading');
    } else if (uploadCount === 0 && status === 'uploading') {
      setStatus('editing');
    }
  }, [uploadCount, status]);

  const handleFiles = useCallback((key: FieldKey, files: File[]) => {
    const accepted: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        toast('error', '图片过大（最大 5MB）');
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;

    const current = draftsRef.current[key];
    const imageCount = (current.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
    // 软上限：超过 6 张只提示，仍照常上传（与 LatexEditor 一致）。
    if (imageCount + accepted.length > 6) toast('error', '图片较多，建议精简');

    const planned = accepted.map(() => {
      const n = ++seqRef.current;
      return { token: `__UPLOAD_${key}_${n}__`, n };
    });
    const bucket = tokensRef.current.get(key) as Set<string>;
    planned.forEach(({ token }) => bucket.add(token));
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    setField(key, current + sep + planned.map(({ token }) => token).join('\n'));
    setUploadCount((count) => count + accepted.length);

    void (async () => {
      for (let i = 0; i < accepted.length; i += 1) {
        const { token, n } = planned[i];
        const ctrl = new AbortController();
        abortRef.current.set(token, ctrl);
        try {
          const jpeg = await ensureJpeg(accepted[i]);
          if (ctrl.signal.aborted) throw new Error('aborted');
          const compressed = await compressImageFile(jpeg);
          if (ctrl.signal.aborted) throw new Error('aborted');
          const { url } = await uploadResearchImage(compressed, ctrl.signal);
          sessionUrlsRef.current.add(url);
          replaceToken(key, token, `![图${n}](${url})`);
        } catch {
          if (ctrl.signal.aborted) {
            replaceToken(key, token, '');
          } else {
            replaceToken(key, token, failedToken(n));
            toast('error', '图片上传失败，请重试');
          }
        } finally {
          abortRef.current.delete(token);
          bucket.delete(token);
          setUploadCount((count) => count - 1);
        }
      }
    })();
  }, [replaceToken, setField]);

  const dirty = FIELD_KEYS.some((key) => drafts[key] !== initialRef.current[key]);
  const busy = status === 'validating' || status === 'saving' || status === 'saved';
  // 四个禁用条件（任一即禁）：无字段变更 / 未对照原卷 / 上传在 flight / saving 中。
  const saveDisabled =
    !dirty || !confirmedSource || uploadCount > 0 ||
    busy || status === 'closing';

  const handleSave = async () => {
    if (saveDisabled) return;
    setStatus('validating');

    // 空串 / 字面 null = 无选项题：选项保持 null，绝不捏造假选项把题改成选择题。
    const rawOptions = drafts.options.trim();
    let options: Array<{ label: string; text: string }> | null = null;
    if (rawOptions !== '' && rawOptions !== 'null') {
      try {
        const parsed = JSON.parse(rawOptions) as unknown;
        if (
          !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10 ||
          !parsed.every((o) => o !== null && typeof o === 'object' &&
            typeof (o as { label?: unknown }).label === 'string' &&
            typeof (o as { text?: unknown }).text === 'string')
        ) {
          throw new Error('bad options');
        }
        options = (parsed as Array<{ label: string; text: string }>).map((o) => ({ label: o.label, text: o.text }));
      } catch {
        toast('error', '选项格式有误，请按 JSON 数组填写');
        setStatus('editing');
        return;
      }
    }
    if (!drafts.content.trim() || !drafts.answer.trim()) {
      toast('error', '题干与标准答案不能为空');
      setStatus('editing');
      return;
    }

    const initial = initialRef.current;
    const body: Parameters<typeof updateResearchQuestion>[1] = { confirmedSource: true };
    if (drafts.content !== initial.content) body.content = drafts.content;
    // 选项未改就完全不带该 key：null 选项永不被后端重写成 "null" 或假数组。
    if (drafts.options !== initial.options) body.options = options;
    if (drafts.answer !== initial.answer) body.answer = drafts.answer;
    if (drafts.explanation !== initial.explanation) body.explanation = drafts.explanation;
    if (drafts.approach !== initial.approach) body.approach = drafts.approach;
    const trimmedNote = note.trim();
    if (trimmedNote) body.note = trimmedNote;

    setStatus('saving');
    try {
      await updateResearchQuestion(question.id, body);
      // 已入库的图被服务端引用，取消清理不再负责它们
      sessionUrlsRef.current.clear();
      setStatus('saved');
      onSaved();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
      setStatus('error');
    }
  };

  const requestCancel = () => {
    if (!dirty && uploadCount === 0 && sessionUrlsRef.current.size === 0) {
      onClose();
      return;
    }
    setStatus('closing');
  };

  const discard = async () => {
    abortAllUploads();
    const urls = Array.from(sessionUrlsRef.current);
    sessionUrlsRef.current.clear();
    if (urls.length > 0) {
      try {
        await deleteResearchImages(urls);
      } catch {
        // 清理失败不阻断关闭；服务端 gc 是兜底
      }
    }
    onClose();
  };

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-label={`编辑题目 #${question.questionNo}`}
      data-status={status}
      style={{ width: widthPx !== null ? `${widthPx}px` : undefined }}
      className="fixed inset-y-0 right-0 z-50 w-[min(92vw,32rem)] bg-white shadow-2xl border-l border-gray-200"
    >
      {/* 左缘拖拽条：10px 命中区 + z-10，避免内容区抢指针事件；跟手即时，无 width 过渡 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整抽屉宽度"
        draggable={false}
        className={`absolute left-0 top-0 bottom-0 w-[10px] z-10 cursor-col-resize touch-none flex items-center justify-center group ${dragging ? 'select-none' : ''}`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <span className="w-[2px] h-14 rounded-full bg-gray-200 group-hover:bg-gray-400 transition-colors" />
      </div>

      <div className={`h-full overflow-y-auto p-6 ${dragging ? 'select-none' : ''}`}>
        <header className="flex items-center justify-between">
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {`编辑题目 #${question.questionNo}`}
        </h2>
        <button
          type="button"
          onClick={requestCancel}
          title="关闭抽屉"
          aria-label="关闭抽屉"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-gray-100 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <p className="static-notice mt-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {NOTICE}
      </p>

      {FIELD_KEYS.map((key) => (
        <Fragment key={key}>
          {key === 'options' && choiceOptions && (
            <ChoiceOptionCards
              options={choiceOptions}
              answer={drafts.answer}
              multi={question.type === 'multi_choice'}
              disabled={busy}
              onSelect={(next) => setField('answer', next)}
            />
          )}
          <EditField
            fieldKey={key}
            value={drafts[key]}
            markdown={MARKDOWN_FIELDS.has(key)}
            busy={busy}
            onChange={(v) => setField(key, v)}
            onFiles={(files) => handleFiles(key, files)}
          />
        </Fragment>
      ))}

      <div className="mt-4">
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
          <input
            type="checkbox"
            checked={confirmedSource}
            onChange={(e) => setConfirmedSource(e.target.checked)}
          />
          已对照原卷
        </label>
      </div>

      <div className="mt-4">
        <label htmlFor="research-note" className="mb-1 block text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          备注
        </label>
        <textarea
          id="research-note"
          placeholder="备注（写审计）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full min-h-[3rem] p-2 rounded-lg border border-gray-200 bg-transparent text-sm resize-y outline-none"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>

      <footer className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={requestCancel}
          className="px-4 py-2 rounded-lg border border-gray-200 text-sm"
        >
          取消
        </button>
        <button
          type="button"
          disabled={saveDisabled}
          onClick={() => void handleSave()}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white disabled:opacity-50"
        >
          保存
        </button>
      </footer>

      <ConfirmDialog
        open={status === 'closing'}
        message="丢弃未保存的修改？"
        onCancel={() => setStatus('editing')}
        onConfirm={() => void discard()}
      />
      </div>
    </aside>
  );
}
