// InlineHandwritingPad.tsx
import { useRef, useState } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from '../HandwritingPad';
import { transcribeHandwriting } from '@/services/api';

/**
 * 内嵌手写板（spec §0 交互 v2）：输入框下方展开，识别文本经 onRecognized 交父组件
 * 按字段规则追加进输入框（本组件不做拼接）。展开/收起由父组件 open 控制。
 */
interface Props {
  open: boolean;
  onRecognized(text: string): void;
  onClose(): void;
  /** 仅影响提示文案：多行字段=「识别后换行续写」，短字段=「识别后直接拼接」 */
  multiline?: boolean;
  disabled?: boolean;
}

export default function InlineHandwritingPad({ open, onRecognized, onClose, multiline = false, disabled = false }: Props) {
  const padRef = useRef<HandwritingPadHandle>(null);
  const [strokes, setStrokes] = useState(0);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const recognizeDisabled = strokes === 0 || recognizing || disabled;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image) return;
    setRecognizing(true);
    setError(null);
    try {
      const res = await transcribeHandwriting(image);
      onRecognized(res.text);
      padRef.current?.clear();
      setStrokes(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-card)] bg-white p-3"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-secondary)]">
          {multiline ? '可分批书写，识别后换行续写；写完切回「键盘」校对或直接提交' : '写完点识别，结果直接拼进输入框，可切回键盘修改'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-bold text-[var(--text-primary)]"
        >
          键盘
        </button>
      </div>

      <HandwritingPad ref={padRef} onStrokesChange={setStrokes} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRecognize}
          disabled={recognizeDisabled}
          className="rounded-[var(--radius-button)] bg-[var(--brand-500)] px-5 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {recognizing ? '识别中…' : '识别并追加'}
        </button>
        {error && <p className="text-sm text-[var(--error)]">识别失败：{error}（笔迹已保留，可直接重试）</p>}
      </div>
    </div>
  );
}
