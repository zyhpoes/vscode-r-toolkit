import { describe, expect, it } from 'vitest';
import { resolveVarType } from '../../src/analysis/type-resolve';
import type { SourceFile } from '../../src/analysis/source-file';

// 辅助：把单文件文本包装成 files 数组（当前文件 uri 固定为 test.R）
function singleFile(text: string): { files: SourceFile[]; uri: string } {
  return { files: [{ uri: 'test.R', text }], uri: 'test.R' };
}

describe('resolveVarType 变量类型解析', () => {
  it('直接实例创建：p <- Person$new() → class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'p', uri, text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('类定义本身：Person <- R6Class(...) → class Person（className = 变量名）', () => {
    const text = 'Person <- R6Class("Person")';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'Person', uri, text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('别名链递归：q <- Person$new(); p <- q → 追到 class Person', () => {
    const text = 'Person <- R6Class("Person")\nq <- Person$new()\np <- q';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'p', uri, text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('重构目标：p <- person$Person（模块取类，bindings 预分类 unknown）→ 求值器补查追到 class Person', () => {
    // bindings 的 classifyRhs 对 person$Person（无 new）归 unknown；
    // 重构后 type-resolve 用求值器补查，应追到 Person（Person 在类清单里）
    const text = 'Person <- R6Class("Person")\np <- person$Person';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'p', uri, text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('重构目标：p <- Person（直接赋类名，bindings 归 alias）→ 追到 class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'p', uri, text.length)).toEqual({ kind: 'class', className: 'Person' });
  });

  it('最近赋值：p 先 Person 后 Employee，不同位置返回不同类', () => {
    const text =
      'Person <- R6Class("Person")\n' + // 第 0 行
      'Employee <- R6Class("Employee")\n' + // 第 1 行
      'p <- Person$new()\n' + // 第 2 行
      'p$name\n' + // 第 3 行：此时 p 是 Person
      'p <- Employee$new()\n' + // 第 4 行
      'p$name'; // 第 5 行：此时 p 是 Employee
    const { files, uri } = singleFile(text);

    // 第 3 行的 p：取第 2 行的赋值 → Person
    const offset1 = text.indexOf('p$name');
    expect(resolveVarType(files, 'p', uri, offset1 + 2)).toEqual({ kind: 'class', className: 'Person' });

    // 第 5 行的 p：取第 4 行的赋值 → Employee
    const offset2 = text.indexOf('p$name', offset1 + 1);
    expect(resolveVarType(files, 'p', uri, offset2 + 2)).toEqual({ kind: 'class', className: 'Employee' });
  });

  it('防环：a <- b; b <- a → null', () => {
    const text = 'a <- b\nb <- a';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'a', uri, text.length)).toBeNull();
  });

  it('函数：func <- function() {} → function', () => {
    const text = 'func <- function() {}';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'func', uri, text.length)).toEqual({ kind: 'function' });
  });

  it('unknown：x <- 1 + 1 → null', () => {
    const text = 'x <- 1 + 1';
    const { files, uri } = singleFile(text);
    expect(resolveVarType(files, 'x', uri, text.length)).toBeNull();
  });

  it('该位置前没有赋值 → null', () => {
    const text = 'p$name\np <- Person$new()';
    const { files, uri } = singleFile(text);
    // 光标在第 0 行 p$name 上，此时 p 还没赋值
    expect(resolveVarType(files, 'p', uri, 0)).toBeNull();
  });
});
