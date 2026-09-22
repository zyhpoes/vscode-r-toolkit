/**
 * parser 层的通用小工具：操作 token 数组的基础函数，parser / analysis 各模块可复用。
 * 与 tokenizer.ts 同层（只依赖 Token 类型），不依赖 analysis 或 vscode。
 */

import type { Token } from './tokenizer';

/**
 * 按"顶层逗号"把括号内部（开括号之后、闭括号之前）切成子区间数组。
 * 区间为 [openIndex+1, closeIndex)：跳过开括号本身、不含闭括号。
 *
 * 例：R6Class("Persion", public = list(A = a), private = list(C = c), lock_objects = FALSE)
 *     → 切成 4 块：["Persion", "public = list(A = a)", "private = list(C = c)", "lock_objects = FALSE"]
 *     注意：切的是"参数块"，每块内部的逗号（list 里的、{} 里的）不会误切。
 *     哪些块要、哪些块剔除，由调用方判断 —— 本函数只负责切块。
 *
 * 调用方：R6 参数块（r6-parser）、`box::use(...)` 的模块列表（analysis/box）、
 *         `options(a = 1, box.path = "x")` 的参数（analysis/project-root）。
 */
export function splitTopLevel(
  tokens: Token[], // 整个文件 tokenize 的结果
  openIndex: number, // 开括号 '(' 的下标（函数内部从它的下一个开始切）
  closeIndex: number // 配对 ')' 的下标（区间不含它，只作边界）
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // 第一个块的起点 = 开括号的下一个 token（跳过 '(' 本身）
  let stItemIndex = openIndex + 1;
  let depth = 0;
  // 从开括号的下一个开始，扫到闭括号前结束
  for (let j = openIndex + 1; j < closeIndex; j++) {
    const t = tokens[j];
    // 只有运算符参与切分判断（括号进/出深度、逗号分隔），其他 token 跳过
    if (t.kind === 'operator') {
      if (t.text === '(' || t.text === '{' || t.text === '[') {
        depth++; // 进嵌套：里面的逗号不算顶层
      } else if (t.text === ')' || t.text === '}' || t.text === ']') {
        depth--; // 出嵌套
      } else if (t.text === ',' && depth === 0) {
        // 顶层逗号：当前块结束（[stItemIndex, j)），新块从逗号后开始
        ranges.push([stItemIndex, j]);
        stItemIndex = j + 1;
      }
    }
  }
  // 最后一块没有"结尾逗号"触发收尾，所以循环结束后必须手动补上 [stItemIndex, closeIndex)。
  // 反面例子：若不补，R6Class("Persion", public = list(...), private = list(...))
  // 只会切出 ["Persion", "public = list(...)"]，private 块会丢失。
  ranges.push([stItemIndex, closeIndex]);
  return ranges;
}
