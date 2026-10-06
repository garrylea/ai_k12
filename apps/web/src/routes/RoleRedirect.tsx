import { Navigate } from 'react-router-dom';
import { clearAuth, isSessionValid } from '@/utils/auth';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

/** 根路径按登录角色分流：admin -> /admin，parent -> 按视口（窄屏移动版/宽屏桌面台），student -> 入口选择页。 */
export default function RoleRedirect() {
  // token 缺失或已过期：清掉残留角色，一律回登录页
  if (!isSessionValid()) {
    clearAuth();
    return <Navigate to="/login" replace />;
  }
  const role = localStorage.getItem('userRole');
  if (role === 'admin') return <Navigate to="/admin" replace />;
  if (role === 'parent') {
    // 窄屏走移动家长台（与 LoginPage 登录落点同口径）；不做双向监听（见 ParentViewportGate）
    return <Navigate to={window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT ? '/m/parent' : '/parent/students'} replace />;
  }
  if (role === 'student') return <Navigate to="/student/entry" replace />;
  return <Navigate to="/login" replace />;
}
