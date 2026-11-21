import { useEffect, useState } from 'react';
import { resolveAsset } from '@/components/markdown';

// 文章文档（Markdown）按 URL 取文并缓存：同 URL 只请求一次，多个组件共享同一 Promise。
// 失败不入缓存，允许 MaterialBlock 的重试按钮再次发起。
const pending = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

export function getCachedMaterialDoc(url: string | null | undefined): string | null {
  if (!url) return null;
  return resolved.get(resolveAsset(url)) ?? null;
}

export function preloadMaterialDoc(url: string): Promise<string> {
  const key = resolveAsset(url);
  const hit = resolved.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = pending.get(key);
  if (existing) return existing;
  const p = fetch(key)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((text) => {
      resolved.set(key, text);
      pending.delete(key);
      return text;
    })
    .catch((err) => {
      pending.delete(key);
      throw err;
    });
  pending.set(key, p);
  return p;
}

export type MaterialDocState = {
  text: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  retry: () => void;
};

export function useMaterialDoc(url: string | null | undefined): MaterialDocState {
  const initial = getCachedMaterialDoc(url);
  const [text, setText] = useState<string | null>(initial);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    !url ? 'idle' : initial !== null ? 'ready' : 'loading',
  );
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) { setText(null); setStatus('idle'); return; }
    const cached = getCachedMaterialDoc(url);
    if (cached !== null) { setText(cached); setStatus('ready'); return; }
    let alive = true;
    // 先清上一篇文章：QuestionRunner 换题是 prop 变化、不重挂载，
    // 不清就会在 B 题下显示 A 题的文章（派生状态必须带 key 归属）。
    setText(null);
    setStatus('loading');
    preloadMaterialDoc(url)
      .then((t) => { if (alive) { setText(t); setStatus('ready'); } })
      .catch(() => { if (alive) { setText(null); setStatus('error'); } });
    return () => { alive = false; };
  }, [url, nonce]);

  return { text, status, retry: () => setNonce((n) => n + 1) };
}
