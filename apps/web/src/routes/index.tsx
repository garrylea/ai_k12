import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import SubjectSelectPage from '@/pages/auth/SubjectSelectPage';
import EntrySelectPage from '@/pages/auth/EntrySelectPage';
import StarMapPage from '@/pages/student/StarMapPage';
import CourseDetailPage from '@/pages/student/CourseDetailPage';
import AuxiliaryHomePage from '@/pages/student/AuxiliaryHomePage';
import ConversationManagePage from '@/pages/student/ConversationManagePage';
import StudentLayout from '@/components/layout/StudentLayout';
import ParentLayout from '@/components/layout/ParentLayout';
import AdminLayout from '@/components/layout/AdminLayout';
import ParentStudentsPage from '@/pages/parent/ParentStudentsPage';
import ParentMessagesPage from '@/pages/parent/ParentMessagesPage';
import StudentSubjectConfigPage from '@/pages/parent/StudentSubjectConfigPage';
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage';
import AdminModelsPage from '@/pages/admin/AdminModelsPage';
import AdminAccountsPage from '@/pages/admin/AdminAccountsPage';
import AdminMessagesPage from '@/pages/admin/AdminMessagesPage';
import AdminChatPage from '@/pages/admin/AdminChatPage';
import AdminSecurityPage from '@/pages/admin/AdminSecurityPage';
import RequireRole from './RequireRole';
import { clearAuth, isSessionValid } from '@/utils/auth';

const Placeholder = ({ title }: { title: string }) => (
  <div className="p-8 text-[var(--text-primary)]">
    <h1 className="text-2xl font-bold mb-4">{title}</h1>
    <p className="text-[var(--text-secondary)]">原型占位：此页面正在设计中...</p>
  </div>
);

/** 根路径按登录角色分流：admin -> /admin，parent -> /parent/students，student -> 入口选择页。 */
const RoleRedirect = () => {
  // token 缺失或已过期：清掉残留角色，一律回登录页
  if (!isSessionValid()) {
    clearAuth();
    return <Navigate to="/login" replace />;
  }
  const role = localStorage.getItem('userRole');
  if (role === 'admin') return <Navigate to="/admin" replace />;
  if (role === 'parent') return <Navigate to="/parent/students" replace />;
  if (role === 'student') return <Navigate to="/student/entry" replace />;
  return <Navigate to="/login" replace />;
};

const router = createBrowserRouter([
  {
    path: '/',
    element: <RoleRedirect />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/register',
    element: <RegisterPage />,
  },
  // 管理员中枢布局路由（子页面在后续 task 逐个替换为真页面）
  {
    path: '/admin',
    element: (
      <RequireRole role="admin">
        <AdminLayout />
      </RequireRole>
    ),
    children: [
      { path: '', element: <AdminDashboardPage /> },
      { path: 'models', element: <AdminModelsPage /> },
      { path: 'accounts', element: <AdminAccountsPage /> },
      { path: 'messages', element: <AdminMessagesPage /> },
      { path: 'chat', element: <AdminChatPage /> },
      { path: 'security', element: <AdminSecurityPage /> },
    ],
  },
  // 入口选择页（独立全屏，登录后落地，主轨/辅轨分流）
  {
    path: '/student/entry',
    element: (
      <RequireRole role="student">
        <EntrySelectPage />
      </RequireRole>
    ),
  },
  // 学科选择（独立全屏页，不在布局内）
  {
    path: '/student/subjects',
    element: (
      <RequireRole role="student">
        <SubjectSelectPage />
      </RequireRole>
    ),
  },
  // 星图导航（独立全屏页，不在布局内）
  {
    path: '/student/star-map',
    element: (
      <RequireRole role="student">
        <StarMapPage />
      </RequireRole>
    ),
  },
  // 课程详情/卡片阅读 P2.2（全屏沉浸层，隐藏侧边栏）
  {
    path: '/student/course-detail',
    element: (
      <RequireRole role="student">
        <CourseDetailPage />
      </RequireRole>
    ),
  },
  // 辅线答疑轨（全屏沉浸层，独立于 StudentLayout，物理隔离）
  {
    path: '/student/auxiliary',
    element: (
      <RequireRole role="student">
        <AuxiliaryHomePage />
      </RequireRole>
    ),
  },
  {
    path: '/student/auxiliary/conversations',
    element: (
      <RequireRole role="student">
        <ConversationManagePage />
      </RequireRole>
    ),
  },
  { path: '/student/auxiliary/selector', element: <Placeholder title="知识点选择器 P3.2" /> },
  { path: '/student/auxiliary/ask', element: <Placeholder title="拍照/输入答疑 P3.3" /> },
  { path: '/student/auxiliary/chat', element: <Navigate to="/student/auxiliary" replace /> },
  {
    path: '/parent',
    element: (
      <RequireRole role="parent">
        <ParentLayout />
      </RequireRole>
    ),
    children: [
      { path: '', element: <Navigate to="/parent/students" replace /> },
      { path: 'messages', element: <ParentMessagesPage /> },
      { path: 'students', element: <ParentStudentsPage /> },
      { path: 'students/:id/config', element: <StudentSubjectConfigPage /> },
      { path: 'dashboard', element: <Placeholder title="家长仪表盘 P6.1" /> },
      { path: 'report', element: <Placeholder title="学情报告 P6.2" /> },
      { path: 'errors', element: <Placeholder title="错题查看 P6.3" /> },
      { path: 'chat-logs', element: <Placeholder title="AI 对话全透明回放 P6.4" /> },
      { path: 'goals', element: <Placeholder title="目标设定 P6.5" /> },
      { path: 'controls', element: <Placeholder title="行为管控 P6.6" /> },
      { path: 'rewards', element: <Placeholder title="奖励管理与兑现 P6.7" /> },
      { path: 'children-switch', element: <Placeholder title="多孩切换 P6.8" /> },
      { path: 'alerts', element: <Placeholder title="异常预警中心 P6.9" /> },
      { path: 'account', element: <Placeholder title="账号设置 P6.10" /> },
    ],
  },
  {
    path: '/student',
    element: (
      <RequireRole role="student">
        <StudentLayout />
      </RequireRole>
    ),
    children: [
      { path: '', element: <Navigate to="/student/star-map" replace /> },
      { path: 'homework', element: <Placeholder title="课后作业 P2.4" /> },
      { path: 'homework-result', element: <Placeholder title="作业解析 P2.5" /> },
      { path: 'unit-test', element: <Placeholder title="单元检测 P2.6" /> },
      { path: 'exam', element: <Placeholder title="期中/期末 P2.7" /> },
      { path: 'scores', element: <Placeholder title="成绩报告 P2.8" /> },
      { path: 'reward-unlock', element: <Placeholder title="闯关奖励 P2.9" /> },

      { path: 'error-book', element: <Placeholder title="错题本 P4.1" /> },
      { path: 'error-book/redo', element: <Placeholder title="错题重做 P4.2" /> },
      { path: 'error-book/variant', element: <Placeholder title="变式练习 P4.3" /> },

      { path: 'mainline', element: <Navigate to="/student/star-map" replace /> },
      { path: 'profile', element: <Placeholder title="个人中心 P5.1" /> },
      { path: 'rewards', element: <Placeholder title="奖励册 P5.2" /> },
      { path: 'settings', element: <Placeholder title="学习设置 P5.3" /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
