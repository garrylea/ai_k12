import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';

/**
 * 路由引导：真正的路由表在 `./routeTable`（单独成文件是为了让路由级测试能用
 * `createMemoryRouter(routes)` 直接挂载真实表；本文件只保留浏览器 router 单例）。
 */
const router = createBrowserRouter(routes);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
