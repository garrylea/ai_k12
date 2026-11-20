import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getResearchPaper,
  type ResearchPaperDetailResult,
  type ResearchQuestionDetail,
} from '@/services/api';
import { Skeleton } from '@/components/base';
import ResearchQuestionEditDrawer from './ResearchQuestionEditDrawer';

const CONTENT_MAX = 60;

function truncate(text: string): string {
  return text.length > CONTENT_MAX ? `${text.slice(0, CONTENT_MAX)}…` : text;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败';
}

/**
 * 教研试卷详情：按路由 id 拉题目明细，表格给出每题的编辑入口。
 * 点击「编辑」把完整 question（含五字段原值）交给抽屉；抽屉实现属 Task 10，
 * 通过 ResearchQuestionEditDrawer 的 props 契约挂载。
 */
export default function ResearchPaperDetailPage() {
  const { id } = useParams<{ id: string }>();
  const paperId = Number(id);
  const [data, setData] = useState<ResearchPaperDetailResult | null>(null);
  const [error, setError] = useState('');
  const [editingQuestion, setEditingQuestion] = useState<ResearchQuestionDetail | null>(null);

  const load = useCallback(() => {
    if (!Number.isInteger(paperId) || paperId <= 0) {
      setError('试卷编号无效');
      setData(null);
      return;
    }
    setError('');
    getResearchPaper(paperId)
      .then(setData)
      .catch((err: unknown) => {
        setData(null);
        setError(errMessage(err));
      });
  }, [paperId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
        {data ? data.paper.title : '试卷题目明细'}
      </h1>

      {error ? (
        <div data-testid="detail-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          试卷详情加载失败，请稍后重试
        </div>
      ) : data === null ? (
        <div data-testid="detail-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={180} height={16} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
        </div>
      ) : data.questions.length === 0 ? (
        <div data-testid="detail-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          该试卷暂无题目
        </div>
      ) : (
        <div data-testid="detail-table" className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50" style={{ color: 'var(--text-secondary)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-medium">题号</th>
                <th className="text-left px-4 py-3 font-medium">题型</th>
                <th className="text-left px-4 py-3 font-medium">题干</th>
                <th className="text-left px-4 py-3 font-medium">答案</th>
                <th className="text-left px-4 py-3 font-medium">解析</th>
                <th className="text-left px-4 py-3 font-medium">来源</th>
                <th className="text-right px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-primary)' }}>
              {data.questions.map((q) => (
                <tr key={q.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">{q.questionNo}</td>
                  <td className="px-4 py-3">{q.type}</td>
                  <td className="px-4 py-3 max-w-md" title={q.content}>{truncate(q.content)}</td>
                  <td className="px-4 py-3">{q.answer}</td>
                  <td className="px-4 py-3">{q.explanation ? '有' : '无'}</td>
                  <td className="px-4 py-3">
                    {q.source ? `${q.source}${q.sourceYear ? ` ${q.sourceYear}` : ''}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`question-edit-${q.id}`}
                      onClick={() => setEditingQuestion(q)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--brand-500)] text-white hover:opacity-90"
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingQuestion && (
        <ResearchQuestionEditDrawer
          question={editingQuestion}
          onClose={() => setEditingQuestion(null)}
          onSaved={() => {
            setEditingQuestion(null);
            load();
          }}
        />
      )}
    </div>
  );
}
