import type { ResearchQuestionDetail } from '@/services/api';

/**
 * Task 10 占位实现 —— 只固定 props 契约与挂载点，不要在此写真正的编辑逻辑。
 *
 * Task 10 请用同路径、同名 default export 替换为真实的五字段编辑抽屉：
 *   <ResearchQuestionEditDrawer question={q} onClose={() => ...} onSaved={() => ...} />
 * - question：Task 9 详情页传入的完整题目对象，含五字段原值
 *   （content / options / answer / explanation / approach），勿在详情页剥离。
 * - onClose：关闭抽屉。
 * - onSaved：保存成功后由详情页关闭抽屉并重新拉取详情。
 */
export interface ResearchQuestionEditDrawerProps {
  question: ResearchQuestionDetail;
  onClose: () => void;
  onSaved: () => void;
}

const FIVE_FIELDS: ReadonlyArray<[string, (q: ResearchQuestionDetail) => string]> = [
  ['题干', (q) => q.content],
  ['选项', (q) => q.options.map((o) => `${o.label}. ${o.text}`).join('；') || '—'],
  ['答案', (q) => q.answer],
  ['解析', (q) => q.explanation ?? '—'],
  ['思路', (q) => q.approach ?? '—'],
];

export default function ResearchQuestionEditDrawer({
  question,
  onClose,
  onSaved,
}: ResearchQuestionEditDrawerProps) {
  return (
    <aside
      role="dialog"
      aria-label={`编辑题目 #${question.questionNo}`}
      className="fixed inset-y-0 right-0 z-50 w-[min(92vw,32rem)] overflow-y-auto bg-white shadow-2xl border-l border-gray-200 p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {`编辑题目 #${question.questionNo}`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm"
        >
          关闭抽屉
        </button>
      </div>

      <p className="mt-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Task 10 占位：真实五字段编辑抽屉（含多图上传）将替换本组件；以下为本次可编辑的五字段当前值。
      </p>

      <dl className="mt-4 space-y-3 text-sm">
        {FIVE_FIELDS.map(([label, read]) => (
          <div key={label} className="border-b border-gray-100 pb-2">
            <dt className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</dt>
            <dd className="mt-1 break-words whitespace-pre-line" style={{ color: 'var(--text-primary)' }}>
              {read(question)}
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={onSaved}
        className="mt-6 px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white"
      >
        保存完成（占位）
      </button>
    </aside>
  );
}
