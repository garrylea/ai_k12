'use strict';

/**
 * 学生模式的全屏守护（2026-11-04）。
 *
 * **要解决的问题**：Siri / 通知 / Mission Control / 切 Space 等系统行为会打断
 * kiosk（窗口退出全屏，或窗口还在但别的 App 在前台）。这些行为**拦不住** ——
 * 应用层无解，真·无法切屏靠 OS 级单应用模式（spec §8 局限 1）。
 * 但「打断之后回不来」是我们自己的洞：
 *
 *   1. `LearningSessionShell` 只在**角色变化**时推一次 `setStudentMode(true)`，
 *      之后没有任何地方重新进 kiosk；
 *   2. macOS 上 `win.focus()` **不会**从别的 App 抢回激活，必须 `app.focus({ steal: true })`；
 *   3. **最隐蔽的一条（2026-11-05 用户实测发现）**：被踢出全屏后 `isKiosk()` 仍可能是
 *      true，此时 `setKiosk(true)` 是空操作；只补 `setFullScreen(true)` 得到的是普通全屏，
 *      Dock / 菜单栏 / Cmd+Tab 全部回来了。必须 `setKiosk(false) → setKiosk(true)` 完整重进。
 *
 * 所以这里做的是「**被打断后自动恢复**」：看门狗每秒检查一次，事件发生时就近调度恢复；
 * 恢复后学生最多看到约 1 秒的桌面，无法停在其他应用里。
 *
 * ⚠️ **不要改成 `setAlwaysOnTop`**：那会盖住 UAC / 系统安全对话框，
 * 风险大于收益（spec §6.1 的裁决，见 `main.js` 原来的 `blur` 注释）。
 * ⚠️ **不要删掉 `app.focus({ steal: true })` 这层**（由调用方注入）：
 * macOS 的 `win.focus()` 只聚焦窗口、不激活 App，单独的 `win.focus()` 抢不回前台。
 */

const DEFAULT_RESTORE_DELAY_MS = 300;
const DEFAULT_WATCHDOG_MS = 1000;
/** 恢复动作本身要进/出全屏动画，冷却期内不再重复触发，避免抖动。 */
const DEFAULT_COOLDOWN_MS = 1500;

/**
 * @param {object} deps
 * @param {() => boolean} deps.isEnabled 当前是否是学生模式
 * @param {() => object|null} deps.getWindow 返回 BrowserWindow（已销毁/不存在返回 null）
 * @param {string} deps.platform `process.platform`
 * @param {() => void} deps.focusApp 激活整个 App（macOS 传 `() => app.focus({ steal: true })`）
 * @param {(message: string) => void} [deps.log] 事件日志
 * @param {() => object} [deps.diagnostics] 额外现场状态（app 是否 active、窗口/显示器尺寸等），只写日志
 * @param {object} [deps.timers] 可注入定时器（测试用）
 * @param {function} [deps.timers.setTimeout]
 * @param {function} [deps.timers.clearTimeout]
 * @param {function} [deps.timers.setInterval]
 * @param {function} [deps.timers.clearInterval]
 * @param {() => number} [deps.timers.now]
 * @param {number} [deps.restoreDelayMs] 事件触发到实际恢复的延迟
 * @param {number} [deps.watchdogMs] 看门狗间隔
 * @param {number} [deps.cooldownMs] 两次恢复之间的最小间隔
 */
function createKioskGuard({
  isEnabled,
  getWindow,
  platform,
  focusApp,
  log = () => {},
  diagnostics = () => ({}),
  timers = {},
  restoreDelayMs = DEFAULT_RESTORE_DELAY_MS,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
}) {
  const setTimeoutFn = timers.setTimeout || setTimeout;
  const clearTimeoutFn = timers.clearTimeout || clearTimeout;
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;
  const now = timers.now || Date.now;

  /** 看门狗 interval。 */
  let watchdogTimer = null;
  /** 尚未执行的恢复（事件触发后延迟一点，避开全屏动画）。 */
  let restoreTimer = null;
  let pendingReason = null;
  /** 冷却截止时间：恢复动作后的这段时间内不再重复恢复。 */
  let restoreUntil = 0;

  function snapshot() {
    const win = getWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
    try {
      return {
        win,
        visible: win.isVisible(),
        focused: win.isFocused(),
        kiosk: win.isKiosk(),
        fullscreen: win.isFullScreen(),
      };
    } catch {
      // 窗口正在销毁：这一轮当作「没有窗口」，下一轮再看。
      return null;
    }
  }

  function healthy(state) {
    return state.visible && state.focused && state.kiosk && state.fullscreen;
  }

  function describe(state) {
    // 现场诊断：Siri 打断时窗口状态到底如何，靠这份日志事后判读（见 main.js 的 diagnostics）。
    // 失败一律忽略 —— 日志永远不该影响恢复动作。
    let extra = '';
    try {
      const d = diagnostics();
      const pairs = Object.entries(d).map(([k, v]) => `${k}=${v}`);
      if (pairs.length) extra = ` ${pairs.join(' ')}`;
    } catch { /* ignore */ }
    return `visible=${state.visible} focused=${state.focused} kiosk=${state.kiosk} fullscreen=${state.fullscreen}${extra}`;
  }

  /**
   * 调度一次恢复。**只有在真的不健康时才排队**，健康状态下什么都不做
   * —— 否则每次 `show` / `focus` 事件都会触发一次无意义的恢复。
   */
  function schedule(reason) {
    if (!isEnabled()) return;
    const state = snapshot();
    if (!state || healthy(state)) return;
    if (restoreTimer) return;

    pendingReason = reason;
    log(`[guard] schedule reason=${reason} ${describe(state)}`);
    restoreTimer = setTimeoutFn(() => {
      restoreTimer = null;
      const pending = pendingReason;
      pendingReason = null;
      restore(pending);
    }, restoreDelayMs);
  }

  /**
   * **完整重进 kiosk**（不是只补 `setFullScreen(true)`）。
   *
   * ⚠️ 不能只调 `setKiosk(true)`：Electron 的 `NativeWindowMac::SetKiosk` 在
   * `is_kiosk_` 已为 true 时直接 return（`shell/browser/native_window_mac.mm:1134`），
   * 而 `isKiosk()` 返回的就是这个内部标志。Siri / 系统把窗口踢出全屏后它常常仍是
   * true，于是 `setKiosk(true)` 是个**空操作** —— 这正是「抢回焦点了却没回全屏」的根因。
   * 更关键的是：隐藏 Dock / 菜单栏 / 禁 Cmd+Tab 那组 `NSApplicationPresentationOptions`
   * 只在 `false → true` 这一次设置；光 `setFullScreen(true)` 只会得到普通全屏，
   * Dock 和 Cmd+Tab 全回来了，等于没锁。
   *
   * 所以必须 `false → true` 走一遍。末尾再补一次 `setFullScreen(true)` 是兜底：
   * 退出全屏是异步动画，若 `setKiosk(true)` 读到的 styleMask 仍是 fullscreen，
   * 它会跳过 `SetFullScreen(true)`，动画结束后就变成「kiosk 标志 true + 普通窗口」；
   * 补这一下能把「进全屏」排进 Electron 的过渡队列。
   */
  function forceReenterKiosk(win) {
    win.setKiosk(false);
    win.setKiosk(true);
    win.setFullScreen(true);
    // 切换期间窗口能力可能被系统改回，按 applyStudentMode 的同一口径重新钉死。
    win.setClosable(false);
    win.setMinimizable(false);
  }

  /** 立即执行一次恢复（仍受冷却期约束）。 */
  function restore(reason) {
    if (!isEnabled()) return;
    if (now() < restoreUntil) return;
    const state = snapshot();
    if (!state || healthy(state)) return;

    restoreUntil = now() + cooldownMs;
    log(`[guard] restore reason=${reason} ${describe(state)}`);

    try {
      if (!state.visible) state.win.show();

      // macOS：必须先激活 App，`win.focus()` 单独做不到（见文件头）。
      if (platform === 'darwin' && !state.focused) focusApp();

      if (!state.fullscreen) {
        // 真的被踢出全屏了：完整重进 kiosk，重新拿回 Dock/菜单栏/进程切换的封锁。
        forceReenterKiosk(state.win);
      } else if (!state.kiosk) {
        // 全屏还在、kiosk 标志掉了：补一次 kiosk 即可重新应用 presentation options。
        state.win.setKiosk(true);
      }

      if (!state.focused) {
        state.win.focus();
        // focus() 在部分窗口管理器上不会抬 Z 序，补一次；这不是 alwaysOnTop。
        state.win.moveTop();
      }
    } catch (err) {
      log(`[guard] restore-error reason=${reason} err=${err && err.message}`);
    }
  }

  /** 看门狗的一拍：任何一项不健康就排队恢复（覆盖没有事件可听的打断方式）。 */
  function tick() {
    if (!isEnabled()) return;
    const state = snapshot();
    if (!state) return;
    if (!healthy(state)) schedule('watchdog');
  }

  /** 开始守护（学生模式开启 / 窗口重新创建时调用；重复调用无副作用）。 */
  function start() {
    if (watchdogTimer) return;
    // 刻意不在这里立即 tick：setKiosk 是异步进入全屏的，刚调用完就检查会误判成「掉了」。
    watchdogTimer = setIntervalFn(tick, watchdogMs);
  }

  /** 停止守护（学生模式关闭 / 窗口销毁时调用）。 */
  function stop() {
    if (watchdogTimer) {
      clearIntervalFn(watchdogTimer);
      watchdogTimer = null;
    }
    if (restoreTimer) {
      clearTimeoutFn(restoreTimer);
      restoreTimer = null;
    }
    pendingReason = null;
    restoreUntil = 0;
  }

  return { start, stop, schedule, restore, tick, isRunning: () => watchdogTimer !== null };
}

module.exports = {
  createKioskGuard,
  DEFAULT_RESTORE_DELAY_MS,
  DEFAULT_WATCHDOG_MS,
  DEFAULT_COOLDOWN_MS,
};
