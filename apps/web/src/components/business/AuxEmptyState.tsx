export default function AuxEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-secondary)]">
      <h3 className="text-xl font-bold text-[var(--text-primary)] mb-2">今天想探索什么？</h3>
      <p className="mb-6">可以问我任意数学问题，或拍照上传题目。</p>
      <button
        onClick={onNew}
        className="px-6 py-3 rounded-xl bg-[var(--brand-500)] text-white font-bold"
      >
        开始新答疑
      </button>
    </div>
  );
}
