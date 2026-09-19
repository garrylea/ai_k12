import { useEffect, useState } from 'react';
import { Button, Card } from '@/components/base';
import { getParentMastery, type ParentMastery } from '@/services/api';

/**
 * 报告页「真掌握度」卡（埋点 Phase 1B）。
 *
 * ⚠️ **与「薄弱知识点」卡并存不替换**（spec §10 硬约束）：那张是**错题数代理**
 * （未清零错题按知识点聚合），这张是 `student_knowledge_mastery` 的**真掌握度**。
 * 两套口径、两个标题、两张卡，不得合并、不得互相替换。
 *
 * 覆盖率那句**必须显示**：题库只有约 38% 的题绑了知识点，不说明的话家长会把
 * 「列出的这几项」当成全部问题（spec §4.8 规则①）。
 */
export default function MasteryPanel({ studentId }: { studentId: number }) {
  const [data, setData] = useState<{ studentId: number; value: ParentMastery } | null>(null);
  const [failed, setFailed] = useState<{ studentId: number } | null>(null);
  const [reload, setReload] = useState(0);

  const value = data && data.studentId === studentId ? data.value : null;
  const err = failed && failed.studentId === studentId ? failed : null;

  useEffect(() => {
    let cancelled = false;
    getParentMastery(studentId, 10)
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, value: res });
        setFailed(null);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFailed({ studentId });
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  return (
    <Card className="p-5" data-testid="report-mastery">
      <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">
        真掌握度
        <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">
          （按知识点，累计）
        </span>
      </h2>

      {err ? (
        <div
          data-testid="mastery-error"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span className="text-sm text-[var(--text-secondary)]">掌握度暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : value === null ? (
        <p className="text-sm text-[var(--text-secondary)]">加载中…</p>
      ) : (
        <>
          {value.items.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">暂无掌握度数据</p>
          ) : (
            <ul className="space-y-2">
              {value.items.map((item) => (
                <li
                  key={item.knowledgePointId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[var(--text-primary)]">{item.name}</span>
                  <span className="text-[var(--text-secondary)]">
                    {`掌握度 ${Math.round(item.masteryScore * 100)}% · ${item.level} 段`}
                    <span className="ml-2 text-xs text-[var(--text-tertiary)]">
                      {`答对 ${item.correctCount} / 错 ${item.errorCount}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            覆盖率说明：空态也要显示——否则家长分不清「孩子还没数据」与「题库没标注」。
          */}
          <p data-testid="mastery-coverage" className="mt-3 text-xs text-[var(--text-tertiary)]">
            {`共 ${value.totalQuestions} 道题中 ${value.coveredQuestions} 道标注了知识点，另有 ${value.uncovered} 道未标注、未计入上面的统计。`}
          </p>
        </>
      )}
    </Card>
  );
}
