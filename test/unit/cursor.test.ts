import { describe, expect, it } from 'vitest';
import { findTokenIndexAt, findWordIndexAt } from '../../src/analysis/cursor';
import { createContext, type AnalysisContext } from '../../src/analysis/context';

// 辅助：把单文件文本包装成 ctx（当前文件 uri 固定为 test.R）
function singleCtx(text: string): AnalysisContext {
  return createContext([{ uri: 'test.R', text }], 'test.R');
}

describe('findWordIndexAt 找光标下的标识符下标', () => {
  it('光标落在词中间 → 命中该词', () => {
    const text = 'Person$new()';
    const ctx = singleCtx(text);
    // 光标在 Person 中间（偏移 3）
    expect(findWordIndexAt(ctx, 3)).toBe(0);
  });

  it('光标落在词开头 → 命中（边界含等号）', () => {
    const text = 'Person$new()';
    const ctx = singleCtx(text);
    expect(findWordIndexAt(ctx, 0)).toBe(0);
  });

  it('光标落在词末尾（半开区间外）→ -1', () => {
    const text = 'Person$new()';
    const ctx = singleCtx(text);
    // Person 占 [0, 6)：偏移 6 正好贴在下一位（'$'）上，不算踩在 Person 上
    expect(findWordIndexAt(ctx, 'Person'.length)).toBe(-1);
  });

  it('光标落在非标识符上（运算符 / 数字）→ -1', () => {
    const text = 'x <- 42';
    const ctx = singleCtx(text);
    expect(findWordIndexAt(ctx, text.indexOf('<-'))).toBe(-1);
    expect(findWordIndexAt(ctx, text.indexOf('42'))).toBe(-1);
  });

  it('光标落在第二个词上 → 返回第二个词的下标（不是第一个）', () => {
    const text = 'Person$new()';
    const ctx = singleCtx(text);
    // tokens 依次是：Person(0) $(1) new(2) ((3) )(4)
    expect(findWordIndexAt(ctx, text.indexOf('new') + 1)).toBe(2);
  });
});

describe('findTokenIndexAt 找光标下的任意 token（不限标识符）', () => {
  it('光标落在字符串里 → 命中那个 string token', () => {
    const text = 'box::use("person/utils/x")';
    const ctx = singleCtx(text);
    // 字符串 token 的偏移是开引号位置（9），内容占 [10, 24)；光标落在内容里（偏移 15）
    const token = ctx.cursorFile.tokens[findTokenIndexAt(ctx, 15)];
    expect(token.kind).toBe('string');
    expect(token.offset).toBe(9);
  });

  it('光标落在运算符上 → 也返回下标（与 findWordIndexAt 不同）', () => {
    const text = 'x <- 42';
    const ctx = singleCtx(text);
    const operatorIndex = findTokenIndexAt(ctx, text.indexOf('<-'));
    expect(ctx.cursorFile.tokens[operatorIndex].kind).toBe('operator');
    expect(findWordIndexAt(ctx, text.indexOf('<-'))).toBe(-1); // 同一个位置，标识符版不认
  });

  it('光标在空白处（没有任何 token）→ -1', () => {
    const text = 'x   <-';
    const ctx = singleCtx(text);
    // 偏移 1..3 是空格：偏移 2 不在任何 token 内
    expect(findTokenIndexAt(ctx, 2)).toBe(-1);
  });
});
