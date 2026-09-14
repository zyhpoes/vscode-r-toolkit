/**
 * 路径字符串小工具（与 R / box / VS Code 无关，纯字符串处理）。
 *
 * 约定：项目内部**统一用 '/'** 表示路径分隔符 —— Windows 的 fs 也接受 '/'，
 * 这样拼接、比较、测试期望值都只有一种形态，不会随操作系统变化。
 */

import * as path from 'path';

/**
 * 把反斜杠统一成正斜杠（项目内部统一用 '/' 表示路径分隔符）。
 * @param ptr 任意路径字符串
 * @returns 反斜杠已换成 '/' 的路径（不做其它清理）
 */
export function toPosix(ptr: string): string {
  return ptr.replace(/\\/g, '/');
}

/**
 * 是否是绝对路径：同时认同 Windows 盘符（`D:/a`）与 Unix（`/a`）两种写法。
 * 注意 `D:`、`C:foo` 这类"盘符相对"写法**不算**绝对路径（Windows 语义如此）。
 * @param ptr 路径字符串（正斜杠或反斜杠写法都行）
 */
export function isAbsoluteLike(ptr: string): boolean {
  return path.win32.isAbsolute(ptr) || path.posix.isAbsolute(ptr);
}

/**
 * 去掉末尾多余的斜杠（`D:/demo/R/` → `D:/demo/R`）。
 * 盘根要保护：`/` 和 `D:/` 去掉斜杠会变成空串或"盘符相对"，语义就变了，所以原样保留。
 * @param ptr 路径字符串（假定已统一成 '/' 写法）
 * @returns 去掉末尾斜杠的路径；盘根与无末尾斜杠的输入原样返回
 */
export function stripTrailingSep(ptr: string): string {
  if (/^\/+$/.test(ptr)) {
    return '/'; // 全是斜杠 → 归一成根
  }
  if (/^[A-Za-z]:\/+$/.test(ptr)) {
    return `${ptr.slice(0, 2)}/`; // 盘根 'D:/'（含误写成 'D://' 的情况）
  }
  return ptr.replace(/\/+$/, '');
}
