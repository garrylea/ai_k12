import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { MOBILE_VIEWPORT_BREAKPOINT } from '@/constants';

/**
 * 桌面家长台的窄屏守卫：已登录家长在手机竖屏（<768px）打开 /parent/* 时，
 * 自动跳到移动路由组 /m/parent/*——否则桌面页在手机上挤着「能用」，家长永远
 * 不会走到登录分流，也就永远看不到移动版（2026-10-02 用户实测报回，
 * 推翻 spec 原「手机上不强制跳转」裁决；iPad/PC 横屏 ≥768px 不受影响）。
 *
 * 只在渲染前判断一次：视口从窄变宽（旋转/拉窗口）后家长留在移动版，
 * 想回桌面版刷新或重新从桌面进即可——不做双向监听，避免旋转时来回弹。
 */
const MOBILE_SUPPORTED = new Set(['dashboard', 'alerts', 'errors', 'controls']);
/** 「更多」占位页里登记过名目的桌面功能段。 */
const MORE_ITEMS = new Set(['subscription', 'points', 'report', 'chat-logs', 'goals', 'messages', 'students', 'account']);

export function mobileParentPath(pathname: string): string {
  const seg = pathname.replace(/^\/parent\/?/, '').split('/')[0];
  if (MOBILE_SUPPORTED.has(seg)) return `/m/parent/${seg}`;
  if (seg === 'rewards') return '/m/parent/more/points';
  if (MORE_ITEMS.has(seg)) return `/m/parent/more/${seg}`;
  return '/m/parent/more/students';
}

export default function ParentViewportGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  if (window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT) {
    return <Navigate to={mobileParentPath(pathname)} replace />;
  }
  return <>{children}</>;
}
