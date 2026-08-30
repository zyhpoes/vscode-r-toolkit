/**
 * ESLint 扁平配置（Flat Config），`npm run lint` 执行。
 * 结构：忽略清单 → JS 通用规则 → TS 类型感知规则 → 项目自定义规则。
 */

// js 官方推荐规则（JS 通用最佳实践）
import js from '@eslint/js';
// typescript-eslint：让 ESLint 能检查 TS，并提供 TS 专用规则
import tseslint from 'typescript-eslint';
// ESLint 官方配置辅助（替代已弃用的 tseslint.config）
import { defineConfig } from 'eslint/config';

// defineConfig() 接受配置数组，是官方推荐的组装方式
export default defineConfig([
  // 不检查的目录 / 文件
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'coverage/**', '*.mjs'] },

  // JS 通用规则
  js.configs.recommended,

  // TS 推荐规则（会调用编译器拿类型信息，查"可能为 null 却当非 null 用"这类错误）
  ...tseslint.configs.recommendedTypeChecked,

  // 项目自定义规则（只作用于我们自己的代码）
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: {
        // 类型感知规则需要访问 TypeScript 编译器
        projectService: true,
        tsconfigRootDir: import.meta.dirname, // 项目根目录
      },
    },
    rules: {
      // 强制 `import type { X }`：纯类型导入打包时会被删掉，减小体积
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // 未使用变量报错；`_` 开头豁免（占位参数约定）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 对我们过严，关闭
      '@typescript-eslint/restrict-template-expressions': 'off',
      // 生产代码禁 console.log；warn/error 允许
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
]);
