'use strict';

/**
 * 服务器地址的三层优先级判定（spec §4.1 ③）。**纯函数、不 require electron、无副作用** —— 必须可单测。
 *
 * 优先级：`envUrl`（`K12_WEB_URL` 环境变量，dev/临时覆盖）
 *      > `fileUrl`（`userData/config.json` 的 `serverUrl`，运维最后手段）
 *      > `fallback`（`server-url.js` 的构建时默认值）
 *
 * **为什么环境变量排在文件之上**：环境变量是「这一次启动的显式意图」（dev/排障），
 * 文件是持久覆盖。生产环境通常没有该变量，文件即为权威（spec §4.1）。
 *
 * 空白串一律视为「未提供」—— 传 `K12_WEB_URL=` 或写一个只有空格的 `serverUrl`
 * 都不该把地址变成空串（那会让壳去加载一个空的相对地址）。
 *
 * @param {string|undefined} envUrl  `process.env.K12_WEB_URL`
 * @param {string|null} fileUrl      `readServerUrlFromFile()` 的返回值；无覆盖时为 `null`
 * @param {string} fallback          `server-url.js` 的 `SERVER_URL`
 * @returns {string} 去掉首尾空白的最终地址
 */
function resolveServerUrl(envUrl, fileUrl, fallback) {
  const hit = [envUrl, fileUrl].find((v) => typeof v === 'string' && v.trim() !== '');
  return hit !== undefined ? hit.trim() : fallback;
}

module.exports = { resolveServerUrl };
