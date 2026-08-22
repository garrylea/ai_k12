import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 后端代理目标：生产部署时由部署脚本通过 K12_API_PROXY 注入（如用户自定义了服务端端口）。
const apiProxyTarget = process.env.K12_API_PROXY || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': apiProxyTarget,
      '/assets': apiProxyTarget,
      '/uploads': apiProxyTarget,
    },
  },
  // 构建资产放在 /static/ 前缀下：/assets 需要代理给后端（教材图片、上传文件），
  // 若前端 JS/CSS 也放在 /assets 下会被一起代理到后端导致 404。
  build: {
    assetsDir: 'static',
  },
  // 生产模式：`vite preview` 托管构建产物并代理后端（同 server.proxy）。
  preview: {
    port: 5173,
    host: true,
    proxy: {
      '/api': apiProxyTarget,
      '/assets': apiProxyTarget,
      '/uploads': apiProxyTarget,
    },
  },
});
