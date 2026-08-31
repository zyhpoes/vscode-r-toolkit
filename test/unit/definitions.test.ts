import { describe, expect, it } from 'vitest';
import { resolveClassDefinition } from '../../src/analysis/definitions';

describe('resolveClassDefinition 光标定位类定义', () => {
  // 基础场景：定义在第 0 行，引用在第 1 行
  const text = 'Person <- R6Class("Person")\nPerson$new()';

  it('光标在类名中间 → 跳到定义处（第 0 行第 0 列）', () => {
    // 用 indexOf 定位引用行，+4 表示光标停在 Person 中间（不手数偏移量）
    const cursor = text.indexOf('Person$new()') + 4;
    expect(resolveClassDefinition(text, cursor)).toEqual({ name: 'Person', line: 0, character: 0 });
  });

  it('光标在类名开头 → 命中（边界含等号）', () => {
    const cursor = text.indexOf('Person$new()'); // 光标在 Person 开头
    expect(resolveClassDefinition(text, cursor)).toEqual({ name: 'Person', line: 0, character: 0 });
  });

  it('光标在类名末尾边界（Person|$）→ 不命中（半开区间）', () => {
    // 光标停在 Person 末尾（= 下一个字符 $ 的位置）→ 不在任何词上
    const cursor = text.indexOf('Person$new()') + 'Person'.length;
    expect(resolveClassDefinition(text, cursor)).toBeNull();
  });

  it('光标在 new 上 → 不命中（new 不是类名）', () => {
    const cursor = text.indexOf('new') + 1;
    expect(resolveClassDefinition(text, cursor)).toBeNull();
  });

  it('光标在普通变量 x 上 → 不命中', () => {
    const text2 = 'x <- 1\nPerson <- R6Class("Person")';
    expect(resolveClassDefinition(text2, 0)).toBeNull();
  });

  it('光标在类定义行自身的类名上 → 返回自身位置（无害）', () => {
    expect(resolveClassDefinition(text, 0)).toEqual({ name: 'Person', line: 0, character: 0 });
  });

  it('多行多类：点第二个类的引用 → 跳到第二个类定义处', () => {
    const text3 = 'A <- R6Class("A")\nB <- R6Class("B")\nB$new()';
    const cursor = text3.indexOf('B$new()'); // 光标在第二个 B 上
    expect(resolveClassDefinition(text3, cursor)).toEqual({ name: 'B', line: 1, character: 0 });
  });
});
