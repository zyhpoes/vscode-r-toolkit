/**
 * 括号工具：找配对的闭合括号。
 * 通用函数：与 R6 无关，任何"需要找配对括号"的解析逻辑都可复用。
 */

import type { Token } from './tokenizer';

/** 开括号 → 闭合括号 的映射（R 语言只有这三种成对括号） */
const CLOSE_BY_OPEN: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

/**
 * 从 openIndex（开括号的下标）开始数同类括号深度，找配对的闭合括号。
 * 只数同类括号：找 '(' 的配对时，内部的 '[' '{' 不影响圆括号配对。
 *
 * @param tokens     token 数组
 * @param openIndex  开括号的下标
 * @param openChar   开括号字符（'(' / '[' / '{'）
 * @returns 配对闭合括号的下标；没配对返回 -1
 * @throws 传入不支持的开括号（契约保护：防止调用方传错，fail fast）
 */
export function matchBracket(tokens: Token[], openIndex: number, openChar: string): number {
  const closeChar = CLOSE_BY_OPEN[openChar];
  if (closeChar === undefined) {
    throw new Error(`matchBracket: 不支持的开括号 "${openChar}"`);
  }

  let depth = 1;
  for (let j = openIndex + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind !== 'operator') {
      continue;
    }
    if (t.text === openChar) {
      depth++;
    } else if (t.text === closeChar) {
      depth--;
      if (depth === 0) {
        return j;
      }
    }
  }
  return -1;
}
