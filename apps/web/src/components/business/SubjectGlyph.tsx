import type { ReactNode } from 'react';
import type { SubjectIconName } from '@/subjectConfig';

/**
 * 学科图标的唯一实现（选科类页面的白卡徽章里用）。
 *
 * 为什么按学科分图：两个选科页（训练轨 `/student/training`、主线学科选择）原先
 * 所有卡片共用一枚哑铃/书本，学生分不出哪张是哪科，只能读文字（2026-11-08 用户指出）。
 *
 * 取形原则（与 `style.md` §2 一致）：
 * - 只用线性 SVG、`currentColor`、1.5 描边，不写死颜色，不用 emoji；
 * - 用**学科教具**而非字母缩写（数学=尺、语文=卷轴、英语=Aa、物理=原子、化学=烧瓶、
 *   道德与法治=天平），24px 下靠轮廓区分；
 * - 徽章底色不按学科区分（配色只有一套），学科差异只由图形承担。
 *
 * 新增学科 = `TRAINING_SUBJECTS` 加一行 + 这里加一个 glyph，别在页面里写 if。
 */
const GLYPHS: Record<SubjectIconName, ReactNode> = {
  // 数学：直尺（斜置，带刻度）
  math: (
    <>
      <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" />
      <path d="m14.5 12.5 2-2" />
      <path d="m11.5 9.5 2-2" />
      <path d="m8.5 6.5 2-2" />
      <path d="m17.5 15.5 2-2" />
    </>
  ),

  // 语文：卷轴（上沿卷起 + 下端横轴）
  chinese: (
    <>
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </>
  ),

  // 英语：大小写字母 Aa
  english: (
    <>
      <path d="m15 16 2.536-7.328a1.02 1.02 0 0 1 1.928 0L22 16" />
      <path d="M15.697 14h5.606" />
      <path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16" />
      <path d="M3.304 13h6.392" />
    </>
  ),

  // 物理：原子（核 + 两条交叉轨道）
  physics: (
    <>
      <circle cx="12" cy="12" r="1" />
      <path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z" />
      <path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z" />
    </>
  ),

  // 化学：锥形瓶（瓶颈 + 液面线）
  chemistry: (
    <>
      <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
      <path d="M8.5 2h7" />
      <path d="M7 16h10" />
    </>
  ),

  // 道德与法治：天平（横梁 + 两侧托盘 + 立柱）
  politics: (
    <>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </>
  ),
};

interface SubjectGlyphProps {
  name: SubjectIconName;
  className?: string;
}

export function SubjectGlyph({ name, className = 'w-8 h-8' }: SubjectGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-subject-icon={name}
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}
