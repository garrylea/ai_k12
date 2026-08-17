import { Outlet } from 'react-router-dom';
import { LogoutButton } from '@/components/base';

/** 管理员中枢占位壳：模型配置/封禁/消息推送等待后续子项目。 */
export default function AdminLayout() {
  return (
    <div data-theme="parent" className="min-h-screen bg-[var(--bg-base)]">
      <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6">
        <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          管理员中枢
        </h1>
        <LogoutButton />
      </header>
      <main className="p-8">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 max-w-2xl">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            管理员功能（模型配置 / 账号封禁 / 消息推送 / AI 对话）将在后续子项目中实现。
          </p>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
