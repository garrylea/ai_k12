'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * 探测服务器是否可达。**纯 Node、不 require electron**，返回 Promise\<boolean\>。
 *
 * **只用于「连不上」时的重试判定**（spec §4.2）：只有它返回 `true` 才允许 `loadURL`。
 *
 * ⚠️ **不能把它退化成「每 5 秒无脑 loadURL」**：主 frame 导航失败时，Chromium 会用
 * **它自己的错误页替换掉我们的本地页**（`ERR_CONNECTION_REFUSED` 在提交前就失败，
 * 文档已被替换）。那样本地页只会出现一次，之后永久变成「无法访问此网站」。
 *
 * **任何 HTTP 响应（含 4xx/5xx）都算「可达」**：要判断的是「连不连得上」，
 * 不是「这个路径对不对」—— 服务在但路径 404 时，页面本来就加载得出来。
 * 只有**连接失败**（ECONNREFUSED / DNS 失败等）与**超时**才返回 `false`。
 *
 * @param {string} url 形如 `http://192.168.1.5:5173`
 * @param {number} timeoutMs 超时毫秒数（spec 定 3000）；非法值（<=0 / 非有限数）退化为 3000
 * @returns {Promise<boolean>}
 */
function probeServer(url, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    // 非法超时会解除 socket 定时器（Node 里 0 = 不超时）→ promise 永不 settle →
    // 调用方的 in-flight 标记卡在 true、自动重连静默失效。退化为一个安全默认值而不是
    // 直接返回 false：返回 false 会让「永远探不通」同样表现为重试形同虚设。
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;

    const mod = target.protocol === 'https:' ? https : http;

    // 超时与 error 可能都触发，用 settled 保证只 resolve 一次
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const req = mod.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname || '/',
        timeout: effectiveTimeoutMs,
      },
      (res) => {
        res.resume(); // 丢弃 body，尽早释放 socket
        done(true);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

module.exports = { probeServer };
