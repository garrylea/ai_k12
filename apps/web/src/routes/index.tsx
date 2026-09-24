import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import AnalyticsShell from '../analytics/AnalyticsShell';
import LearningSessionShell from '../kiosk/LearningSessionShell';

/**
 * 路由引导：真正的路由表在 `./routeTable`（单独成文件是为了让路由级测试能用
 * `createMemoryRouter(routes)` 直接挂载真实表；本文件只保留浏览器 router 单例）。
 *
 * 两个 **pathless wrapper**（无 `path`、渲染 `<Outlet/>`）依次包在真实路由表外面。
 * 两者都必须在**这里**、而不是 `App.tsx`——后者在 `RouterProvider` 之外，拿不到 `useLocation`，
 * 而两者的角色闸门都依赖路由变化才能捕获「不刷新页面」的登录/登出。
 * 顺序无要求（都只读 localStorage），但别合并成一个组件：埋点与学习管控是两件事。
 */
const router = createBrowserRouter([
  {
    element: <AnalyticsShell />,
    children: [{ element: <LearningSessionShell />, children: routes }],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
