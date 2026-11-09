'use strict';

/**
 * 学生模式的全屏守护（2026-11-04，2026-11-09 修补）。
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
 *      true，此时 `setKiosk(true)` 是空操作；只补 `setFullScreen(true)` 得到的是普通全屏。
 *
 * **2026-11-09 真机实测（孩子用 Siri 之后就能 Cmd+Tab 切走）**——两条关键事实：
 *
 *   A. 挡 Cmd+Tab 的不是「全屏」，是 kiosk 设置的 `NSApplicationPresentationOptions`
 *      （实测生效值 = 506，含 `DisableProcessSwitching`）。这组选项是 **app 级**的：
 *      App 一旦失活就被系统收回，**`app.focus({ steal: true })` 把前台抢回来也不会恢复**
 *      （实测：抢回后 front=Electron 但 options=0）。所以「只是失焦」也必须完整重进 kiosk ——
 *      这正是 11-04 版守护漏掉的分支（当时还写了一条"失焦不重进、免得闪"的测试，是错的）。
 *   B. **`setKiosk(false)` 之后必须等退出全屏动画真正结束**（实测约 105ms）再
 *      `setKiosk(true)`：连着调两次时，第二次进入时 `IsWindowFullScreen()` 仍是 true，
 *      Electron 会直接 return，presentation options 永远不会被重新设置
 *      （实测 back-to-back 重进后 options 恒为 0，kiosk/fullscreen 标志却都是 true）。
 *
 * 所以这里做的是「**被打断后自动恢复**」：看门狗每秒检查一次，事件发生时就近调度恢复，
 * 重进时按 A/B 两条走完整流程。恢复后学生最多看到约 1 秒的桌面，无法停在其他应用里。
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
/** 进入全屏是异步动画：动画走完再抢焦点/钉窗口能力，否则会被下一次状态覆盖。 */
const DEFAULT_ENTER_SETTLE_MS = 1200;
/** 轮询「退出全屏动画结束」的间隔与超时。 */
const REENTER_POLL_MS = 100;
const REENTER_TIMEOUT_MS = 4000;

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
 * @param {number} [deps.enterSettleMs] 进入全屏后等待动画结束的时间
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
  enterSettleMs = DEFAULT_ENTER_SETTLE_MS,
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
  /** 正在「退出 → 重进 kiosk」的整个异步过程中：期间所有事件都忽略，避免自激。 */
  let reentering = false;
  /** 重进流程里的两个定时器：stop() 必须一并清掉，否则家长登录后还会被回调钉窗口能力。 */
  let reenterPollTimer = null;
  let reenterSettleTimer = null;

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
    if (!state) return `state=null${extra}`;
    return `visible=${state.visible} focused=${state.focused} kiosk=${state.kiosk} fullscreen=${state.fullscreen}${extra}`;
  }

  /**
   * **完整重进 kiosk**（不是只补 `setFullScreen(true)`）。
   *
   * ⚠️ 不能只调 `setKiosk(true)`：Electron 的 `NativeWindowMac::SetKiosk` 在
   * `is_kiosk_` 已为 true 时直接 return，而 `isKiosk()` 返回的就是这个内部标志。
   * Siri / 系统把窗口踢出全屏后它常常仍是 true，于是 `setKiosk(true)` 是个**空操作**。
   *
   * ⚠️ **也不能 `setKiosk(false)` 之后立刻 `setKiosk(true)`**（2026-11-09 实测）：
   * 退出全屏是异步动画（约 100ms），第二次 `setKiosk(true)` 时 `IsWindowFullScreen()`
   * 仍是 true，Electron 直接 return —— 窗口最后确实回到全屏，但
   * `NSApplicationPresentationOptions`（Dock / 菜单栏 / **Cmd+Tab** 的封锁）**永远不会被设置**，
   * 于是"看着是全屏，其实能切走"。必须先轮询到 `isFullScreen()` 为 false 再重进。
   */
  function reenterKiosk(win, reason) {
    if (reentering) return;
    reentering = true;
    const started = now();
    log(`[guard] reenter-start reason=${reason} ${describe(snapshot())}`);

    /** 进入 kiosk，并在异步的进入动画结束后钉窗口能力、抢一次焦点。 */
    function enterPhase(exitedFullscreen) {
      try {
        win.setKiosk(true);
      } catch (err) {
        reentering = false;
        log(`[guard] reenter-error reason=${reason} stage=enter err=${err && err.message}`);
        return;
      }

      reenterSettleTimer = setTimeoutFn(() => {
        reenterSettleTimer = null;
        // 这期间学生可能已登出（家长登录）：角色变了就什么都别做。
        if (!isEnabled()) {
          reentering = false;
          log(`[guard] reenter-abort reason=${reason} stage=settle`);
          return;
        }
        try {
          win.setClosable(false);
          win.setMinimizable(false);
          if (!win.isFullScreen()) win.setFullScreen(true); // 兜底：防「标志 true 但停在普通窗口」
          if (platform === 'darwin' && !win.isFocused()) focusApp();
        } catch (err) {
          log(`[guard] reenter-error reason=${reason} stage=settle err=${err && err.message}`);
        }
        reentering = false;
        log(
          `[guard] reenter-done reason=${reason} exitedFullscreen=${exitedFullscreen} ${describe(snapshot())}`,
        );
      }, enterSettleMs);
    }

    // 本来就不在 kiosk（启动竞态 / 刚登录）：没有「退出」这一步可走，直接进。
    // 这一步很重要：kiosk 已经是 false 时 setKiosk(false) 是空操作，而窗口可能正在
    // 异步进入全屏 → 下面的轮询会一直读到 fullscreen=true、白等 4 秒超时。
    let wasKiosk = false;
    try {
      wasKiosk = win.isKiosk();
    } catch {
      wasKiosk = false;
    }
    if (!wasKiosk) {
      enterPhase(false);
      return;
    }

    try {
      win.setKiosk(false);
    } catch (err) {
      reentering = false;
      log(`[guard] reenter-error reason=${reason} stage=exit err=${err && err.message}`);
      return;
    }

    const poll = setIntervalFn(() => {
      if (!isEnabled()) {
        clearIntervalFn(poll);
        reenterPollTimer = null;
        reentering = false;
        log(`[guard] reenter-abort reason=${reason} stage=exit`);
        return;
      }
      let fullscreen = true;
      try {
        fullscreen = win.isFullScreen();
      } catch {
        // 读不到就当作还在全屏，等超时兜底。
      }
      if (fullscreen && now() - started < REENTER_TIMEOUT_MS) return;
      clearIntervalFn(poll);
      reenterPollTimer = null;
      enterPhase(!fullscreen);
    }, REENTER_POLL_MS);
    reenterPollTimer = poll;
  }

  /**
   * 调度一次恢复。**只有在真的不健康时才排队**，健康状态下什么都不做
   * —— 否则每次 `show` / `focus` 事件都会触发一次无意义的恢复。
   */
  function schedule(reason) {
    if (!isEnabled() || reentering) return;
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
   * **激活后无条件重进 kiosk**（2026-11-09 新增）。
   *
   * 为什么不能走 `schedule()`：失活期间系统收走了 presentation options，
   * 但 `isVisible/isFocused/isKiosk/isFullScreen` 四项**全都是 true** —— `healthy()` 判定"健康"，
   * 于是永远不重进，Cmd+Tab 就一直可用（真机复现路径：Siri → 回来 → Cmd+Tab 能切走）。
   * 所以「App 从后台回到前台」这件事本身就是重进的触发条件，不看那四个标志。
   */
  function scheduleReassert(reason) {
    if (!isEnabled() || reentering || restoreTimer) return;
    if (now() < restoreUntil) return;
    restoreUntil = now() + cooldownMs; // 与 restore 共用冷却，避免两条路径同时抢窗口

    const state = snapshot();
    if (!state) return;
    log(`[guard] reassert reason=${reason} ${describe(state)}`);

    restoreTimer = setTimeoutFn(() => {
      restoreTimer = null;
      if (!isEnabled() || reentering) return;
      const cur = snapshot();
      if (!cur) return;
      try {
        if (!cur.visible) cur.win.show();
        // 先激活再重进：App 不是前台时，setKiosk 设置的 presentation options 不会生效。
        if (platform === 'darwin') focusApp();
        if (!cur.focused) cur.win.focus();
      } catch { /* 激活失败也要继续尝试重进 */ }
      reenterKiosk(cur.win, reason);
    }, restoreDelayMs);
  }

  /** 立即执行一次恢复（仍受冷却期约束）。 */
  function restore(reason) {
    if (!isEnabled() || reentering) return;
    if (now() < restoreUntil) return;
    const state = snapshot();
    if (!state || healthy(state)) return;

    restoreUntil = now() + cooldownMs;
    log(`[guard] restore reason=${reason} ${describe(state)}`);

    try {
      if (!state.visible) state.win.show();

      // macOS：必须先激活 App，`win.focus()` 单独做不到（见文件头）。
      if (platform === 'darwin' && !state.focused) focusApp();

      // ⚠️ **macOS 的失焦也要重进**（2026-11-09 实测）：presentation options 是 app 级的，
      // 失活就被系统收回，抢回焦点不会自动恢复 —— 只补焦点会留下「全屏但能 Cmd+Tab」。
      // Windows/Linux 没有这个问题（kiosk 只是全屏），重进等于每次切回来都闪一下，不做。
      const lostPresentationOptions = platform === 'darwin' && !state.focused;
      const needsReenter = !state.fullscreen || lostPresentationOptions;
      if (needsReenter) {
        if (state.focused) {
          reenterKiosk(state.win, reason);
        } else {
          // 抢焦距是异步的：等一拍再重进，否则 setKiosk(false) 可能落在失活状态下。
          setTimeoutFn(() => {
            if (!isEnabled()) return;
            const cur = snapshot();
            if (!cur) return;
            reenterKiosk(cur.win, reason);
          }, restoreDelayMs);
        }
      } else if (!state.kiosk) {
        // 全屏和焦点都在、只有 kiosk 标志掉了：补一次 kiosk 即可重新应用 presentation options。
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
    if (!isEnabled() || reentering) return;
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
    if (reenterPollTimer) {
      clearIntervalFn(reenterPollTimer);
      reenterPollTimer = null;
    }
    if (reenterSettleTimer) {
      clearTimeoutFn(reenterSettleTimer);
      reenterSettleTimer = null;
    }
    pendingReason = null;
    restoreUntil = 0;
    reentering = false;
  }

  return { start, stop, schedule, scheduleReassert, restore, tick, isRunning: () => watchdogTimer !== null };
}

module.exports = {
  createKioskGuard,
  DEFAULT_RESTORE_DELAY_MS,
  DEFAULT_WATCHDOG_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_ENTER_SETTLE_MS,
};
