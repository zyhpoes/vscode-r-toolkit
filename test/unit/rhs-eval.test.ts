import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import { parseR6 } from '../../src/parser/r6-parser';
import { createNameResolver, evaluateRhs } from '../../src/analysis/rhs-eval';

// 辅助：求值"变量 varName 被赋值的那行"的右边。
// 按变量名定位（找 `<varName> <- ` 模式），不依赖"第一个/最后一个"的位置猜测。
function evalVar(text: string, varName: string): ReturnType<typeof evaluateRhs> {
  const tokens = tokenize(text);

  // 找 `<varName> <- `：varName 标识符后紧跟 <-
  let rhsStart = -1;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (
      tokens[i].kind === 'identifier' &&
      tokens[i].text === varName &&
      tokens[i + 1]?.kind === 'operator' &&
      tokens[i + 1].text === '<-'
    ) {
      rhsStart = i + 2; // 右边起点（<- 之后）
      break;
    }
  }
  if (rhsStart === -1) {
    throw new Error(`测试文本里找不到变量 ${varName} 的赋值`);
  }

  // 类清单：从同一文本里的 R6Class 定义来（测试里简单场景类名即变量名）
  const classes = parseR6(text);
  const resolver = createNameResolver(classes);
  return evaluateRhs(tokens, rhsStart, { names: resolver, cursorOffset: 0 });
}

describe('evaluateRhs 赋值右边求值', () => {
  it('Person$new() → class Person', () => {
    // 类定义在同一文本里，让 parseR6 能认出 Person
    const text = 'Person <- R6Class("Person")\np <- Person$new()';
    expect(evalVar(text, 'p')).toEqual({ kind: 'class', className: 'Person' });
  });

  it('Person（类名本身）→ class Person', () => {
    const text = 'Person <- R6Class("Person")\np <- Person';
    expect(evalVar(text, 'p')).toEqual({ kind: 'class', className: 'Person' });
  });

  it('模块取类 person$Person → class Person', () => {
    // person$Person 里的 Person 是类（类清单里有），person 是模块（忽略）
    const text = 'Person <- R6Class("Person")\np <- person$Person';
    expect(evalVar(text, 'p')).toEqual({ kind: 'class', className: 'Person' });
  });

  it('多级链 proj$models$Person → class Person（链尾是类）', () => {
    const text = 'Person <- R6Class("Person")\np <- proj$models$Person';
    expect(evalVar(text, 'p')).toEqual({ kind: 'class', className: 'Person' });
  });

  it('function 定义 → function', () => {
    const text = 'f <- function(x) x';
    expect(evalVar(text, 'f')).toEqual({ kind: 'function' });
  });

  it('表达式 1 + 1 → unknown', () => {
    const text = 'c <- 1 + 1';
    expect(evalVar(text, 'c')).toEqual({ kind: 'unknown' });
  });

  it('右边漏写（p <-）→ unknown', () => {
    const text = 'p <- ';
    expect(evalVar(text, 'p')).toEqual({ kind: 'unknown' });
  });

  it('不是类的名字（someVar 无定义）→ unknown', () => {
    const text = 'x <- someVar';
    expect(evalVar(text, 'x')).toEqual({ kind: 'unknown' });
  });
});
