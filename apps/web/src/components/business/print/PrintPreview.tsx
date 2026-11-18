import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PrintPaper, type PrintMeta } from './PrintPaper';
import { usePdfPrint } from './usePrint';
import type { RunnerQuestion } from '@/components/business/answer/types';

interface PrintPreviewProps {
  open: boolean;
  questions: RunnerQuestion[];
  meta?: PrintMeta;
  onClose: () => void;
}

export function PrintPreview({ open, questions, meta, onClose }: PrintPreviewProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const print = usePdfPrint();

  useEffect(() => {
    if (!open) return;
    document.body.classList.add('print-open');
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('print-open');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="print-portal" role="dialog" aria-modal="true" aria-label="打印预览">
      <div className="print-toolbar">
        <p className="print-toolbar-hint">在打印面板中选择「另存为 PDF」，并关闭「页眉和页脚」</p>
        <div className="print-toolbar-actions">
          <button
            type="button"
            className="print-btn print-btn--primary"
            onClick={() => void print(sheetRef.current)}
          >
            导出 PDF
          </button>
          <button type="button" className="print-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="print-scroll">
        <PrintPaper ref={sheetRef} questions={questions} meta={meta} />
      </div>
    </div>,
    document.body,
  );
}
