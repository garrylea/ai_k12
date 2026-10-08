// apps/web/src/components/business/handwriting/HandwritingInputModal.tsx
import { useRef, useState } from 'react';
import HandwritingPad, { type HandwritingPadHandle } from '../HandwritingPad';
import { transcribeHandwriting } from '@/services/api';

/**
 * 手写输入弹层（spec 2026-10-08 §4.2）：手写 → 识别 → 校对 → 确认回填。
 * open 控制显隐不卸载：误关后笔迹与校对区保留；「确认填入」是唯一回填路径。
 */
interface Props {
  open: boolean;
  title: string;
  onConfirm(value: string): void;
  onClose(): void;
}

export default function HandwritingInputModal({ open, title, onConfirm, onClose }: Props) {
  const padRef = useRef<HandwritingPadHandle>(null);
  const [strokes, setStrokes] = useState(0);
  const [draft, setDraft] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognizeDisabled = strokes === 0 || recognizing;
  const confirmDisabled = draft.trim() === '' || recognizing;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image) return;
    setRecognizing(true);
    setError(null);
    try {
      const res = await transcribeHandwriting(image);
      setDraft((prev) => {
        if (prev === '') return res.text;
        return prev.endsWith('\n') ? prev + res.text : prev + '\n' + res.text;
      });
      padRef.current?.clear();
      setStrokes(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  const onConfirmClick = () => {
    onConfirm(draft);
    // 回填后清空弹层状态（下次打开是干净的）
    setDraft('');
    setStrokes(0);
    setError(null);
    padRef.current?.clear();
    onClose();
  };

  return (
    <div
      className={`${open ? 'flex' : 'hidden'} fixed inset-0 z-50 items-center justify-center bg-black/40 p-4`}
      hidden={!open}
      role="dialog"
      aria-label={title}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-[var(--radius-card)] bg-white p-5 sm:p-6"
        style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black text-[var(--text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-sm text-[var(--text-primary)]"
          >
            关闭
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
          <span className="text-xs text-[var(--text-secondary)]">
            可分批书写，识别结果会逐批续到下方校对区
          </span>
        </div>

        {error && <p className="text-sm text-[var(--error)]">识别失败：{error}（笔迹已保留，可直接重试）</p>}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold text-[var(--text-primary)]">校对区（识别结果，可直接修改）</span>
          <textarea
            aria-label="校对区"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            className="w-full p-3 rounded-[var(--radius-button)] bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30"
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
            placeholder="识别结果会出现在这里，请核对修改"
          />
        </label>

        <button
          type="button"
          onClick={onConfirmClick}
          disabled={confirmDisabled}
          className="h-12 rounded-[var(--radius-button)] bg-[var(--brand-600)] text-sm font-bold text-white disabled:opacity-50"
        >
          确认填入
        </button>
      </div>
    </div>
  );
}
