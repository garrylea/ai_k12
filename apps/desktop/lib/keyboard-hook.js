'use strict';

/**
 * Windows 全局键盘钩子的薄封装（2026-11-09）。
 *
 * 原生实现在 `native/keyhook/`（WH_KEYBOARD_LL，学生模式下吞 Alt+Tab / Win / Alt+F4 /
 * Ctrl+Shift+Esc 等）。这里只做四件事，**都不该影响主流程**：
 *
 *   1. **平台守卫**：非 win32 根本不 `require` 原生模块（mac/linux 上没有那个 .node）。
 *   2. **失败降级**：缺 .node / ABI 不兼容 / SetWindowsHookEx 失败 → 只写日志，继续跑。
 *      管控失效好过孩子进不去（与 `kiosk-guard` 同一条纪律）。
 *   3. **跟随学生模式**：`setEnabled(true/false)` 与 `applyStudentMode` 一一对应。
 *   4. **健康检查**：每 5 秒确认钩子还在；线程意外死掉就重装（钩子没了等于没锁）。
 *
 * 依赖注入是为了单测：真机行为和原生编译只能由 CI 的 windows runner + 真机验收覆盖。
 */

/** 钩子线程意外退出后，最迟 5 秒内重装。 */
const DEFAULT_HEALTH_MS = 5000;

/**
 * @param {object} deps
 * @param {string} deps.platform `process.platform`
 * @param {() => object} [deps.load] 加载原生模块（只在 win32 下调用）
 * @param {(message: string) => void} [deps.log]
 * @param {object} [deps.timers] 可注入定时器（测试用）
 * @param {function} [deps.timers.setInterval]
 * @param {function} [deps.timers.clearInterval]
 * @param {number} [deps.healthMs]
 */
function createKeyboardHook({
  platform,
  load = () => require('../native/keyhook.node'),
  log = () => {},
  timers = {},
  healthMs = DEFAULT_HEALTH_MS,
}) {
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;

  /** 已加载的原生模块；null = 还没成功加载过。 */
  let mod = null;
  /** 加载失败后不再重试（每个角色切换都试一次只会刷日志）。 */
  let loadFailed = false;
  /** 当前是否应该拦截。 */
  let enabled = false;
  /** 健康检查定时器（enabled 时才存在）。 */
  let healthTimer = null;
  /** 启动失败日志只打一次，避免 5 秒一刷。 */
  let startFailLogged = false;

  function ensureModule() {
    if (platform !== 'win32') return null;
    if (mod) return mod;
    if (loadFailed) return null;
    try {
      const loaded = load();
      if (!loaded || typeof loaded.start !== 'function' || typeof loaded.stop !== 'function') {
        throw new Error('原生模块接口不完整（缺少 start/stop）');
      }
      mod = loaded;
      return mod;
    } catch (err) {
      loadFailed = true;
      mod = null;
      log(`[hook] load-failed err=${err && err.message}`);
      return null;
    }
  }

  function isActive(target) {
    try {
      return Boolean(target.isActive && target.isActive());
    } catch {
      return false;
    }
  }

  function apply(on) {
    const target = ensureModule();
    if (!target) return false;

    if (on) {
      if (isActive(target)) return true;
      let ok = false;
      try {
        ok = target.start() === true;
      } catch (err) {
        // 健康检查每 5 秒会重试；日志只打一次，别刷屏。
        if (!startFailLogged) {
          startFailLogged = true;
          log(`[hook] start-error err=${err && err.message}`);
        }
        return false;
      }
      if (!ok) {
        if (!startFailLogged) {
          startFailLogged = true;
          const code = typeof target.lastError === 'function' ? target.lastError() : '?';
          log(`[hook] start-failed code=${code}（管理系统快捷键不会被拦截）`);
        }
        return false;
      }
      startFailLogged = false;
      log('[hook] enabled');
      return true;
    }

    try {
      target.stop();
    } catch (err) {
      log(`[hook] stop-error err=${err && err.message}`);
    }
    log('[hook] disabled');
    return true;
  }

  function stopHealthTimer() {
    if (healthTimer) {
      clearIntervalFn(healthTimer);
      healthTimer = null;
    }
  }

  /** 每 5 秒确认钩子还活着；线程死了或从未装上就补一次。 */
  function healthTick() {
    if (!enabled) return;
    const target = ensureModule();
    if (!target) {
      stopHealthTimer();
      return;
    }
    if (isActive(target)) return;
    log('[hook] health: 钩子不在了，重新安装');
    apply(true);
  }

  /** 学生模式开关（与 `applyStudentMode` 一一对应）。 */
  function setEnabled(on) {
    const next = Boolean(on);
    if (next === enabled) return;
    enabled = next;

    if (platform !== 'win32') return; // 非 Windows：不加载、不装表

    apply(enabled);
    if (enabled) {
      stopHealthTimer();
      healthTimer = setIntervalFn(healthTick, healthMs);
    } else {
      stopHealthTimer();
    }
  }

  /** 立即确认/重装一次（唤醒、解锁后调用，不等 5 秒）。 */
  function reassert() {
    if (!enabled || platform !== 'win32') return;
    apply(true);
  }

  return {
    setEnabled,
    reassert,
    isRunning: () => enabled && mod !== null && isActive(mod),
  };
}

module.exports = { createKeyboardHook, DEFAULT_HEALTH_MS };
