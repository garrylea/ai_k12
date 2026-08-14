import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// ESLint 10 flat config.
// 仅启用 react-hooks 的两条经典规则（rules-of-hooks / exhaustive-deps），
// 不启用 v7 recommended 中的新严格规则（purity / immutability / set-state-in-effect 等），
// 避免对既有代码库产生大量误报；后续可按需逐步开启。
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'dev-dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // CJK 正则字符范围里合法使用全角空格（U+3000）等"不规则空白"，跳过正则字面量检查
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
);
