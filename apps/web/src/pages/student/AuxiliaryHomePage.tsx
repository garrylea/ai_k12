import { useNavigate } from 'react-router-dom';
import AuxiliaryLayout from '@/components/business/AuxiliaryLayout';
import ConversationList from '@/components/business/ConversationList';
import AuxEmptyState from '@/components/business/AuxEmptyState';

export default function AuxiliaryHomePage() {
  const navigate = useNavigate();

  return (
    <AuxiliaryLayout sidebar={<ConversationList />}>
      <header className="h-16 border-b border-[var(--bg-subtle)] flex items-center justify-between px-6 bg-[var(--bg-card)]">
        <span className="text-sm text-[var(--text-secondary)]">答疑轨 · 限 K12 学科</span>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/student/entry')}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--bg-subtle)] text-[var(--text-primary)]"
          >
            退出答疑
          </button>
          <button
            onClick={() => navigate('/student/auxiliary/chat')}
            className="px-4 py-2 rounded-lg text-sm bg-[var(--brand-500)] text-white"
          >
            下一个问题
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        <AuxEmptyState onNew={() => navigate('/student/auxiliary/chat')} />
      </div>
    </AuxiliaryLayout>
  );
}
