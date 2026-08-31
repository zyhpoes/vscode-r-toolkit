/**
 * R6 解析器：从 R 代码文本中识别 R6 类定义（最简版）。
 * 纯逻辑：输入文本，输出类清单 [{name, nameOffset}]，不依赖 vscode。
 *
 * 识别规则：
 *   - 调用形式：`R6Class(...)` 或 `R6::R6Class(...)`
 *   - 类名：`<-` 左侧的标识符（引用名）；没有 `<-` 赋值 → 跳过
 *   - 嵌套在其它调用内部的 R6Class 定义 → 跳过（v1 只认顶层类）
 */

import { tokenize, type Token } from './tokenizer';

/** 一个识别出的 R6 类定义（最简版：名字 + 名字在原文中的偏移） */
export interface R6ClassDef {
  name: string;
  nameOffset: number;
}

/** 从 R 代码文本中识别所有 R6 类定义 */
export function parseR6(text: string): R6ClassDef[] {
  const tokens = tokenize(text);
  const result: R6ClassDef[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // 当前位置是否是 R6Class 调用的名字开头
    const callName = r6CallName(tokens, i);
    if (callName === null) {
      continue;
    }

    // 名字后必须紧跟 '('，否则只是同名变量，不是调用
    const open = tokens[callName.end + 1];
    if (open === undefined || open.kind !== 'operator' || open.text !== '(') {
      continue;
    }

    // 用深度计数器找配对的 ')'，拿到调用范围
    const close = matchParen(tokens, callName.end + 1);
    if (close === -1) {
      continue; // 括号没配对（代码不完整），跳过
    }

    // 定类名：只看 <- 左侧；没有赋值则跳过。举个例子:
    // Persion <- R6::R6Class("Persion", ...) --> 保留
    // R6::R6Class("Persion", ...) ---> 缺少赋值行为，不保留
    const cls = findClassName(tokens, callName.start);
    if (cls !== null) {
      result.push(cls);
    }

    // 跳过整个调用（含内部嵌套的 R6Class），避免重复扫描
    i = close;
  }

  return result;
}

/**
 * 判断 tokens[i] 是否为一个 R6Class 调用的名字开头。
 * 返回 { start, end }：start 是名字第一个 token 下标，end 是 R6Class 标识符下标。
 * 不是则返回 null。
 */
function r6CallName(tokens: Token[], i: number): { start: number; end: number } | null {
  const t = tokens[i];
  if (t.kind !== 'identifier') {
    return null;
  }

  // 裸形式：R6Class
  if (t.text === 'R6Class') {
    return { start: i, end: i };
  }

  // 命名空间形式：R6 :: R6Class
  if (
    t.text === 'R6' &&
    tokens[i + 1]?.kind === 'operator' &&
    tokens[i + 1].text === '::' &&
    tokens[i + 2]?.kind === 'identifier' &&
    tokens[i + 2].text === 'R6Class'
  ) {
    return { start: i, end: i + 2 };
  }

  return null;
}

/** 从 openIndex（'(' 的下标）开始数深度，找配对的 ')'，返回其下标；没配对返回 -1 */
function matchParen(tokens: Token[], openIndex: number): number {
  let depth = 1;
  for (let j = openIndex + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind !== 'operator') {
      continue;
    }
    if (t.text === '(') {
      depth++;
    } else if (t.text === ')') {
      depth--;
      if (depth === 0) {
        return j;
      }
    }
  }
  return -1;
}

/**
 * 定类名：只看 `<-` 左侧的标识符（引用名）。
 * 没有 `<-` 赋值 → 返回 null（调用方跳过）。
 * 注：字符串参数不再作为兜底 —— 没有 <- 的类无法被引用，跳转没有意义。
 */
function findClassName(tokens: Token[], callStart: number): { name: string; nameOffset: number } | null {
  // 如果tokens[callStart]判断是R6类定义了
  // 那tokens[callStart - 1]应该是 `<-` 操作符。在ts中数组越界不会报错会返回undefined
  // 那tokens[callStart - 2]应该是类名。在ts中数组越界不会报错会返回undefined
  const oper = tokens[callStart - 1];
  const name = tokens[callStart - 2];

  // 符合R6类的定义
  if (oper?.kind === 'operator' && oper.text === '<-' && name?.kind === 'identifier') {
    return { name: name.text, nameOffset: name.offset };
  }
  return null;
}
