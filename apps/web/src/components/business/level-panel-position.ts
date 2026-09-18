/**
 * 桌面 popover 的定位数学（纯函数，独立于组件文件）。
 *
 * 单独成文件有两个原因：① jsdom 没有布局引擎，位置只能靠构造 rect 直接单测；
 * ② 组件文件只导出组件，才不触发 `react-refresh/only-export-components`。
 */

/** 视口四周留白（px），面板不与屏幕边缘贴死。 */
export const GUTTER = 8;

/** jsdom 量不到真实尺寸时的兜底：`w-72` = 288px，高度按内容估一个上界。 */
export const PANEL_FALLBACK_SIZE = { width: 288, height: 280 };

export interface PanelPosition {
  top: number;
  left: number;
}

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface SizeLike {
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number): number {
  // max 可能小于 min（面板比视口还高/宽），此时以 min 为准，至少保证上/左留白
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 计算桌面 popover 的 `{ top, left }`。
 *
 * 两条必须：**垂直翻转 + 双轴夹紧**。
 * 徽章在这三个宿主里都在「视口高、overflow-hidden、不可滚动」的侧栏底部，
 * 只往下弹会整块落在折线以下且滚不到；同时面板 `w-72` 比徽章宽得多，
 * 只按右缘对齐会让左缘跑到负 x、把 44px 段位图标裁掉——必须两边都夹。
 *
 * @param anchor 锚点 rect（`getBoundingClientRect()` 的形状）
 * @param panel  面板实测尺寸
 * @param viewport 视口尺寸
 */
export function computePanelPosition(
  anchor: RectLike,
  panel: SizeLike,
  viewport: SizeLike,
  gutter = GUTTER,
): PanelPosition {
  const spaceBelow = viewport.height - anchor.bottom - gutter;
  const spaceAbove = anchor.top - gutter;

  let top: number;
  if (spaceBelow >= panel.height) {
    top = anchor.bottom + gutter; // 默认：锚点下方
  } else if (spaceAbove >= panel.height) {
    top = anchor.top - panel.height - gutter; // 下方放不下 → 翻到锚点上方
  } else {
    // 上下都放不下（面板比可用空间还高）：退到空间更大的一侧，仍夹进视口
    top = spaceBelow >= spaceAbove ? viewport.height - gutter - panel.height : gutter;
  }

  // 默认右对齐锚点右缘（面板与徽章同侧收口），再夹进视口
  const left = anchor.right - panel.width;

  return {
    top: clamp(top, gutter, viewport.height - panel.height - gutter),
    left: clamp(left, gutter, viewport.width - panel.width - gutter),
  };
}
