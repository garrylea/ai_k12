'use strict';

/**
 * 服务器地址的**构建时默认值**（spec `2026-09-26-pc-app-shell-productionization-design.md` §4.1）。
 *
 * 这是三层优先级的**兜底一层**。改地址有三条路，从便宜到贵：
 *   1. 临时/dev：启动时设 `K12_WEB_URL` 环境变量
 *   2. 不重装：改 `userData/config.json` 的 `serverUrl`，重启 App（运维最后手段）
 *   3. 改这一行 + 重新出包（③ 的 CI **不重写本文件**，而是从这里读出地址注入 electron-builder 的
 *      publish 配置与交付文档 —— 地址因此只有这一处真源）
 *
 * ⚠️ **地址是 Web 层（vite preview，默认 :5173）的地址，不是 API（Nest，默认 :3001）的地址**
 * —— 学生只认识 Web 层，API 只在服务器本机内网可达（spec §1.2）。
 *
 * ⚠️ 写死地址的前提是**服务器 IP 固定**（DHCP 保留 / 静态 IP）。IP 一变，所有学生机都要
 * 重新出包重装，或逐台改 `userData/config.json`（spec §4.1 ⑤、§6-2）。
 */
module.exports = { SERVER_URL: 'http://192.168.1.5:5173' };
