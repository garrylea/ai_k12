#!/usr/bin/env node
/**
 * 将 KaTeX 字体文件从 node_modules 复制到 public/katex-fonts/，
 * 并生成 src/styles/katex-fonts.css（修正 @font-face 的 src 路径为绝对路径 /katex-fonts/）。
 *
 * 解决 Vite 在 dev/build 模式下无法正确解析 node_modules CSS 中相对 url(fonts/...) 的问题，
 * 导致 KaTeX 数学公式（如 \sqrt{}）渲染错位（根号横线缺失、显示为 /8 等）。
 *
 * 用法：node scripts/setup-katex-fonts.cjs
 * 建议在 package.json postinstall 中调用，确保 dev 和 build 环境都可用。
 */
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.resolve(__dirname, '..');
const SRC_FONTS_DIR = path.join(WEB_DIR, 'node_modules', 'katex', 'dist', 'fonts');
const DEST_FONTS_DIR = path.join(WEB_DIR, 'public', 'katex-fonts');
const KATEX_CSS_SRC = path.join(WEB_DIR, 'node_modules', 'katex', 'dist', 'katex.min.css');
const KATEX_CSS_DEST = path.join(WEB_DIR, 'src', 'styles', 'katex-fonts.css');

function main() {
  if (!fs.existsSync(SRC_FONTS_DIR)) {
    console.error('[setup-katex-fonts] 错误：未找到 KaTeX 字体目录，请先安装依赖（npm install）');
    process.exit(1);
  }

  // 1. 创建目标目录
  if (!fs.existsSync(DEST_FONTS_DIR)) {
    fs.mkdirSync(DEST_FONTS_DIR, { recursive: true });
  }

  // 2. 复制 woff2 字体文件（现代浏览器优先用 woff2，体积最小）
  const fontFiles = fs.readdirSync(SRC_FONTS_DIR).filter(f => f.endsWith('.woff2'));
  let copied = 0;
  for (const file of fontFiles) {
    const src = path.join(SRC_FONTS_DIR, file);
    const dest = path.join(DEST_FONTS_DIR, file);
    fs.copyFileSync(src, dest);
    copied++;
  }
  console.log(`[setup-katex-fonts] 已复制 ${copied} 个 woff2 字体文件到 public/katex-fonts/`);

  // 3. 读取原始 CSS，提取 @font-face 规则，替换路径
  const rawCss = fs.readFileSync(KATEX_CSS_SRC, 'utf8');

  // 提取所有 @font-face{...} 规则（非贪婪匹配）
  const fontFaceMatches = rawCss.match(/@font-face\{[^}]+\}/g) || [];

  // 替换 url(fonts/...) -> url(/katex-fonts/...)
  // 同时去掉 woff/ttf 的后备格式，只保留 woff2（现代浏览器都支持）
  const cleanedFaces = fontFaceMatches.map(face => {
    return face
      .replace(/url\(fonts\//g, 'url(/katex-fonts/')
      // 去掉 woff 和 ttf 的后备 src，只保留 woff2
      .replace(/,url\([^)]+\.woff\)\s+format\("woff"\)/g, '')
      .replace(/,url\([^)]+\.ttf\)\s+format\("truetype"\)/g, '');
  });

  const outputCss = cleanedFaces.join('\n') + '\n';
  fs.writeFileSync(KATEX_CSS_DEST, outputCss);
  console.log(`[setup-katex-fonts] 已生成 ${KATEX_CSS_DEST}（${cleanedFaces.length} 个 @font-face）`);
}

main();
