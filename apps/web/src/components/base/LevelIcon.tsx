import { ReactNode } from 'react';

export type LevelCode =
  | 'pichai'
  | 'zhutie'
  | 'qingtong'
  | 'baiyin'
  | 'huangjin'
  | 'bojin'
  | 'zuanshi'
  | 'xingyao'
  | 'wangzhe';

interface LevelIconProps {
  /** 段位 code；未知值容错回退到 pichai（后端新增段位也不会崩） */
  code: LevelCode | string;
  /** 边长（px），默认 24 */
  size?: number;
  /** 交给调用方控色，如 text-[var(--brand-600)] */
  className?: string;
}

/**
 * 9 个段位图标（低 → 高）：
 * 柴堆 → 铁砧 → 鼎 → 盾 → 冠 → 翼 → 菱 → 星芒 → 王座。
 * 全部线性描边 + currentColor，颜色由调用方经 className 给；
 * 24px 下的辨识度靠构图差异，不靠颜色。
 */
const LEVEL_ICONS: Record<LevelCode, ReactNode> = {
  // 劈柴：下二上一的柴堆（三段圆木垛成金字塔）
  pichai: (
    <>
      <rect x="3.5" y="14" width="8" height="4.5" rx="1.2" />
      <rect x="12.5" y="14" width="8" height="4.5" rx="1.2" />
      <rect x="8" y="8.5" width="8" height="4.5" rx="1.2" />
    </>
  ),

  // 铸铁：带角砧面的铁砧（砧面 + 蜂腰 + 底座）
  zhutie: (
    <>
      <path d="M3.5 8.5h13l3.5 1.5-3.5 1.5h-13z" />
      <path d="M9 11.5 8 16H5v2.5h14V16h-3l-1-4.5" />
    </>
  ),

  // 青铜：双耳三足的鼎
  qingtong: (
    <>
      <path d="M8.5 6h2v3h-2z" />
      <path d="M13.5 6h2v3h-2z" />
      <path d="M4 9h16" />
      <path d="M6 9v5h12V9" />
      <path d="M9 14l-1 5" />
      <path d="M12 14v5" />
      <path d="M15 14l1 5" />
    </>
  ),

  // 白银：盾牌（外廓 + 中脊）
  baiyin: (
    <>
      <path d="M12 3l7 2.5v6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9v-6z" />
      <path d="M12 7v10.5" />
    </>
  ),

  // 黄金：三峰冠
  huangjin: (
    <>
      <path d="M4 8l3.5 4L12 6l4.5 6L20 8v9H4z" />
    </>
  ),

  // 铂金：翼（斜展的羽面 + 主羽脉）
  bojin: (
    <>
      <path d="M4 20C4 12 10 5 20 4c1 10-6 16-16 16z" />
      <path d="M4 20C10 15 15 10 20 4" />
    </>
  ),

  // 钻石：宝石切面
  zuanshi: (
    <>
      <path d="M12 3l9 6-9 12L3 9z" />
      <path d="M3 9h18" />
      <path d="M8 9l4 12 4-12" />
    </>
  ),

  // 星耀：四角星芒
  xingyao: (
    <>
      <path d="M12 2c.6 5 3.4 7.8 8.4 8.4-5 .6-7.8 3.4-8.4 8.4-.6-5-3.4-7.8-8.4-8.4 5-.6 7.8-3.4 8.4-8.4z" />
    </>
  ),

  // 王者：高背王座（靠背 + 扶手 + 座线 + 双腿）
  wangzhe: (
    <>
      <path d="M8 4h8v10H8z" />
      <path d="M5 9v5h14V9" />
      <path d="M8 14v6" />
      <path d="M16 14v6" />
      <path d="M5 20h14" />
    </>
  ),
};

export function LevelIcon({ code, size = 24, className }: LevelIconProps) {
  const glyph = LEVEL_ICONS[code as LevelCode] ?? LEVEL_ICONS.pichai;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph}
    </svg>
  );
}
