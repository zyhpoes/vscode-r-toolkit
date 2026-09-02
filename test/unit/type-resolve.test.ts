import { describe, expect, it } from 'vitest';
import { parseBindings } from '../../src/analysis/bindings';
import { resolveVarType } from '../../src/analysis/type-resolve';

describe('resolveVarType 变量类型解析', () => {
  it('直接实例创建：p <- Person$new() → class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('类定义本身：Person <- R6Class(...) → class Person（className = 变量名）', () => {
    const text = 'Person <- R6Class("Person")';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'Person', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('别名链递归：q <- Person$new(); p <- q → 追到 class Person', () => {
    const text = 'Person <- R6Class("Person")\nq <- Person$new()\np <- q';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'p', text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('最近赋值：p 先 Person 后 Employee，不同位置返回不同类', () => {
    const text =
      'Person <- R6Class("Person")\n' + // 第 0 行
      'Employee <- R6Class("Employee")\n' + // 第 1 行
      'p <- Person$new()\n' + // 第 2 行
      'p$name\n' + // 第 3 行：此时 p 是 Person
      'p <- Employee$new()\n' + // 第 4 行
      'p$name'; // 第 5 行：此时 p 是 Employee
    const bindings = parseBindings(text);

    // 第 3 行的 p：取第 2 行的赋值 → Person
    const offset1 = text.indexOf('p$name');
    expect(resolveVarType(bindings, 'p', offset1 + 2)).toEqual({ kind: 'class', className: 'Person' });

    // 第 5 行的 p：取第 4 行的赋值 → Employee
    const offset2 = text.indexOf('p$name', offset1 + 1);
    expect(resolveVarType(bindings, 'p', offset2 + 2)).toEqual({ kind: 'class', className: 'Employee' });
  });

  it('防环：a <- b; b <- a → null', () => {
    const text = 'a <- b\nb <- a';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'a', text.length)).toBeNull();
  });

  it('函数：func <- function() {} → function', () => {
    const text = 'func <- function() {}';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'func', text.length)).toEqual({ kind: 'function' });
  });

  it('unknown：x <- 1 + 1 → null', () => {
    const text = 'x <- 1 + 1';
    const bindings = parseBindings(text);
    expect(resolveVarType(bindings, 'x', text.length)).toBeNull();
  });

  it('该位置前没有赋值 → null', () => {
    const text = 'p$name\np <- Person$new()';
    const bindings = parseBindings(text);
    // 光标在第 0 行 p$name 上，此时 p 还没赋值
    expect(resolveVarType(bindings, 'p', 0)).toBeNull();
  });
});
