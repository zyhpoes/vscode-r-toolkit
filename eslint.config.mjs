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
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'coverage/**'] },

  // JS 通用规则
  js.configs.recommended,

  // Node 脚本（.mjs/.js 构建与工具脚本）运行在 Node 环境，提供 Node 全局变量
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },

  // TS 推荐规则：类型感知规则需要 TS 类型信息，只作用于 TS 文件（不适用于 .js/.mjs）
  ...tseslint.configs.recommendedTypeChecked.map((conf) => ({
    ...conf,
    files: ['**/*.ts'],
  })),

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
