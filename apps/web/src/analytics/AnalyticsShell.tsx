import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useLearnContextStore } from '@/store/learnContextStore';
import { mapScene } from './sceneMap';
import * as tracker from './tracker';

/**
 * 埋点全局壳（spec §7.2）。
 *
 * **不是** `App.tsx`：那个组件在 `RouterProvider` **之外**，拿不到 `useLocation`。
 * 正确落点是在 `createBrowserRouter` 的根上包一层 **pathless wrapper route**——
 * 这样它同时覆盖布局页（`StudentLayout` 下的）与全屏沉浸页（训练/考试/课程详情都不在
 * `StudentLayout` 下），也覆盖 `RequireRole` 之下的一切。
 *
 * `routeTable.tsx` **不改**：它的测试用 `createMemoryRouter(routes)` 直接挂真实表，
 * 往里加组件会破坏「纯配置」的约束。
 *
 * 副作用共三段 effect。其中**前两段有顺序依赖，不能颠倒**：
 * 1. 先配好 subjectId 提供者；
 * 2. 再按路由变化补角色闸门并驱动会话（若反了，首个路由变化会因为 `enabled=false` 被丢掉）。
 * 第三段挂 visibility / pagehide / 输入事件监听，与前两段无顺序关系。
 */
export default function AnalyticsShell() {
  const location = useLocation();

  useEffect(() => {
    tracker.setSubjectIdProvider(() => useLearnContextStore.getState().subjectId);
    // 卸载收尾：把在跑的会话收掉。已知 dev-only 假象 —— `<StrictMode>`（仅开发构建）
    // 会双跑 effect，这次清理会顺手抹掉去重键，于是每次进场出现一轮 start/end/start；
    // 生产构建不双跑，**有意不在这里绕**。
    return () => tracker.setEnabled(false);
  }, []);

  useEffect(() => {
    // 角色闸门放在**路由 effect** 里，而不是挂载 effect —— 这是有意的，别改回去：
    // 本壳是路由根元素，一次页面加载只挂载一次；而登录是**客户端导航**
    // （LoginPage 写入 userRole 后直接 navigate，页面不刷新）。
    // 若只在挂载时读一次 userRole，「从登录页进来」的学生在整个浏览器会话里
    // enabled 恒为 false，`onRouteChange` 第一行就 return —— 学习时长**完全不计**，
    // 而这正是本批要产出的指标。放在这里，登录后的第一次路由变化就把闸门补上。
    // 反向同理：退出登录（同样不刷新）后立刻置回 false，并收掉在跑的会话。
    tracker.setEnabled(localStorage.getItem('userRole') === 'student');
    tracker.onRouteChange(mapScene(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    const onVisibility = () => tracker.setVisibility(document.visibilityState === 'visible');
    const onPageHide = () => tracker.onPageHide();
    const onInput = () => tracker.notifyInput();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pointerdown', onInput, { passive: true });
    window.addEventListener('keydown', onInput);
    window.addEventListener('scroll', onInput, { passive: true });
    window.addEventListener('touchstart', onInput, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('scroll', onInput);
      window.removeEventListener('touchstart', onInput);
    };
  }, []);

  return <Outlet />;
}
