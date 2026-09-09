import { describe, expect, it } from 'vitest';
import { resolveVarType } from '../../src/analysis/type-resolve';
import { createContext, type AnalysisContext } from '../../src/analysis/context';

// 辅助：把单文件文本包装成 ctx（当前文件 uri 固定为 test.R）
function singleCtx(text: string): AnalysisContext {
  return createContext([{ uri: 'test.R', text }], 'test.R');
}

describe('resolveVarType 变量类型解析', () => {
  it('直接实例创建：p <- Person$new() → class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('类定义本身：Person <- R6Class(...) → class Person（className = 变量名）', () => {
    const text = 'Person <- R6Class("Person")';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'Person', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('命名空间类定义：Person <- R6::R6Class(...) → class Person', () => {
    const text = 'Person <- R6::R6Class("Person")';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'Person', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('别名链递归：q <- Person$new(); p <- q → 追到 class Person', () => {
    const text = 'Person <- R6Class("Person")\nq <- Person$new()\np <- q';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('别名后换行还有代码：p <- q 下一行继续用 p → 仍追到 class Person', () => {
    // 关键回归：p <- q 后换行 + 还有代码，别名判断必须认"换行 = 语句结束"
    const text = 'Person <- R6Class("Person")\nq <- Person$new()\np <- q\np$name';
    const ctx = singleCtx(text);
    const cursor = text.indexOf('p$name');
    expect(resolveVarType(ctx, 'p', cursor + 2)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('模块取类：p <- person$Person（$ 链终点是类）→ 求值器识别为 class Person', () => {
    // bindings 只记录位置；type-resolve 用求值器判断 $ 链终点 → Person
    const text = 'Person <- R6Class("Person")\np <- person$Person';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('直接赋类名：p <- Person（单名字是类）→ 求值器识别为 class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('最近赋值：p 先 Person 后 Employee，不同位置返回不同类', () => {
    const text =
      'Person <- R6Class("Person")\n' + // 第 0 行
      'Employee <- R6Class("Employee")\n' + // 第 1 行
      'p <- Person$new()\n' + // 第 2 行
      'p$name\n' + // 第 3 行：此时 p 是 Person
      'p <- Employee$new()\n' + // 第 4 行
      'p$name'; // 第 5 行：此时 p 是 Employee
    const ctx = singleCtx(text);

    // 第 3 行的 p：取第 2 行的赋值 → Person
    const offset1 = text.indexOf('p$name');
    expect(resolveVarType(ctx, 'p', offset1 + 2)).toEqual({ kind: 'class', className: 'Person' });

    // 第 5 行的 p：取第 4 行的赋值 → Employee
    const offset2 = text.indexOf('p$name', offset1 + 1);
    expect(resolveVarType(ctx, 'p', offset2 + 2)).toEqual({ kind: 'class', className: 'Employee' });
  });

  it('防环：a <- b; b <- a → null', () => {
    const text = 'a <- b\nb <- a';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'a', text.length)).toBeNull();
  });

  it('超长别名链超过深度上限 → null（防栈溢出）', () => {
    // 构造超过 MAX_TRACE_DEPTH 的别名链：v0 <- v1 <- ... <- v150 <- 1
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(`v${i} <- v${i + 1}`);
    }
    lines.push('v150 <- 1'); // 终点是普通值
    const text = lines.join('\n');
    const ctx = singleCtx(text);
    // 链超长按深度上限返回 null（不崩溃、不死循环）
    expect(resolveVarType(ctx, 'v0', text.length)).toBeNull();
  });

  it('函数：func <- function() {} → function', () => {
    const text = 'func <- function() {}';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'func', text.length)).toEqual({ kind: 'function' });
  });

  it('unknown：x <- 1 + 1 → null', () => {
    const text = 'x <- 1 + 1';
    const ctx = singleCtx(text);
    expect(resolveVarType(ctx, 'x', text.length)).toBeNull();
  });

  it('该位置前没有赋值 → null', () => {
    const text = 'p$name\np <- Person$new()';
    const ctx = singleCtx(text);
    // 光标在第 0 行 p$name 上，此时 p 还没赋值
    expect(resolveVarType(ctx, 'p', 0)).toBeNull();
  });
});
