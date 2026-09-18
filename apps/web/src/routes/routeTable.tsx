import { Navigate, type RouteObject } from 'react-router-dom';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import SubjectSelectPage from '@/pages/auth/SubjectSelectPage';
import EntrySelectPage from '@/pages/auth/EntrySelectPage';
import StarMapPage from '@/pages/student/StarMapPage';
import CourseDetailPage from '@/pages/student/CourseDetailPage';
import AuxiliaryHomePage from '@/pages/student/AuxiliaryHomePage';
import ConversationManagePage from '@/pages/student/ConversationManagePage';
import TrainingSubjectPage from '@/pages/student/TrainingSubjectPage';
import ProfilePage from '@/pages/student/ProfilePage';
import RewardsPage from '@/pages/student/RewardsPage';
import TrainingHomePage from '@/pages/student/training/TrainingHomePage';
import ErrorPracticePage from '@/pages/student/training/ErrorPracticePage';
import ErrorPracticeRunPage from '@/pages/student/training/ErrorPracticeRunPage';
import TargetedConfigPage from '@/pages/student/training/TargetedConfigPage';
import TargetedRunPage from '@/pages/student/training/TargetedRunPage';
import HiddenQuestionsPage from '@/pages/student/training/HiddenQuestionsPage';
import ChineseSpecialPage from '@/pages/student/training/chinese/ChineseSpecialPage';
import DictationConfigPage from '@/pages/student/training/chinese/DictationConfigPage';
import DictationRunPage from '@/pages/student/training/chinese/DictationRunPage';
import InterpretationConfigPage from '@/pages/student/training/chinese/InterpretationConfigPage';
import InterpretationRunPage from '@/pages/student/training/chinese/InterpretationRunPage';
import MeaningConfigPage from '@/pages/student/training/chinese/MeaningConfigPage';
import MeaningRunPage from '@/pages/student/training/chinese/MeaningRunPage';
import VocabularyConfigPage from '@/pages/student/training/english/VocabularyConfigPage';
import VocabularyRunPage from '@/pages/student/training/english/VocabularyRunPage';
import ExamListPage from '@/pages/student/training/ExamListPage';
import ExamRunPage from '@/pages/student/training/ExamRunPage';
import ExamResultPage from '@/pages/student/training/ExamResultPage';
import StudentLayout from '@/components/layout/StudentLayout';
import StudentStayLayout from '@/components/layout/StudentStayLayout';
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
import RoleRedirect from './RoleRedirect';
import { Placeholder } from './Placeholder';

/**
 * 真实路由表（纯配置，**不定义组件**：本文件只导出 `routes`，路由级测试用
 * `createMemoryRouter(routes)` 直接挂载它，钉住「某个路径确实指向某个页面」。
 * 浏览器 router 单例在 `index.tsx`；`Placeholder` / `RoleRedirect` 各自单独成文件。
 */
export const routes: RouteObject[] = [
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
  // 训练轨（全屏沉浸层，独立于 StudentLayout，物理隔离；三轨入口之一）
  {
    path: '/student/training',
    element: (
      <RequireRole role="student">
        <TrainingSubjectPage />
      </RequireRole>
    ),
  },
  // 训练三卡选择页（PRD §6.3 三类训练并列：专项/考试/错题；选完学科后的落地页）
  {
    path: '/student/training/home',
    element: (
      <RequireRole role="student">
        <TrainingHomePage />
      </RequireRole>
    ),
  },
  // 错题练习列表页（全屏沉浸层，独立于 StudentLayout，与 /student/training 同层）
  {
    path: '/student/training/errors',
    element: (
      <RequireRole role="student">
        <ErrorPracticePage />
      </RequireRole>
    ),
  },
  // 错题练习答题页（全屏沉浸层；题单经 sessionStorage 交接，空题单自动踢回列表页）
  {
    path: '/student/training/errors/run',
    element: (
      <RequireRole role="student">
        <ErrorPracticeRunPage />
      </RequireRole>
    ),
  },
  // 专项练习配置页（全屏沉浸层，独立于 StudentLayout，与 errors 同层）
  {
    path: '/student/training/targeted',
    element: (
      <RequireRole role="student">
        <TargetedConfigPage />
      </RequireRole>
    ),
  },
  // 专项练习答题页（全屏沉浸层；题单经 sessionStorage 交接，空题单自动踢回配置页）
  {
    path: '/student/training/targeted/run',
    element: (
      <RequireRole role="student">
        <TargetedRunPage />
      </RequireRole>
    ),
  },
  // 专项练习「不再展示」清单页（全屏沉浸层，与 targeted 同层）
  {
    path: '/student/training/targeted/hidden',
    element: (
      <RequireRole role="student">
        <HiddenQuestionsPage />
      </RequireRole>
    ),
  },
  // 语文专项页（全屏沉浸层，独立于 StudentLayout；仅「古诗文默写」开放）
  {
    path: '/student/training/chinese/special',
    element: (
      <RequireRole role="student">
        <ChineseSpecialPage />
      </RequireRole>
    ),
  },
  // 语文默写配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/chinese/dictation',
    element: (
      <RequireRole role="student">
        <DictationConfigPage />
      </RequireRole>
    ),
  },
  // 语文默写答题页（全屏沉浸层；空题单自动踢回配置页）
  {
    path: '/student/training/chinese/dictation/run',
    element: (
      <RequireRole role="student">
        <DictationRunPage />
      </RequireRole>
    ),
  },
  // 语文解释配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/chinese/interpretation',
    element: (
      <RequireRole role="student">
        <InterpretationConfigPage />
      </RequireRole>
    ),
  },
  // 语文解释答题页（全屏沉浸层；逐句判题，空题单自动踢回配置页）
  {
    path: '/student/training/chinese/interpretation/run',
    element: (
      <RequireRole role="student">
        <InterpretationRunPage />
      </RequireRole>
    ),
  },
  // 语文含义配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/chinese/meaning',
    element: (
      <RequireRole role="student">
        <MeaningConfigPage />
      </RequireRole>
    ),
  },
  // 语文含义答题页（全屏沉浸层；一次一句，结果倒序堆叠，空题单自动踢回配置页）
  {
    path: '/student/training/chinese/meaning/run',
    element: (
      <RequireRole role="student">
        <MeaningRunPage />
      </RequireRole>
    ),
  },
  // 英语背单词配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/english/vocabulary',
    element: (
      <RequireRole role="student">
        <VocabularyConfigPage />
      </RequireRole>
    ),
  },
  // 英语背单词答题页（全屏沉浸层；提交即翻下一个词、判定异步回填，空题单自动踢回配置页）
  {
    path: '/student/training/english/vocabulary/run',
    element: (
      <RequireRole role="student">
        <VocabularyRunPage />
      </RequireRole>
    ),
  },
  // 考试试卷列表页（全屏沉浸层，独立于 StudentLayout，与 errors/targeted 同层）
  {
    path: '/student/training/exam',
    element: (      <RequireRole role="student">
        <ExamListPage />
      </RequireRole>
    ),
  },
  // 考试答题页（全屏沉浸层；新开卷经 sessionStorage 交接，刷新走服务端续考恢复，已交卷自动跳结果页）
  {
    path: '/student/training/exam/run/:sessionId',
    element: (
      <RequireRole role="student">
        <ExamRunPage />
      </RequireRole>
    ),
  },
  // 考试结果页（全屏沉浸层；mount 校验已交卷，未交卷踢回答题页）
  {
    path: '/student/training/exam/result/:sessionId',
    element: (
      <RequireRole role="student">
        <ExamResultPage />
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
  // 主轨侧栏外壳：留给 P2.4–P2.8 等学习/占位页（第 58 行「启用日夜切换」一类）
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
      // 学习设置 P5.3 已按用户裁决从学生端移除（不再有 /student/settings）。
    ],
  },
  // 浅停留页外壳（第 59 行「禁用夜间切换」）：个人中心/奖励册写死日间、无侧栏、无日夜切换。
  // 独立成顶层路由（而非继续挂在上面 `/student` 的 children），避免两条同 path 的
  // `/student` 路由同时声明造成匹配歧义。
  {
    path: '/student/profile',
    element: (
      <RequireRole role="student">
        <StudentStayLayout />
      </RequireRole>
    ),
    children: [{ index: true, element: <ProfilePage /> }],
  },
  {
    path: '/student/rewards',
    element: (
      <RequireRole role="student">
        <StudentStayLayout />
      </RequireRole>
    ),
    children: [{ index: true, element: <RewardsPage /> }],
  },
];
