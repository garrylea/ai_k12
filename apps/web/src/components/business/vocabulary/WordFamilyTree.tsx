import type { WordFamilyResult } from '@/services/api';

interface Props {
  family: WordFamilyResult | null;
  loading: boolean;
  /** 请求失败（含后端回 404「该词没有词根族」） */
  failed: boolean;
}

/**
 * 词根族关系树（就地展开的缩进树，不是放射状思维导图）。
 *
 * 为什么是缩进树：词根图是「看一眼就走」的辅助信息，不是学习主场景。缩进树不打断答题、
 * 不用引入图形布局库、能在 jsdom 里断言渲染结果。族大时（act 族有 8-10 个成员）会变长，
 * 由外层容器负责滚动。
 *
 * 数据侧就是「中心词 + 成员 + 成员相对中心词的词缀注记」三层，换渲染方式不影响词库结构。
 */
export default function WordFamilyTree({ family, loading, failed }: Props) {
  if (loading) {
    return (
      <div className="mt-3 rounded-xl bg-[var(--bg-subtle)] p-3 text-sm text-[var(--text-secondary)]">
        正在展开词根…
      </div>
    );
  }

  if (failed || !family) {
    return (
      <div className="mt-3 rounded-xl bg-[var(--bg-subtle)] p-3 text-sm text-[var(--text-secondary)]">
        这个词暂时没有词根关系可展开
      </div>
    );
  }

  const { root, members } = family;
  // 中心词由后端保证排在最前（isHead），其余成员保持课标原序
  const derived = members.filter((m) => !m.isHead);

  return (
    <div
      className="mt-3 rounded-xl bg-[var(--bg-subtle)] p-3"
      data-testid="word-family-tree"
    >
      {/* 族中心 */}
      <div className="flex items-baseline gap-2">
        <span className="text-base font-bold text-[var(--brand-500)]">{root.word}</span>
        {root.phonetic && (
          <span className="text-xs text-[var(--text-secondary)]">{root.phonetic}</span>
        )}
        <span className="text-sm text-[var(--text-primary)]">{root.gloss}</span>
      </div>

      {derived.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">这个词还没有登记同族词</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {derived.map((m, i) => {
            const last = i === derived.length - 1;
            return (
              <li key={m.word} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="text-[var(--text-secondary)]">{last ? '└' : '├'}</span>
                  <span className="font-medium text-[var(--text-primary)]">{m.word}</span>
                  {m.phonetic && (
                    <span className="text-xs text-[var(--text-secondary)]">{m.phonetic}</span>
                  )}
                  <span className="text-[var(--text-secondary)]">{m.gloss}</span>
                </div>
                {m.affixes.length > 0 && (
                  <div className="ml-5 mt-0.5 flex flex-wrap gap-1.5">
                    {m.affixes.map((a) => (
                      <span
                        key={`${m.word}-${a.type}-${a.code}`}
                        className="rounded bg-[var(--bg-page)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
                      >
                        {a.code} {a.gloss}
                        {a.posHint ? ` ${a.posHint}` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
