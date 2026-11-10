import { useCallback, useEffect, useRef, useState } from 'react';
import { LockedPill } from './LockedPill';
import { useLearningLock } from './learningLockContext';

/** 进入浅停留页自动显示时长。 */
export const AUTO_SHOW_MS = 3000;
/** 点击/轻触识别区后的显示时长（触屏没有 hover）。 */
export const TAP_SHOW_MS = 5000;
/** 鼠标移出识别区后的收起延迟，防手抖。 */
export const HOVER_HIDE_DELAY_MS = 200;

/**
 * 剩余时长的"按需唤出"层（spec 2026-11-10 §2）。
 *
 * **为什么要藏**：胶囊以前是全局常驻、`top-3` 贴在顶栏里，正好压住个人中心的
 * 奖励册/个人中心/练习记录三个 tab，学生点不到练习记录（用户实测）。
 * 现在只在浅停留页出现，进入 3 秒 / 顶边悬停 / 点击 5 秒三种方式唤出。
 *
 * ⚠️ 识别区只覆盖窗口顶部 10px：顶栏里的 tab 从约 16px 起、右上"退出本页"从约 11px 起
 * （42px 高，居中于 64px 顶栏），都在它下面，不会被抢点击；两者只差约 1px。
 * 改高度前先重新量这两个位置。
 */
export function LockedPillReveal() {
  const lock = useLearningLock();
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const hovering = useRef(false);

  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showFor = useCallback(
    (ms: number) => {
      clearHide();
      setVisible(true);
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        // 悬停期间不自动收：否则鼠标一直停在顶边，提示却每 3 秒闪一次。
        if (!hovering.current) setVisible(false);
      }, ms);
    },
    [clearHide],
  );

  const locked = lock?.locked === true;

  useEffect(() => {
    if (locked) showFor(AUTO_SHOW_MS);
    else setVisible(false);
    return clearHide;
  }, [locked, showFor, clearHide]);

  if (!lock?.locked) return null;

  return (
    <>
      <button
        type="button"
        data-testid="pill-reveal-zone"
        aria-label="查看本次学习剩余时间"
        className="fixed inset-x-0 top-0 z-40 h-2.5 bg-transparent"
        onMouseEnter={() => {
          hovering.current = true;
          clearHide();
          setVisible(true);
        }}
        onMouseLeave={() => {
          hovering.current = false;
          showFor(HOVER_HIDE_DELAY_MS);
        }}
        onFocus={() => showFor(TAP_SHOW_MS)}
        onClick={() => {
          // 触屏会先补一个 mouseenter（之后没有 mouseleave）：不清掉悬停标记
          // 的话，点击的 5 秒定时器会被 `!hovering` 判据挡掉，胶囊永远不消失。
          hovering.current = false;
          showFor(TAP_SHOW_MS);
        }}
      />
      <LockedPill remainingMs={lock.remainingMs} visible={visible} />
    </>
  );
}
