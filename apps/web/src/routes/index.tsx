import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/auth/LoginPage';
import SubjectSelectPage from '@/pages/auth/SubjectSelectPage';
import EntrySelectPage from '@/pages/auth/EntrySelectPage';
import StarMapPage from '@/pages/student/StarMapPage';
import CourseDetailPage from '@/pages/student/CourseDetailPage';
import AuxiliaryHomePage from '@/pages/student/AuxiliaryHomePage';
import StudentLayout from '@/components/layout/StudentLayout';
import ParentLayout from '@/components/layout/ParentLayout';

const Placeholder = ({ title }: { title: string }) => (
  <div className="p-8 text-[var(--text-primary)]">
    <h1 className="text-2xl font-bold mb-4">{title}</h1>
    <p className="text-[var(--text-secondary)]">原型占位：此页面正在设计中...</p>
  </div>
);

const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/login" replace />,
  },
  {
    path: '/login',
    element: <LoginPage />,
  },
  // 入口选择页（独立全屏，登录后落地，主轨/辅轨分流）
  {
    path: '/student/entry',
    element: <EntrySelectPage />,
  },
  // 学科选择（独立全屏页，不在布局内）
  {
    path: '/student/subjects',
    element: <SubjectSelectPage />,
  },
  // 星图导航（独立全屏页，不在布局内）
  {
    path: '/student/star-map',
    element: <StarMapPage />,
  },
  // 课程详情/卡片阅读 P2.2（全屏沉浸层，隐藏侧边栏）
  {
    path: '/student/course-detail',
    element: <CourseDetailPage />,
  },
  // 辅线答疑轨（全屏沉浸层，独立于 StudentLayout，物理隔离）
  { path: '/student/auxiliary', element: <AuxiliaryHomePage /> },
  { path: '/student/auxiliary/selector', element: <Placeholder title="知识点选择器 P3.2" /> },
  { path: '/student/auxiliary/ask', element: <Placeholder title="拍照/输入答疑 P3.3" /> },
  { path: '/student/auxiliary/chat', element: <Placeholder title="辅线对话 P3.4" /> },
  {
    path: '/parent',
    element: <ParentLayout />,
    children: [
      { path: '', element: <Navigate to="/parent/dashboard" replace /> },
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
    element: <StudentLayout />,
    children: [
      { path: '', element: <Navigate to="/student/star-map" replace /> },
      { path: 'ai-discuss', element: <Placeholder title="AI 讨论 P2.3" /> },
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
