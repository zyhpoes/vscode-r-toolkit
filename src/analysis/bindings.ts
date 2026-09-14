/**
 * 变量绑定解析：扫描所有赋值语句，只记录"变量 ← 什么位置"，不做分类。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 用途：支撑实例成员跳转（p$xxx）—— 点 p 的成员时，先查 p 被赋成了什么。
 * 类型判断不在这里做：统一交给 type-resolve（编排）+ rhs-eval（求值器），
 * 本文件只提供"最近一次赋值在哪"的索引。
 */

import { tokenize } from '../parser/tokenizer';

/** 一条赋值记录（只记录位置，不判断右侧是什么） */
export interface Binding {
  varName: string; // 被赋值的变量名（赋值左侧）
  stIndex: number; // 右侧第一个 token 的下标（供求值器/别名递归定位右边用）
  offset: number; // varName 的位置（用于"最近赋值"判断）
}

/** 扫描全文所有赋值（一次性、不递归），按代码顺序返回 */
export function parseBindings(text: string): Binding[] {
  const tokens = tokenize(text);
  const bindings: Binding[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // 只找赋值运算符 <-（不考虑 =）
    if (t.kind !== 'operator' || t.text !== '<-') {
      continue;
    }

    // 左边必须是"独立变量"：前一个 token 是标识符，
    // 且再前一个不是 '$'（排除 self$x <- 这类成员赋值）
    const lhs = tokens[i - 1];
    if (lhs?.kind !== 'identifier') {
      continue;
    }
    if (tokens[i - 2]?.text === '$') {
      continue;
    }

    bindings.push({ varName: lhs.text, stIndex: i + 1, offset: lhs.offset });
  }

  return bindings;
}

/**
 * 找变量在"光标位置之前"最近一次赋值。
 * bindings 按代码顺序排列，所以从尾部往前扫：第一条名字匹配且位置不超过光标的即为答案。
 * 两条边界语义（改动会让行为悄悄变化，测试里有对应护栏）：
 *   - 比较用 `offset <= cursorOffset`：光标正好落在赋值那个变量上也算命中
 *   - 必须从尾往前扫：反过来取到的是最早那次赋值，与"最近一次"正好相反
 * @param cursorOffset 光标偏移量：只在它之前找（之后的赋值属于"未来"，不算）
 * @returns 命中的赋值记录；光标前没有该变量的赋值 → undefined
 */
export function findLatestBinding(
  bindings: Binding[],
  varName: string,
  cursorOffset: number,
): Binding | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const b = bindings[i];
    if (b.varName === varName && b.offset <= cursorOffset) {
      return b;
    }
  }
  return undefined;
}
