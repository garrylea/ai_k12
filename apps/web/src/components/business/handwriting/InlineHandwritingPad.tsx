// InlineHandwritingPad.tsx
import { useRef, useState } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from '../HandwritingPad';
import { transcribeHandwriting } from '@/services/api';
import { KeyboardIcon } from './icons';

/**
 * 内嵌手写板（spec §0 交互 v2）：输入框下方展开，识别文本经 onRecognized 交父组件
 * 按字段规则追加进输入框（本组件不做拼接）。展开/收起由父组件 open 控制。
 */
interface Props {
  open: boolean;
  onRecognized(text: string): void;
  onClose(): void;
  disabled?: boolean;
}

export default function InlineHandwritingPad({ open, onRecognized, onClose, disabled = false }: Props) {
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
    <>
      <HandwritingPad
        ref={padRef}
        onStrokesChange={setStrokes}
        toolbarRight={
          <button
            type="button"
            aria-label="切换到键盘输入"
            title="切换到键盘输入"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--brand-500)]"
          >
            <KeyboardIcon />
          </button>
        }
      />

      <div className="mt-2 flex items-center gap-3">
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
    </>
  );
}
