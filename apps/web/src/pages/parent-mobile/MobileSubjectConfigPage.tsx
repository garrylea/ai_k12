import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ConfirmDialog, toast } from '@/components/base';
import {
  getStudentSubjectConfigs, updateStudentSubjectConfig,
  type SubjectConfigOption, type SubjectConfigState,
} from '@/services/api';

type LoadStatus = 'loading' | 'ready' | 'error';
type Selection = { gradeCode: string; term: string; versionId: number };

/** 从 options 里解析该科的三元组（照抄桌面 resolveSelection 语义）。 */
function resolveSelection(option: SubjectConfigOption, state: SubjectConfigState): Selection {
  const grade = state.gradeCode
    ? option.grades.find((g) => g.code === state.gradeCode) ?? option.grades[0]
    : option.grades[0];
  const version = state.textbookVersionId != null && grade.versions.some((v) => v.id === state.textbookVersionId)
    ? grade.versions.find((v) => v.id === state.textbookVersionId)!
    : grade.versions[0];
  const term = state.term && version.terms.includes(state.term) ? state.term : version.terms[0] ?? 'first';
  return { gradeCode: grade.code, term, versionId: version.id };
}

export default function MobileSubjectConfigPage() {
  const { id } = useParams();
  const studentId = Number(id);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [data, setData] = useState<Awaited<ReturnType<typeof getStudentSubjectConfigs>> | null>(null);
  const [error, setError] = useState(false);
  const [selections, setSelections] = useState<Record<number, Selection>>({});
  const [confirmSubject, setConfirmSubject] = useState<SubjectConfigState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!Number.isInteger(studentId)) return;
    setError(false);
    setStatus('loading');
    getStudentSubjectConfigs(studentId)
      .then((res) => {
        setData(res);
        setSelections(Object.fromEntries(res.subjects.map((s) => {
          const option = res.options.find((o) => o.subjectId === s.subjectId);
          return [s.subjectId, option ? resolveSelection(option, s) : { gradeCode: s.gradeCode ?? '', term: s.term ?? 'first', versionId: s.textbookVersionId ?? 0 }];
        })));
        setStatus('ready');
      })
      .catch(() => setError(true));
  }, [studentId]);

  useEffect(() => { load(); }, [load]);

  if (!Number.isInteger(studentId)) {
    return <div data-testid="mobile-page-config" className="text-[var(--text-secondary)]">无效的学生</div>;
  }
  if (error) {
    return (
      <div data-testid="mobile-page-config">
        <div className="rounded-2xl bg-white p-8 text-center">
          <p className="text-[var(--text-secondary)]">加载失败</p>
          <button data-testid="config-retry" onClick={load} className="mt-2 text-[var(--brand-500)]">重试</button>
        </div>
      </div>
    );
  }
  if (status === 'loading' || data === null) {
    return <div data-testid="mobile-page-config"><div className="h-24 animate-pulse rounded-2xl bg-white" /></div>;
  }

  const save = (s: SubjectConfigState) => {
    const sel = selections[s.subjectId];
    if (!sel) return;
    setSaving(true);
    updateStudentSubjectConfig(studentId, s.subjectId, {
      gradeCode: sel.gradeCode,
      term: sel.term as 'first' | 'second',
      textbookVersionId: sel.versionId,
    })
      .then((res) => {
        setConfirmSubject(null);
        toast('success', res.reset ? `已切换 ${s.subjectName} 教材，该学科学习进度已重置` : `已保存 ${s.subjectName} 教材配置`);
        load();
      })
      .catch((e: unknown) => toast('error', e instanceof Error ? e.message : '保存失败'))
      .finally(() => setSaving(false));
  };

  return (
    <div data-testid="mobile-page-config" className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <Link to="/m/parent/students" className="text-xs text-[var(--brand-500)]">← 返回学生管理</Link>
        <p className="text-xs text-[var(--text-tertiary)]">配置对象：{data.studentName ?? `学生 #${studentId}`}</p>
      </div>
      <p className="px-1 text-xs text-[var(--text-tertiary)]">切换教材将重置该学科学习进度（历史记录保留）。</p>
      {data.subjects.map((s) => {
        const option = data.options.find((o) => o.subjectId === s.subjectId);
        const sel = selections[s.subjectId];
        if (!option || !sel) return null;
        const grade = option.grades.find((g) => g.code === sel.gradeCode);
        const dirty = s.gradeCode !== sel.gradeCode || s.term !== sel.term || s.textbookVersionId !== sel.versionId;
        return (
          <div key={s.subjectId} className="rounded-2xl bg-white p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold">{s.subjectName}</p>
              <span className="text-xs text-[var(--text-tertiary)]">{s.configured ? (s.started ? '学习中' : '已配置') : '未配置'}</span>
            </div>
            <div className="mt-2 space-y-2 text-sm">
              <div>
                <label className="text-xs text-[var(--text-secondary)]">年级</label>
                <select aria-label={`${s.subjectName}-年级`} value={sel.gradeCode}
                  onChange={(e) => {
                    const g = option.grades.find((x) => x.code === e.target.value)!;
                    const version = g.versions[0];
                    setSelections((prev) => ({ ...prev, [s.subjectId]: { gradeCode: g.code, term: version.terms.includes('first') ? 'first' : version.terms[0] ?? 'first', versionId: version.id } }));
                  }}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {option.grades.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-secondary)]">版本</label>
                <select aria-label={`${s.subjectName}-版本`} value={sel.versionId}
                  onChange={(e) => setSelections((prev) => ({ ...prev, [s.subjectId]: { ...sel, versionId: Number(e.target.value) } }))}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {(grade?.versions ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.edition ? `（${v.edition}）` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-secondary)]">册别</label>
                <select aria-label={`${s.subjectName}-册别`} value={sel.term}
                  onChange={(e) => setSelections((prev) => ({ ...prev, [s.subjectId]: { ...sel, term: e.target.value } }))}
                  className="mt-1 w-full rounded-xl border border-[var(--bg-subtle)] px-3 py-2">
                  {(grade?.versions.find((v) => v.id === sel.versionId)?.terms ?? []).map((t) => (
                    <option key={t} value={t}>{t === 'first' ? '上册' : '下册'}</option>
                  ))}
                </select>
              </div>
            </div>
            {dirty && (
              <button data-testid={`config-save-${s.subjectId}`} onClick={() => setConfirmSubject(s)} disabled={saving}
                className="mt-3 w-full rounded-xl bg-[var(--brand-500)] py-2 text-sm text-white">
                保存{saving ? '中…' : ''}
              </button>
            )}
          </div>
        );
      })}
      {confirmSubject && (
        <ConfirmDialog
          open={confirmSubject !== null}
          title={`保存 ${confirmSubject.subjectName} 教材配置`}
          message="切换教材将重置该学科学习进度（历史记录保留）。确认保存？"
          onConfirm={() => save(confirmSubject)}
          onCancel={() => setConfirmSubject(null)}
        />
      )}
    </div>
  );
}
