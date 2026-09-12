import { clsx } from 'clsx';

export interface SymbolDef {
  label: string;
  latex: string;
  group: string;
  /** 悬浮提示；缺省时显示 latex（多行模板需自备简短说明） */
  title?: string;
}

// 分类讨论（分段函数）模板。三个约束都不能改：
//   1. $$ 必须独占一行——预览区 LatexPreview 的逐行补 $ 逻辑不会碰它，
//      remark-math 才会识别为 display 公式（居中放大，cases 才好看）；
//      `$$` 与内容同行会被当行内公式解析并报 KaTeX 错。
//   2. $0 是光标标记，由 LatexEditor 消费后丢弃；光标落在第一行空位。
//   3. 模板末尾必须带换行——否则紧跟后续文字（如 `$$def`）会报 KaTeX 错。
const CASES_TEMPLATE = '$$\n\\begin{cases}\n  $0 & \\\\\n   & \n\\end{cases}\n$$\n';

const SYMBOLS: SymbolDef[] = [
  { group: '运算', label: '÷', latex: '\\div' },
  { group: '运算', label: '×', latex: '\\times' },
  { group: '运算', label: '±', latex: '\\pm' },
  { group: '运算', label: '≤', latex: '\\leq' },
  { group: '运算', label: '≥', latex: '\\geq' },
  { group: '运算', label: '≠', latex: '\\neq' },
  { group: '幂根', label: '√', latex: '\\sqrt{}' },
  { group: '幂根', label: '½', latex: '\\frac{}{}' },
  { group: '几何', label: '∵', latex: '\\because' },
  { group: '几何', label: '∴', latex: '\\therefore' },
  { group: '几何', label: '△', latex: '\\triangle' },
  { group: '几何', label: '∠', latex: '\\angle' },
  { group: '几何', label: '∥', latex: '\\parallel' },
  { group: '几何', label: '⊥', latex: '\\perp' },
  { group: '几何', label: '°', latex: '^{\\circ}' },
  { group: '其它', label: '->', latex: '\\rightarrow' },
  { group: '其它', label: 'π', latex: '\\pi' },
  { group: '分段', label: '{', latex: CASES_TEMPLATE, title: '分类讨论（分段函数）\\begin{cases}…\\end{cases}' },
];

const GROUPS = ['运算', '幂根', '几何', '其它', '分段'];

export function SymbolPalette({ onInsert }: { onInsert: (latex: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 p-2 border-b border-[var(--bg-subtle)]">
      {GROUPS.map((g, gi) => (
        <div key={g} className="flex items-center gap-1">
          {gi > 0 && <div className="w-px h-[22px] bg-[var(--bg-subtle)] mx-0.5" />}
          {SYMBOLS.filter(s => s.group === g).map(s => (
            <button
              key={s.label}
              type="button"
              onClick={() => onInsert(s.latex)}
              className={clsx(
                'min-w-[32px] h-8 px-2 rounded-md text-sm',
                'bg-[var(--bg-subtle)] hover:bg-[var(--brand-500)] hover:text-white',
                'border border-[var(--bg-subtle)] transition-colors',
              )}
              title={s.title ?? s.latex}
            >
              {s.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
