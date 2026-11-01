import { useEffect, useRef, useState } from 'react';
import { SymbolPalette } from './SymbolPalette';
import type { PreviewScrollSync } from './preview-scroll-sync';
import { uploadFile } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { compressImageFile, MAX_IMAGE_BYTES } from '@/utils/image-compress';
import { toast } from '@/components/base/Toast';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 左输入区 → 右预览区的滚动跟随通道（QuestionRunner 传入同一实例，见 PreviewScrollSync 注释） */
  scrollSync?: { current: PreviewScrollSync };
  /** 有图片正在上传时回调 true：上层据此禁用提交，避免占位文本落库（spec §4.1 第 8 步） */
  onUploadingChange?: (uploading: boolean) => void;
  /** 异步上传结果写回：给了就交给上层按题号打补丁（避免整段快照覆盖学生新输入）；
   *  不给则就地替换当前文本（独立使用/单测的兜底路径）。 */
  onReplaceToken?: (token: string, replacement: string) => void;
}

/** 模板光标标记：插入后光标落在此处，标记本身不写入文本框。
 *  用于「插入位置不在末尾」的多行模板（如 SymbolPalette 的分类讨论模板）。 */
const CARET_MARKER = '$0';
const UPLOAD_TIMEOUT_MS = 15_000;
/** 占位用纯文本：不产生 <img>，预览区不会闪破图；失败标记与它同构，编号扫描才认得出 */
const pendingToken = (n: number) => `［图${n} 上传中…］`;
const failedToken = (n: number) => `［图${n} 上传失败］`;
const IMG_INDEX_RE = /图(\d+)/g;

/** 下一个可用图片编号 = 文中所有「图N」标记（含失败/上传中）的最大值 + 1，避免撞号 */
function nextImageIndex(text: string): number {
  let max = 0;
  for (const m of text.matchAll(IMG_INDEX_RE)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max + 1;
}

export function LatexEditor({ value, onChange, scrollSync, onUploadingChange, onReplaceToken }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  // valueRef 是唯一真相：上传 await 期间学生可能继续打字或删掉占位，
  // 只读 props.value 会拿到发起时的旧快照，把后来的编辑覆盖掉。
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  // 仍在飞的占位串。学生删掉占位后文中已扫不到「图N」，只按文本取号会复用旧号：
  // 旧请求返回时精确命中新占位 → 旧图顶替新图、新图结果找不到串被丢弃。
  const inFlightRef = useRef<Set<string>>(new Set());

  /** 所有写入都走这里：同步 valueRef，受控组件本轮回填前异步逻辑也能拿到最新文本 */
  const emit = (next: string) => {
    valueRef.current = next;
    onChange(next);
  };

  useEffect(() => { onUploadingChange?.(uploading > 0); }, [uploading, onUploadingChange]);

  const insertAtCursor = (template: string) => {
    // 先摘掉光标标记，再算落点——标记位置即模板内偏移，与插入位置相加得绝对光标位。
    const markerAt = template.indexOf(CARET_MARKER);
    const latex = markerAt >= 0 ? template.replace(CARET_MARKER, '') : template;
    const ta = ref.current;
    const base = valueRef.current;
    if (!ta) {
      emit(base + latex);
      return;
    }
    const start = ta.selectionStart ?? base.length;
    const end = ta.selectionEnd ?? base.length;
    // 左侧始终存放裸 LaTeX（不含 $）；预览侧按需自动补 $...$
    const next = base.slice(0, start) + latex + base.slice(end);
    emit(next);
    requestAnimationFrame(() => {
      // 光标落点优先级：$0 标记 > 首个 {} 占位内（如 \frac{}{}）> 插入末尾
      const ph = latex.indexOf('{}');
      const pos = markerAt >= 0 ? start + markerAt : ph >= 0 ? start + ph + 1 : start + latex.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      // 光标落在末尾、或模板整体插在内容末尾（光标在模板内占位符上）：钉到底部让插入点可见
      if (ta.scrollHeight > ta.clientHeight && (pos === ta.value.length || start + latex.length === ta.value.length)) {
        ta.scrollTop = ta.scrollHeight;
      }
    });
  };

  /** 整段插入（批量占位用），光标落在插入内容之后。
   *  批量占位必须一次写完：逐张插入会让受控 textarea 的光标在多轮回填间漂移。 */
  const insertBlock = (block: string) => {
    const ta = ref.current;
    const base = valueRef.current;
    const start = ta?.selectionStart ?? base.length;
    const end = ta?.selectionEnd ?? base.length;
    const needsLead = start > 0 && base[start - 1] !== '\n';
    const needsTail = end < base.length && base[end] !== '\n';
    const text = `${needsLead ? '\n' : ''}${block}${needsTail ? '\n' : ''}`;
    emit(base.slice(0, start) + text + base.slice(end));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
      // 同 insertAtCursor：程序化选址不滚动，末尾贴图必须钉底，否则学生看不到占位
      if (pos === el.value.length && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    });
  };

  /** 精确替换一个占位串；找不到（学生已删除）就丢弃结果，绝不追加或复活 */
  const replaceToken = (token: string, replacement: string) => {
    if (onReplaceToken) {
      // 交给上层按题号作用于「该题最新缓存」：本实例可能已卸载、valueRef 冻在发起上传时的
      // 旧快照上，在这里 emit 会把学生之后输入的内容整段吞掉。编辑器自身文本随后由 value 回流。
      onReplaceToken(token, replacement);
      return;
    }
    const cur = valueRef.current;
    const idx = cur.indexOf(token);
    if (idx < 0) return;
    emit(cur.slice(0, idx) + replacement + cur.slice(idx + token.length));
    const el = ref.current;
    const sel = el?.selectionStart;
    // 只有光标贴着或落在占位内时才跟着挪；别处的光标一律不动（spec §4.1 第 6 步：替换不改光标），
    // 否则学生把光标放到文首时，一次异步返回就把光标拽走了
    if (!el || sel == null || sel <= idx || sel > idx + token.length) return;
    const pos = sel === idx + token.length ? idx + replacement.length : sel + (replacement.length - token.length);
    requestAnimationFrame(() => el.setSelectionRange(pos, pos));
  };

  const handleImageFiles = async (files: File[]) => {
    const accepted: File[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) { toast('error', '图片过大（最大 5MB）'); continue; }
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    if (accepted.length > 6) toast('error', '图片较多，建议精简');

    // 编号分配要跳过仍在飞的占位：学生删掉占位后文中已扫不到它，只按文本取号会复用
    let cursor = nextImageIndex(valueRef.current);
    const numbers: number[] = [];
    for (let i = 0; i < accepted.length; i += 1) {
      while (inFlightRef.current.has(pendingToken(cursor))) cursor += 1;
      numbers.push(cursor);
      cursor += 1;
    }
    const tokens = numbers.map((n) => pendingToken(n));
    tokens.forEach((t) => inFlightRef.current.add(t));
    insertBlock(tokens.join('\n')); // 一次 onChange 插入全部占位：逐张插会让受控光标漂移

    setUploading((c) => c + accepted.length);
    for (let i = 0; i < accepted.length; i++) {
      const token = tokens[i];
      const n = numbers[i];
      try {
        // 顺序处理：并发上传多张会把 DOM 光标和 onChange 交错打乱
        const jpeg = await ensureJpeg(accepted[i]);
        const compressed = await compressImageFile(jpeg);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
        try {
          const { url } = await uploadFile(compressed, ctrl.signal);
          replaceToken(token, `![图${n}](${url})`);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // 失败只落在占位处：不抛给上层，也不打断同批其它图片
        replaceToken(token, failedToken(n));
        toast('error', '图片上传失败，请重试');
      } finally {
        // 该请求已落地（成功/失败/占位被删），编号可以回到池子里
        inFlightRef.current.delete(token);
        setUploading((c) => c - 1);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    // 必须在任何 await 之前同步读完 clipboardData（事件对象随后就失效）
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0) return; // 纯文本：放行浏览器原生粘贴
    e.preventDefault();
    void handleImageFiles(files);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) {
      // 拖进非图片时浏览器默认导航到该文件——已作答内容会整体丢失，必须拦下
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
      return;
    }
    e.preventDefault();
    void handleImageFiles(files);
  };

  /** 光标在末尾且内容溢出时把视口钉到底部。
   *  Chrome 只对「逐键打字」做光标跟随；粘贴 / IME 一次性提交长文本（insertText 路径）
   *  与程序化 setSelectionRange 都不滚动（2026-09-22 实测：底部粘贴 16 行后 scrollTop
   *  停在旧值，插入点在可视区外 300+px）。光标不在末尾的编辑不干预——浏览器原生跟随。 */
  const pinToBottomIfCaretAtEnd = (ta: HTMLTextAreaElement, caret: number) => {
    if (caret === ta.value.length && ta.scrollHeight > ta.clientHeight) {
      ta.scrollTop = ta.scrollHeight;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <SymbolPalette onInsert={insertAtCursor} />
      <textarea
        ref={ref}
        value={value}
        onChange={e => {
          emit(e.target.value);
          // 粘贴 / IME 提交走 onChange（input 事件），打完钉底（见 pinToBottomIfCaretAtEnd 注释）
          pinToBottomIfCaretAtEnd(e.currentTarget, e.currentTarget.selectionStart ?? 0);
        }}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => {
          // 只认文件拖拽：拖选中的文字进来不该亮高亮框
          if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onScroll={e => {
          if (!scrollSync) return;
          const el = e.currentTarget;
          const max = el.scrollHeight - el.clientHeight;
          if (max <= 0) return; // 输入区无滚动条：没有「跟随」语义，不动预览
          scrollSync.current.ratio = el.scrollTop / max;
          scrollSync.current.apply?.();
        }}
        placeholder="在此用 LaTeX 作答，数学公式无需输入 $，直接写 LaTeX 即可"
        className={`flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed${dragging ? ' ring-2 ring-[var(--brand-500)]' : ''}`}
      />
    </div>
  );
}
