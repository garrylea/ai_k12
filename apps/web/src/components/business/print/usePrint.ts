import { useCallback } from 'react';

/** 图片最多等 3s：缺图不阻塞整份导出。 */
const IMAGE_TIMEOUT_MS = 3000;

/**
 * 返回一个打印动作：先等纸面内图片 decode（最长 3s），再调 window.print()。
 * 失败一律吞掉 —— 导出不该因为一张图抛错。
 */
export function usePdfPrint(): (root: HTMLElement | null) => Promise<void> {
  return useCallback(async (root: HTMLElement | null) => {
    if (root) {
      const imgs = Array.from(root.querySelectorAll('img'));
      if (imgs.length > 0) {
        const decoded = Promise.all(
          imgs.map((img) =>
            typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve(),
          ),
        );
        await Promise.race([
          decoded,
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, IMAGE_TIMEOUT_MS);
          }),
        ]);
      }
    }
    try {
      window.print();
    } catch {
      // jsdom / 受限环境不支持打印：不抛到 UI
    }
  }, []);
}
