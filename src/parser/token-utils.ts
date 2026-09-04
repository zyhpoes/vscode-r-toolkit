/**
 * token 工具：与 Token 同层的基础操作，parser / analysis 各模块可复用。
 * 与 tokenizer.ts 同层（依赖 Token 类型），不依赖 analysis 或 vscode。
 */

import type { Token } from './tokenizer';

/** 从 stIndex 开始找下一个"非注释"的 token（跳过注释） */
export function nextNonComment(tokens: Token[], stIndex: number): Token | undefined {
  for (let j = stIndex; j < tokens.length; j++) {
    if (tokens[j].kind !== 'comment') {
      return tokens[j];
    }
  }
  return undefined;
}
