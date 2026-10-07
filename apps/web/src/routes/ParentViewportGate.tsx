import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

const MOBILE_SUPPORTED = new Set(['dashboard', 'alerts', 'errors', 'controls', 'messages', 'students', 'goals', 'account', 'points', 'report', 'chat-logs']);
const MORE_STUBS = new Set(['subscription']);

/** 桌面家长路径 → 移动路径（2A 起支持带 id 的 config 子路径直跳）。 */
export function mobileParentPath(pathname: string): string {
  const rest = pathname.replace(/^\/parent\/?/, '');
  if (/^students\/\d+\/config$/.test(rest)) return `/m/parent/${rest}`;
  const seg = rest.split('/')[0];
  if (MOBILE_SUPPORTED.has(seg)) return `/m/parent/${seg}`;
  if (seg === 'rewards') return '/m/parent/points';
  if (MORE_STUBS.has(seg)) return `/m/parent/more/${seg}`;
  return '/m/parent/more/students';
}

/**
 * 桌面家长台的窄屏守卫：已登录家长在手机竖屏（<768px）打开 /parent/* 时，
 * 自动跳到移动路由组 /m/parent/*——否则桌面页在手机上挤着「能用」，家长永远
 * 不会走到登录分流，也就永远看不到移动版（2026-10-02 用户实测报回，
 * 推翻 spec 原「手机上不强制跳转」裁决；iPad/PC 横屏 ≥768px 不受影响）。
 *
 * 只在渲染前判断一次：视口从窄变宽（旋转/拉窗口）后家长留在移动版，
 * 想回桌面版刷新或重新从桌面进即可——不做双向监听，避免旋转时来回弹。
 */
export default function ParentViewportGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  if (window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT) {
    return <Navigate to={mobileParentPath(pathname)} replace />;
  }
  return <>{children}</>;
}
