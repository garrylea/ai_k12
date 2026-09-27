'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 覆盖文件名。放在 `app.getPath('userData')` 下（跨平台普通用户可写）。 */
const CONFIG_FILE_NAME = 'config.json';

/**
 * 读 `userData/config.json` 的 `serverUrl`（spec §4.1 ②）。
 *
 * **纯 Node，不 require electron** —— userData 路径由调用方传入，所以能单测。
 *
 * **任何异常/非法情形一律返回 `null`（= 无覆盖），绝不抛错**：
 * 一个手抖写坏的文件**不该比没有文件更糟** —— 学生机一旦卡在启动就彻底不可用了
 * （spec §4.1 ② 的设计取舍）。
 *
 * 注意文件解析出的地址**只做 http(s) 校验，不做可达性校验**：可达性由重试时的
 * 探测负责（`lib/probe-server.js`），启动时不做探测（spec §3-5）。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @returns {string|null} 去掉首尾空白的合法地址；无覆盖/非法时为 `null`
 */
function readServerUrlFromFile(userDataDir) {
  const file = path.join(userDataDir, CONFIG_FILE_NAME);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件不存在是正常路径，不打 warn
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 不是合法 JSON，忽略该覆盖`);
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 顶层不是对象，忽略该覆盖`);
    return null;
  }

  const value = parsed.serverUrl;
  if (typeof value !== 'string' || value.trim() === '') {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是非空字符串，忽略该覆盖`);
    return null;
  }

  const trimmed = value.trim();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是可解析的 URL，忽略该覆盖`);
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是 http(s)，忽略该覆盖`);
    return null;
  }

  return trimmed;
}

module.exports = { readServerUrlFromFile, CONFIG_FILE_NAME };
