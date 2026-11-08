import { useCallback, useState } from 'react';
import {
  recognizeFreeform,
  type AttachmentRequest,
  type FreeformRecognizeResult,
} from '@/services/api';

/**
 * 自由作答页的识别（拍照/文本 → 候选题）。
 *
 * 只负责「一次识别」的状态机：开始清空上一次结果、失败落文案、reset 供
 * 学生重新拍。页面切换候选/确认由调用方自己管，hook 不认识 UI。
 */
export function useFreeformRecognize() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FreeformRecognizeResult | null>(null);

  const run = useCallback(async (input: { text: string; attachments: AttachmentRequest[] }) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await recognizeFreeform(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : '识别失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { busy, error, result, run, reset };
}
