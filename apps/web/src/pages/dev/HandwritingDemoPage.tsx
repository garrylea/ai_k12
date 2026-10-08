// apps/web/src/pages/dev/HandwritingDemoPage.tsx
import { useEffect, useRef, useState } from 'react';
import {
  listHandwritingModels,
  recognizeHandwriting,
  type HandwritingModel,
  type HandwritingRecognizeResult,
} from '@/services/api';
import { compareHandwriting, type CompareResult } from './handwriting-diff';
import HandwritingPad, { type HandwritingPadHandle } from '@/components/business/HandwritingPad';

/** 手写识别率调研 demo（spec 2026-10-08）。dev-only：不进导航、不留档（内存累计，刷新清空）。 */
export default function HandwritingDemoPage() {
  const padRef = useRef<HandwritingPadHandle>(null);
  const [models, setModels] = useState<HandwritingModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState('');
  const [strokes, setStrokes] = useState(0);
  const [expected, setExpected] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ result: CompareResult; meta: HandwritingRecognizeResult; image: string } | null>(null);
  const [rounds, setRounds] = useState<{ matched: number; expectedLen: number; expected: string; recognized: string }[]>([]);

  useEffect(() => {
    listHandwritingModels()
      .then((res) => {
        setModels(res.models);
        setModelKey(res.models[0]?.key ?? '');
      })
      .catch((err: unknown) => setModelsError(err instanceof Error ? err.message : '模型列表加载失败'));
  }, []);

  const recognizeDisabled = strokes === 0 || expected.trim() === '' || recognizing;

  const onRecognize = async () => {
    const image = padRef.current?.exportImage();
    if (!image || !modelKey) return;
    setRecognizing(true);
    setError(null);
    try {
      const meta = await recognizeHandwriting(image, modelKey);
      const result = compareHandwriting(expected, meta.text);
      setLast({ result, meta, image });
      setRounds((rs) => [
        ...rs,
        { matched: result.matched, expectedLen: result.expected.length, expected: result.expected, recognized: result.recognized },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败');
    } finally {
      setRecognizing(false);
    }
  };

  // 累计口径（2026-10-08 用户裁决 Σ）：Σ本轮命中 ÷ Σ本轮对照字数，不做拼接重算
  const totalMatched = rounds.reduce((sum, r) => sum + r.matched, 0);
  const totalExpectedLen = rounds.reduce((sum, r) => sum + r.expectedLen, 0);

  return (
    <div className="min-h-screen bg-[var(--bg-base)] px-6 py-8 text-[var(--text-primary)]" data-theme="student-day">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <h1 className="text-xl font-black">手写汉字识别率调研</h1>

        {/* 控制条 */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            模型
            {modelsError ? (
              <span className="text-red-600">{modelsError}</span>
            ) : (
              <select
                role="combobox"
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
                className="rounded-[var(--radius-input)] border border-[var(--bg-subtle)] bg-white px-2 py-1"
              >
                {(models ?? []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key}（{m.modelId}）
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="flex items-center gap-2 text-sm">
            对照文本
            <textarea
              aria-label="对照文本"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              rows={2}
              className="w-80 rounded-[var(--radius-input)] border border-[var(--bg-subtle)] bg-white px-2 py-1"
              placeholder="先写下你要手写的内容（已知答案）"
            />
          </label>
          <button
            type="button"
            onClick={onRecognize}
            disabled={recognizeDisabled}
            className="rounded-[var(--radius-pill)] bg-[var(--brand-600)] px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {recognizing ? '识别中…' : '识别'}
          </button>
        </div>

        <HandwritingPad ref={padRef} onStrokesChange={setStrokes} />

        {error && <p className="text-sm text-red-600">识别失败：{error}</p>}

        {/* 最新一轮结果：原图 / 对照 / 识别 三栏 + 错字清单 */}
        {last && (
          <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--bg-subtle)] p-4">
            <h2 className="font-bold">
              本轮字级准确率：{(last.result.accuracy * 100).toFixed(1)}%（{last.result.matched}/{last.result.expected.length}，{last.meta.elapsedMs}ms）
            </h2>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">手写原图</p>
                <img src={last.image} alt="手写原图" className="max-w-full rounded border border-[var(--bg-subtle)]" />
              </div>
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">对照（归一化）</p>
                <p className="break-all">{last.result.expected || '（空）'}</p>
              </div>
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">识别（原始）</p>
                <p className="break-all">{last.meta.text || '（空）'}</p>
              </div>
            </div>
            {last.result.errors.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-[var(--text-secondary)]">错字 / 漏字</p>
                <ul className="flex flex-wrap gap-2">
                  {last.result.errors.map((e, idx) => (
                    <li key={idx} className="rounded bg-[var(--bg-subtle)] px-2 py-0.5 text-sm">
                      {e.expected} → {e.got ?? '（漏）'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {last.result.extra.length > 0 && (
              <p className="text-sm text-[var(--text-secondary)]">多识别：{last.result.extra.join('、')}</p>
            )}
          </section>
        )}

        {/* 累计区（内存，刷新清空）；ΣexpectedLen=0 即无轮次，不渲染 */}
        {totalExpectedLen > 0 && (
          <section className="rounded-[var(--radius-card)] border border-[var(--bg-subtle)] p-4">
            <h2 className="font-bold">
              累计字级准确率：{((totalMatched / totalExpectedLen) * 100).toFixed(1)}%（{rounds.length} 轮，{totalMatched}/{totalExpectedLen} 字）
            </h2>
          </section>
        )}
      </div>
    </div>
  );
}
