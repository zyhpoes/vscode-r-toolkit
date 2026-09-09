import { describe, expect, it } from 'vitest';
import { createContext } from '../../src/analysis/context';
import type { SourceFile } from '../../src/analysis/source-file';

describe('createContext 组装查询上下文', () => {
  it('正常组装：tokens/绑定/类名表各就位，resolver 认得当前与依赖文件的类', () => {
    const text = 'Person <- R6Class("Person")\np <- Person$new()\np$name';
    const files: SourceFile[] = [
      { uri: 'analysis.R', text },
      { uri: 'person.R', text: 'Employee <- R6Class("Employee")' },
    ];
    const ctx = createContext(files, 'analysis.R');

    // 光标文件相关
    expect(ctx.cursorFile.uri).toBe('analysis.R');
    expect(ctx.cursorTokens.length).toBeGreaterThan(0);
    // lines：光标文件的行索引（p$name 在第 2 行）
    expect(ctx.lines.positionAt(text.indexOf('p$name')).line).toBe(2);
    // 绑定：类定义 + 实例创建 两条（记录顺序 = 代码顺序）
    expect(ctx.bindings.map((b) => b.varName)).toEqual(['Person', 'p']);
    // resolver：当前文件与依赖文件的类都认得（跨文件查询的基础）
    expect(ctx.resolver.isClass('Person')).toBe(true);
    expect(ctx.resolver.isClass('Employee')).toBe(true);
    expect(ctx.resolver.isClass('Missing')).toBe(false);
  });

  it('uri 不在 files 里 → 抛错（契约保护，防调用方组装错）', () => {
    const files: SourceFile[] = [{ uri: 'analysis.R', text: 'x <- 1' }];
    expect(() => createContext(files, 'other.R')).toThrow(/other\.R/);
  });
});
