/**
 * esbuild 打包脚本
 * ─────────────────────────────────────────────────────────────
 * 作用：把 src/extension.ts（及其所有 import）打包成一个文件
 *       dist/extension.js —— VS Code 只认这一个入口
 *       （对应 package.json 的 "main"）。
 * 执行：npm run build（单次）/ npm run watch（监听，改代码自动重打包）。
 * 注意：用了顶层 await，所以用 .mjs 后缀。
 */

import * as esbuild from 'esbuild';

// 命令行带 --watch 参数 → 监听模式，否则单次打包
const watch = process.argv.includes('--watch');

const options = {
  // 入口：从它开始顺着 import 收集所有代码
  entryPoints: ['src/extension.ts'],
  // 开启打包：把入口及其依赖拼成一个文件
  bundle: true,
  // 输出路径：与 package.json 的 "main" 一致
  outfile: 'dist/extension.js',
  // vscode 不打包：它是 VS Code 运行时注入的，不是 npm 包
  external: ['vscode'],
  // 产物格式：扩展宿主用 CommonJS 加载插件
  format: 'cjs',
  // 目标平台：扩展宿主就是 Node 进程
  platform: 'node',
  // 语法兼容到 Node 18（扩展宿主内嵌 Node ≥ 18）
  target: 'node18',
  // 监听时内联源码映射，F5 断点才能对应回 TS 源码
  sourcemap: watch ? 'inline' : false,
  // 不压缩，保持产物可读
  minify: false,
  // 打印打包进度
  logLevel: 'info',
};

if (watch) {
  // 监听模式：挂起文件监听，改动自动重打包
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  // 单次模式：打一次包结束
  await esbuild.build(options);
}
