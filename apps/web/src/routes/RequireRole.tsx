import { Navigate } from 'react-router-dom';
import type { ReactElement } from 'react';

/** 前端路由守卫：role 不匹配重定向登录页（越权防护以后端 Guard 为准，此处仅 UX）。 */
export default function RequireRole({
  role,
  children,
}: {
  role: 'admin' | 'parent' | 'student';
  children: ReactElement;
}) {
  const userRole = localStorage.getItem('userRole');
  if (userRole !== role) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
