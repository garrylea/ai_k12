'use strict';

/**
 * 出包后断言：`app.asar` 里**必需资源一件不少、测试文件一件不多**（spec ③ §4.3 第 7 步）。
 *
 * 为什么必须有这一段（② spec §8-9，2026-09-27）：`main.js` 的 `showOfflinePage()` 用
 * `loadFile('pages/offline.html')` 加载本地页，**没有失败守卫**。若打包漏了这个文件，
 * `loadFile` 失败会触发 `did-fail-load` → 再次 `showOfflinePage()` → **无节流的紧循环，
 * 且屏幕上没有任何可见 UI**（这条路径不受重试定时器限流）。所以"漏资源"必须在上线前拦下。
 *
 * 为什么用 Node 而不是 workflow 里内联 bash：mac 的 asar 落在
 * `dist/mac-arm64/K12 智学.app/Contents/Resources/` —— 路径**含中文与空格**，
 * bash 里极易断词；这里用 `execFileSync(可执行文件, argv[])`（不经过 shell），零引号问题。
 *
 * 用法：
 *   node scripts/verify-asar.js            # 扫 apps/desktop/dist
 *   node scripts/verify-asar.js <distDir>  # 扫指定目录（本地 --dir 出包时用）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 必须进包的运行时资源。缺一件 → 学生机上的失败模式见文件头。 */
const REQUIRED = [
  'main.js',
  'preload.js',
  'server-url.js',
  'package.json',
  'lib/config-file.js',
  'lib/resolve-server-url.js',
  'lib/probe-server.js',
  'lib/shell-state.js',
  'pages/offline.html',
];

/**
 * 把 `asar list` 的输出解析成包内相对路径集合。
 * 输出每行形如 `/main.js`（前导 `/`）、目录也会有、Windows 上可能是 `\lib\x.js`。
 */
function parseAsarList(stdout) {
  return new Set(
    String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^[/\\]+/, '').replace(/\\/g, '/')),
  );
}

/** 纯校验：返回问题列表，空数组 = 通过。 */
function checkEntries(entries) {
  const problems = [];
  for (const f of REQUIRED) {
    if (!entries.has(f)) problems.push(`缺必需资源：${f}`);
  }
  for (const f of entries) {
    if (/(^|\/)[^/]*\.test\.js$/.test(f)) problems.push(`测试文件混进包：${f}`);
  }
  return problems;
}

/** 递归找出 distDir 下所有 app.asar（--dir 与完整出包都在这个位置）。 */
function findAsarFiles(distDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'app.asar') out.push(full);
    }
  };
  walk(distDir);
  return out;
}

/** 取 @electron/asar 的 CLI 入口，用 `node <cli> list <archive>` 调（跨平台、不依赖 .bin 垫片）。 */
function asarCliPath() {
  // ⚠️ 不能 `require.resolve('@electron/asar/package.json')`：v4（实测 4.3.1）的 `exports`
  //    是**单个字符串** `'./lib/asar.js'`，不含 `'./package.json'` 子路径，会抛
  //    `ERR_PACKAGE_PATH_NOT_EXPORTED`（本地实测过）。所以改成：解析包入口（exports 字符串
  //    对 `require` 条件仍生效）→ 从入口目录**上溯找到包根** → 从磁盘读 `package.json` 取 `bin`。
  //    这样同时兼容 v3 的对象式 `bin`（`bin.asar`）与 v4 的字符串式 `bin`。
  const entry = require.resolve('@electron/asar');
  let root = path.dirname(entry);
  let pkg = null;
  for (;;) {
    const pkgFile = path.join(root, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (parsed.name === '@electron/asar') {
          pkg = parsed;
          break;
        }
      } catch {
        /* 读不了就继续上溯 */
      }
    }
    const parent = path.dirname(root);
    if (parent === root) throw new Error('找不到 @electron/asar 的包根');
    root = parent;
  }
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : bin && bin.asar;
  if (!rel) throw new Error('@electron/asar 的 package.json 里没有 bin.asar');
  return path.join(root, rel);
}

function main() {
  const distDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'dist');

  if (!fs.existsSync(distDir)) {
    console.error(`[verify-asar] 找不到输出目录：${distDir}（先出包再校验）`);
    process.exit(1);
  }

  const archives = findAsarFiles(distDir);
  if (archives.length === 0) {
    console.error(`[verify-asar] ${distDir} 下没有任何 app.asar —— 打包没成功，或 asar 被关掉了`);
    process.exit(1);
  }

  const cli = asarCliPath();
  let failed = false;

  for (const archive of archives) {
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [cli, 'list', archive], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      console.error(`[verify-asar] 列不出 ${archive}：${err.message}`);
      failed = true;
      continue;
    }

    const entries = parseAsarList(stdout);
    const problems = checkEntries(entries);
    if (problems.length > 0) {
      failed = true;
      console.error(`[verify-asar] ${archive} 不合格：`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      console.log(`[verify-asar] ${archive} 合格（必需 ${REQUIRED.length} 项齐全，无测试文件）`);
    }
  }

  if (failed) process.exit(1);
  console.log(`asar 白名单校验通过（${archives.length} 个包）`);
}

if (require.main === module) main();

module.exports = { REQUIRED, parseAsarList, checkEntries, findAsarFiles };
