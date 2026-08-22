// ESLint 9 flat config for pomodoro-focus-pro
// 注意：以下依赖（@typescript-eslint/*、eslint-plugin-react、eslint-plugin-react-hooks）
// 由另一个任务加入 package.json；本文件仅保证语法合法，依赖安装前不要运行 lint。
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
  {
    // 全局忽略：构建产物与依赖目录
    ignores: ['node_modules/**', 'out/**', 'dist/**']
  },
  {
    // TypeScript / React 源码（含 electron.vite.config.ts、vitest.config.ts 等根级配置）
    files: ['src/**/*.{ts,tsx}', 'electron.vite.config.ts', 'vitest.config.ts', 'vitest.setup.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      // —— 关闭 / 放宽明显误报的规则，尽量对现有代码少报错 ——
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',
      // React 17+ JSX 转换无需显式导入 React，props 由 TS 校验
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // React Hooks 规则
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
      // import/no-cycle：如需启用，请安装 eslint-plugin-import 后在此追加该规则
    }
  },
  {
    // 测试文件：补充 vitest 全局变量（describe/it/expect/vi 等）
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        suite: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
]
