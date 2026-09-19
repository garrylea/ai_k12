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
 * 副作用分两段 effect，顺序不能颠倒：
 * 1. 先配好 enabled / transport / subjectId 提供者；
 * 2. 再按路由变化驱动会话（若反了，首个路由变化会因为 `enabled=false` 被丢掉）。
 */
export default function AnalyticsShell() {
  const location = useLocation();

  useEffect(() => {
    tracker.setSubjectIdProvider(() => useLearnContextStore.getState().subjectId);
    tracker.setEnabled(localStorage.getItem('userRole') === 'student');
    return () => tracker.setEnabled(false);
  }, []);

  useEffect(() => {
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
