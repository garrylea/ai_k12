import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Modal, toast } from '@/components/base';
import {
  getStudentSubjectConfigs,
  updateStudentSubjectConfig,
  type SubjectConfigOption,
  type SubjectConfigState,
} from '@/services/api';

interface RowSelection {
  gradeCode: string;
  term: string;
  versionId: number;
}

const TERM_LABELS: Record<string, string> = { first: '上册', second: '下册' };

function versionLabel(publisher: string | null, edition: string): string {
  if (!edition) return publisher || '默认版本';
  return `${publisher ?? ''}（${edition}）`;
}

/** 初始化某学科的选择：优先既有配置/推导默认，其次首个年级的默认版本。 */
function initSelection(state: SubjectConfigState, option: SubjectConfigOption): RowSelection | null {
  const grade = state.gradeCode
    ? option.grades.find(g => g.code === state.gradeCode) ?? option.grades[0]
    : option.grades[0];
  if (!grade || grade.versions.length === 0) return null;
  const version = state.textbookVersionId != null && grade.versions.some(v => v.id === state.textbookVersionId)
    ? grade.versions.find(v => v.id === state.textbookVersionId)!
    : grade.versions[0];
  const term = state.term && version.terms.includes(state.term) ? state.term : version.terms[0] ?? 'first';
  return { gradeCode: grade.code, term, versionId: version.id };
}

export default function StudentSubjectConfigPage() {
  const { id } = useParams<{ id: string }>();
  const studentId = Number(id);

  const [studentName, setStudentName] = useState('');
  const [states, setStates] = useState<SubjectConfigState[]>([]);
  const [options, setOptions] = useState<SubjectConfigOption[]>([]);
  const [selections, setSelections] = useState<Record<number, RowSelection>>({});
  const [loading, setLoading] = useState(true);
  const [confirmTarget, setConfirmTarget] = useState<SubjectConfigState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(studentId) || studentId <= 0) return;
    setLoading(true);
    try {
      const res = await getStudentSubjectConfigs(studentId);
      setStudentName(res.studentName ?? '');
      setStates(res.subjects);
      setOptions(res.options);
      const next: Record<number, RowSelection> = {};
      for (const s of res.subjects) {
        const opt = res.options.find(o => o.subjectId === s.subjectId);
        if (!opt) continue;
        const sel = initSelection(s, opt);
        if (sel) next[s.subjectId] = sel;
      }
      setSelections(next);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => states.map(s => ({
    state: s,
    option: options.find(o => o.subjectId === s.subjectId),
  })).filter(r => r.option), [states, options]);

  const handleGradeChange = (subjectId: number, gradeCode: string) => {
    const option = options.find(o => o.subjectId === subjectId);
    const grade = option?.grades.find(g => g.code === gradeCode);
    if (!grade || grade.versions.length === 0) return;
    const version = grade.versions[0];
    const term = version.terms.includes('first') ? 'first' : version.terms[0] ?? 'first';
    setSelections(prev => ({ ...prev, [subjectId]: { gradeCode, term, versionId: version.id } }));
  };

  const handleSave = async (s: SubjectConfigState) => {
    const sel = selections[s.subjectId];
    if (!sel) return;
    const changed = s.configured
      && (s.gradeCode !== sel.gradeCode || s.term !== sel.term || s.textbookVersionId !== sel.versionId);
    // 已开始学习的学科且配置变化 -> 先弹确认（切换即重置该学科学习进度）
    if (s.started && changed) {
      setConfirmTarget(s);
      return;
    }
    await doSave(s);
  };

  const doSave = async (s: SubjectConfigState) => {
    const sel = selections[s.subjectId];
    if (!sel) return;
    setSaving(true);
    try {
      const res = await updateStudentSubjectConfig(studentId, s.subjectId, {
        gradeCode: sel.gradeCode,
        term: sel.term as 'first' | 'second',
        textbookVersionId: sel.versionId,
      });
      setConfirmTarget(null);
      if (res.reset) {
        toast('success', `已切换 ${s.subjectName} 教材，该学科学习进度已重置`);
      } else {
        toast('success', `已保存 ${s.subjectName} 教材配置`);
      }
      await load();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>加载中…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
          学习配置{studentName ? ` · ${studentName}` : ''}
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          按学科配置教材年级、册别与版本，默认全科同年级。已开始学习的学科切换后将重置该学科学习进度。
        </p>
      </div>

      <div className="space-y-4">
        {rows.map(({ state: s, option }) => {
          const sel = selections[s.subjectId];
          if (!sel) return null;
          const grade = option!.grades.find(g => g.code === sel.gradeCode);
          const version = grade?.versions.find(v => v.id === sel.versionId);
          const changed = s.configured
            && (s.gradeCode !== sel.gradeCode || s.term !== sel.term || s.textbookVersionId !== sel.versionId);
          return (
            <div key={s.subjectId} className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{s.subjectName}</h3>
                  {s.configured ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ color: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)' }}>
                      已配置
                    </span>
                  ) : (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ color: 'var(--text-secondary)', backgroundColor: 'rgba(0,0,0,0.04)' }}>
                      未配置（默认）
                    </span>
                  )}
                  {s.started && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded" style={{ color: '#d97706', backgroundColor: 'rgba(217,119,6,0.08)' }}>
                      已开始学习
                    </span>
                  )}
                </div>
                <Button variant={changed ? 'primary' : 'ghost'} size="sm" loading={saving} onClick={() => handleSave(s)}>
                  保存
                </Button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>年级</label>
                  <select
                    value={sel.gradeCode}
                    onChange={(e) => handleGradeChange(s.subjectId, e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
                  >
                    {option!.grades.map(g => (
                      <option key={g.code} value={g.code}>{g.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>册别</label>
                  <select
                    value={sel.term}
                    onChange={(e) => setSelections(prev => ({ ...prev, [s.subjectId]: { ...sel, term: e.target.value } }))}
                    disabled={!version}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none disabled:bg-gray-50"
                  >
                    {(version?.terms ?? []).map(t => (
                      <option key={t} value={t}>{TERM_LABELS[t] ?? t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1.5" style={{ color: 'var(--text-secondary)' }}>教材版本</label>
                  <select
                    value={sel.versionId}
                    onChange={(e) => setSelections(prev => ({ ...prev, [s.subjectId]: { ...sel, versionId: Number(e.target.value) } }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:border-[var(--brand-500)] outline-none"
                  >
                    {(grade?.versions ?? []).map(v => (
                      <option key={v.id} value={v.id}>{versionLabel(v.publisher, v.edition)}</option>
                    ))}
                  </select>
                  {grade && grade.versions[0] && (
                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      首个为推荐默认（最新版次优先）
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
            暂无可配置的教材数据。
          </div>
        )}
      </div>

      <Modal
        open={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={`切换 ${confirmTarget?.subjectName ?? ''} 教材`}
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            该学科已开始学习，切换教材版本或年级后将<b style={{ color: 'var(--error)' }}>重置该学科的学习进度</b>，
            需从新教材的第一课重新开始（历史错题与作业记录保留在系统中）。确定切换吗？
          </p>
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setConfirmTarget(null)}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={() => confirmTarget && doSave(confirmTarget)}>
              确认切换并重置
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
