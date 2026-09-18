import { Navigate } from 'react-router-dom';
import { clearAuth, isSessionValid } from '@/utils/auth';

/** 根路径按登录角色分流：admin -> /admin，parent -> /parent/students，student -> 入口选择页。 */
export default function RoleRedirect() {
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
}
