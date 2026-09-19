import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import AnalyticsShell from '../analytics/AnalyticsShell';

/**
 * 路由引导：真正的路由表在 `./routeTable`（单独成文件是为了让路由级测试能用
 * `createMemoryRouter(routes)` 直接挂载真实表；本文件只保留浏览器 router 单例）。
 *
 * `AnalyticsShell` 是 **pathless wrapper**（无 `path`、渲染 `<Outlet/>`）：
 * 包在真实路由表外面，就能拿到 `useLocation` 而**不修改** `routeTable.tsx`。
 * 它必须在这里、而不是 `App.tsx`——后者在 `RouterProvider` 之外。
 */
const router = createBrowserRouter([{ element: <AnalyticsShell />, children: routes }]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
