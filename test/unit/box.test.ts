import { describe, expect, it } from 'vitest';
import { parseBoxImports } from '../../src/analysis/box';

describe('parseBoxImports 解析 box::use', () => {
  it('简单模块：box::use(person)', () => {
    const text = 'box::use(person)';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person', relative: 'root', offset: 0 },
    ]);
  });

  it('带导出列表：box::use(person[Person])', () => {
    const text = 'box::use(person[Person])';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person', relative: 'root', offset: 0 },
    ]);
  });

  it('相对当前文件：box::use(./helper)', () => {
    const text = 'box::use(./helper)';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'helper', relative: 'file', offset: 0 },
    ]);
  });

  it('上级目录：box::use(../person)', () => {
    const text = 'box::use(../person)';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: '../person', relative: 'file', offset: 0 },
    ]);
  });

  it('上两级目录：box::use(../../utils/x)', () => {
    const text = 'box::use(../../utils/x)';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: '../../utils/x', relative: 'file', offset: 0 },
    ]);
  });

  it('多个模块按顺序：box::use(person, ./helper)', () => {
    const text = 'box::use(person, ./helper)';
    // 两个模块来自同一个 box::use，offset 都是 box 关键字的位置（0）
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person', relative: 'root', offset: 0 },
      { modulePath: 'helper', relative: 'file', offset: 0 },
    ]);
  });

  it('含 / 的 root 路径：box::use(proj/sub)', () => {
    const text = 'box::use(proj/sub)';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'proj/sub', relative: 'root', offset: 0 },
    ]);
  });

  it('注释里的 box::use 不算数', () => {
    const text = '# box::use(person)';
    expect(parseBoxImports(text)).toEqual([]);
  });

  it('带引号的路径：box::use("person/utils/x")', () => {
    const text = 'box::use("person/utils/x")';
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person/utils/x', relative: 'root', offset: 0 },
    ]);
  });

  it('引号路径 + 外部导出：box::use("person/utils/x"[Person])', () => {
    const text = 'box::use("person/utils/x"[Person])';
    // [Person] 在引号外（合法写法），路径 = 引号内容
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person/utils/x', relative: 'root', offset: 0 },
    ]);
  });

  it('引号误带导出（非法写法）：box::use("person/utils/x[Person]") 剥掉 [导出]', () => {
    const text = 'box::use("person/utils/x[Person]")';
    // 防御：导出列表误写进引号（box 运行时会报错），剥掉避免路径带脏
    expect(parseBoxImports(text)).toEqual([
      { modulePath: 'person/utils/x', relative: 'root', offset: 0 },
    ]);
  });

  it('字符串里的 box::use 不算数', () => {
    const text = 'x <- "box::use(person)"';
    expect(parseBoxImports(text)).toEqual([]);
  });

  it('没有 box 导入 → 空数组', () => {
    const text = 'x <- 1';
    expect(parseBoxImports(text)).toEqual([]);
  });
});
