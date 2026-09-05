import { useCallback, useEffect, useState } from 'react';
import { Button, Card, PageHeader, Skeleton } from '@/components/base';
import { Modal } from '@/components/base';
import { toast } from '@/components/base/Toast';
import {
  listTrainingHidden,
  unmarkTrainingHidden,
  unmarkAllTrainingHidden,
  type HiddenQuestion,
} from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

const MATH_SUBJECT_ID = 1;

const TYPE_LABEL: Record<string, string> = {
  choice: '选择',
  fill_blank: '填空',
  true_false: '判断',
  short_answer: '解答',
  proof: '证明',
};

export default function HiddenQuestionsPage() {
  const { mode, autoToggleNightMode } = useThemeStore();

  const [items, setItems] = useState<HiddenQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unmarkingId, setUnmarkingId] = useState<number | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await listTrainingHidden(MATH_SUBJECT_ID);
      setItems(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载失败');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnmark = async (questionId: number) => {
    setUnmarkingId(questionId);
    try {
      await unmarkTrainingHidden(questionId);
      setItems((prev) => (prev ?? []).filter((it) => it.questionId !== questionId));
      toast('success', '已撤销');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '撤销失败');
    } finally {
      setUnmarkingId(null);
    }
  };

  const handleResetAll = async () => {
    setResetting(true);
    try {
      await unmarkAllTrainingHidden();
      setItems([]);
      toast('success', '已清空不再展示清单');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '重置失败');
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  };

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pt-6 sm:pt-8 pb-16">
          <PageHeader
            to="/student/training/targeted"
            caption="返回专项练习"
            title="我的不再展示清单"
          />

          <Card className="mt-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
            <div className="flex items-center justify-between p-4 border-b border-[var(--bg-subtle)]">
              <p className="text-sm text-[var(--learn-text-secondary)]">
                {items == null ? '加载中…' : `共 ${items.length} 题`}
              </p>
              <Button
                variant="danger"
                size="sm"
                disabled={items == null || items.length === 0 || resetting}
                onClick={() => setResetConfirm(true)}
              >
                全部重置
              </Button>
            </div>

            <div className="p-4">
              {items == null ? (
                <div className="space-y-3">
                  <Skeleton width="60%" height={14} />
                  <Skeleton height={40} />
                  <Skeleton height={40} />
                </div>
              ) : loadError ? (
                <div className="flex items-center gap-4">
                  <p className="text-sm text-[var(--learn-text-secondary)]">{loadError}</p>
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    重试
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <p className="text-sm text-[var(--learn-text-secondary)]">
                  暂无标记的题目。做题时遇到熟悉的题，可点题面右侧的「不再展示」按钮加入清单。
                </p>
              ) : (
                <ul className="space-y-2">
                  {items.map((it) => (
                    <li
                      key={it.questionId}
                      className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] p-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--brand-100)] text-[var(--brand-500)]">
                            {TYPE_LABEL[it.type] ?? it.type}
                          </span>
                          {it.kpName && (
                            <span className="text-xs text-[var(--learn-text-tertiary)] truncate">
                              {it.kpName}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--learn-text-primary)] line-clamp-2">
                          {it.questionText}
                        </p>
                        <p className="text-xs text-[var(--learn-text-tertiary)] mt-1">
                          标记于 {new Date(it.markedAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={unmarkingId === it.questionId}
                        onClick={() => void handleUnmark(it.questionId)}
                      >
                        撤销
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>

      {resetConfirm && (
        <Modal
          open
          onClose={() => setResetConfirm(false)}
          title="全部重置"
        >
          <p className="text-sm text-[var(--text-secondary)]">
            将清空所有不再展示标记，被排除的题目会重新进入专项练习抽题池。此操作不可撤销，确定继续吗？
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setResetConfirm(false)}
              className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
            >
              取消
            </button>
            <button
              onClick={() => void handleResetAll()}
              disabled={resetting}
              className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--error)] text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {resetting ? '重置中…' : '确认清空'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
