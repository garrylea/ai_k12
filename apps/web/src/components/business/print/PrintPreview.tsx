import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PrintPaper, type PrintMeta } from './PrintPaper';
import { usePdfPrint } from './usePrint';
import { preloadMaterialDoc } from '@/hooks/useMaterialDoc';
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

  // 打印前预取所有文章 doc（最多等 3s）：材料区是异步取文的，不预取会在 PDF 里
  // 印出「材料加载中…」；3s 封顶保证断网/慢网也能出纸（失败的重试按钮仍可点）。
  const [docsReady, setDocsReady] = useState(false);
  useEffect(() => {
    if (!open) { setDocsReady(false); return; }
    let alive = true;
    const urls = Array.from(new Set(questions.map((q) => q.materialUrl).filter(Boolean))) as string[];
    const timeout = new Promise<void>((r) => setTimeout(r, 3000));
    Promise.race([
      Promise.all(urls.map((u) => preloadMaterialDoc(u))).then(() => undefined),
      timeout,
    ]).catch(() => undefined).finally(() => { if (alive) setDocsReady(true); });
    return () => { alive = false; };
  }, [open, questions]);

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
            disabled={!docsReady}
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
        {docsReady ? (
          <PrintPaper ref={sheetRef} questions={questions} meta={meta} />
        ) : (
          <p className="print-toolbar-hint">材料加载中…</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
