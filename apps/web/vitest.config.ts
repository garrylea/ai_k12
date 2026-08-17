import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // jsdom 环境用于 React 组件测试（react-dom 需要 DOM API）
      environment: 'jsdom',
      // 全局注入 jest-dom 匹配器（@testing-library/jest-dom/vitest）
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // 不开启 globals，测试文件显式从 'vitest' 导入 describe/it/expect
      globals: false,
    },
  }),
);
