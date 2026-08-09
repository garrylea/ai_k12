import { clsx } from 'clsx';

export interface SymbolDef { label: string; latex: string; group: string; }

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
  { group: '其它', label: '$', latex: '$$' },
];

const GROUPS = ['运算', '幂根', '几何', '其它'];

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
              title={s.latex}
            >
              {s.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
