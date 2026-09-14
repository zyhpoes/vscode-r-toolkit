/**
 * token 工具：与 Token 同层的基础操作，parser / analysis 各模块可复用。
 * 与 tokenizer.ts 同层（依赖 Token 类型），不依赖 analysis 或 vscode。
 */

import type { Token } from './tokenizer';

/**
 * 从 stIndex 开始找下一个"非注释" token 的**下标**（跳过注释）。
 * 找不到（一路都是注释、stIndex 已越界/到末尾）→ undefined。
 * 刻意不用 -1 / tokens.length 这类"非法下标"来表达"没找到"：
 * 那样忘记检查时会在运行时静默算错（例如 -1 + 1 = 0 会从头重扫）；
 * 返回 undefined 让忘记检查的地方**直接编译报错**。
 * 需要按下标继续处理（matchBracket / splitTopLevel）时用它。
 */
export function nextNonCommentIndex(tokens: Token[], stIndex: number): number | undefined {
  let i = stIndex;
  while (tokens[i]?.kind === 'comment') {
    i++;
  }
  return i < tokens.length ? i : undefined;
}

/** 从 stIndex 开始找下一个"非注释"的 token（跳过注释）；没有则 undefined */
export function nextNonComment(tokens: Token[], stIndex: number): Token | undefined {
  const index = nextNonCommentIndex(tokens, stIndex);
  return index === undefined ? undefined : tokens[index];
}
