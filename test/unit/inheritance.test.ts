import { describe, expect, it } from 'vitest';
import {
  collectHierarchy,
  findHierarchyMember,
  resolveParentNode,
} from '../../src/analysis/inheritance';
import type { ClassWithFile } from '../../src/analysis/definitions';
import {
  parseSourceFile,
  type ParsedSourceFile,
  type SourceFile,
} from '../../src/analysis/source-file';

// 辅助：把源文件清单解析成"预解析清单"（模仿 createContext 的封装：每文件解析一次）
function parsedFiles(files: SourceFile[]): ParsedSourceFile[] {
  return files.map((file) => parseSourceFile(file));
}

// 辅助：在预解析清单里定位类名对应的"类 + 文件"配对（测试夹具都用）
function nodeOf(parsed: ParsedSourceFile[], className: string): ClassWithFile {
  for (const entry of parsed) {
    const classDef = entry.classes.find((c) => c.name === className);
    if (classDef !== undefined) {
      return { parsed: entry, classDef };
    }
  }
  throw new Error(`测试夹具里找不到类 ${className}`);
}

// 常用夹具：Animal ← Dog ← Puppy 三层继承（每层带一个自己的 public 成员）
function hierarchyParsed(): { parsed: ParsedSourceFile[]; text: string } {
  const text =
    'Animal <- R6Class("Animal", public = list(breathe = function() "in"))\n' + // Animal 定义
    'Dog <- R6Class("Dog", inherit = Animal, public = list(bark = function() "woof"))\n' +
    'Puppy <- R6Class("Puppy", inherit = Dog, public = list(play = function() "fun"))';
  return { parsed: parsedFiles([{ uri: 'test.R', text }]), text };
}

describe('resolveParentNode 解析父类节点', () => {
  it('有 inherit → 返回父类节点（裸类名写法）', () => {
    const { parsed } = hierarchyParsed();
    const dog = nodeOf(parsed, 'Dog');
    expect(resolveParentNode(parsed, dog)).toEqual(nodeOf(parsed, 'Animal'));
  });

  it('多层：Puppy 的父类是 Dog（不是爷类 Animal）', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    expect(resolveParentNode(parsed, puppy)).toEqual(nodeOf(parsed, 'Dog'));
  });

  it('引号字符串写法也解析：inherit = "Animal" → Animal', () => {
    const parsed = parsedFiles([
      {
        uri: 'test.R',
        text:
          'Animal <- R6Class("Animal", public = list(x = 1))\n' +
          'Cat <- R6Class("Cat", inherit = "Animal")',
      },
    ]);
    const cat = nodeOf(parsed, 'Cat');
    expect(resolveParentNode(parsed, cat)).toEqual(nodeOf(parsed, 'Animal'));
  });

  it('没写 inherit → null', () => {
    const { parsed } = hierarchyParsed();
    const animal = nodeOf(parsed, 'Animal');
    expect(resolveParentNode(parsed, animal)).toBeNull();
  });

  it('父类不在预解析清单里（没加载）→ null', () => {
    const parsed = parsedFiles([
      { uri: 'test.R', text: 'Child <- R6Class("Child", inherit = Missing) ' },
    ]);
    const child = nodeOf(parsed, 'Child');
    expect(resolveParentNode(parsed, child)).toBeNull();
  });
});

describe('collectHierarchy 收集继承链', () => {
  it('含起点：Puppy → [Puppy, Dog, Animal]（先近后远）', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    expect(collectHierarchy(parsed, puppy, true).map((n) => n.classDef.name)).toEqual([
      'Puppy',
      'Dog',
      'Animal',
    ]);
  });

  it('不含起点：Puppy → [Dog, Animal]（super$ 视角）', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    expect(collectHierarchy(parsed, puppy, false).map((n) => n.classDef.name)).toEqual([
      'Dog',
      'Animal',
    ]);
  });

  it('防环：A 继承 B、B 继承 A → 收集终止不无限循环', () => {
    const text = 'A <- R6Class("A", inherit = B)\nB <- R6Class("B", inherit = A)';
    const parsed = parsedFiles([{ uri: 'test.R', text }]);
    const a = nodeOf(parsed, 'A');
    // 成环时截断，能正常返回（长度 ≤ 2）不卡死
    expect(collectHierarchy(parsed, a, true).length).toBeLessThanOrEqual(2);
  });

  it('跨文件成环也终止：a.R 的 A 继承 b.R 的 B，b.R 的 B 继承 a.R 的 A', () => {
    const parsed = parsedFiles([
      { uri: 'a.R', text: 'A <- R6Class("A", inherit = B)' },
      { uri: 'b.R', text: 'B <- R6Class("B", inherit = A)' },
    ]);
    const a = nodeOf(parsed, 'A');
    const names = collectHierarchy(parsed, a, true).map(
      (n) => `${n.parsed.file.uri}:${n.classDef.name}`,
    );
    // 能终止且每个节点至多出现一次
    expect(names.length).toBeLessThanOrEqual(2);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('findHierarchyMember 沿继承链找成员', () => {
  it('自己的成员：Puppy 里找 play → 命中 Puppy 自己', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    const hit = findHierarchyMember(parsed, puppy, 'play', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.classDef.name).toBe('Puppy');
      expect(hit.member.name).toBe('play');
    }
  });

  it('父类成员：Puppy 里找 bark → 命中 Dog', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    const hit = findHierarchyMember(parsed, puppy, 'bark', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.classDef.name).toBe('Dog');
    }
  });

  it('爷类成员：Puppy 里找 breathe → 命中 Animal', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    const hit = findHierarchyMember(parsed, puppy, 'breathe', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.classDef.name).toBe('Animal');
    }
  });

  it('同名遮蔽：最近祖先优先 —— 找 Dog 里 f → 命中 Dog 而非更远的 Animal', () => {
    const text =
      'Animal <- R6Class("Animal", public = list(f = function() 1))\n' +
      'Dog <- R6Class("Dog", inherit = Animal, public = list(f = function() 2))\n' +
      'Puppy <- R6Class("Puppy", inherit = Dog)';
    const parsed = parsedFiles([{ uri: 'test.R', text }]);
    const puppy = nodeOf(parsed, 'Puppy');
    const hit = findHierarchyMember(parsed, puppy, 'f', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.classDef.name).toBe('Dog'); // 最近祖先赢，不回退到 Animal
    }
  });

  it('不含起点：super$ 视角 —— 在 Puppy 里 super$bark → 命中 Dog', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    const hit = findHierarchyMember(parsed, puppy, 'bark', ['public'], false);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.classDef.name).toBe('Dog');
    }
  });

  it('不含起点时链上没有 → null（super$play 在父链里没有 play）', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    expect(findHierarchyMember(parsed, puppy, 'play', ['public'], false)).toBeNull();
  });

  it('区限定：父类同名成员在 private 区 → 用 public 区查不到', () => {
    const text =
      'Base <- R6Class("Base",\n' +
      '  public = list(age = 1),\n' +
      '  private = list(age = 2)\n' +
      ')\n' +
      'Child <- R6Class("Child", inherit = Base)';
    const parsed = parsedFiles([{ uri: 'test.R', text }]);
    const child = nodeOf(parsed, 'Child');
    // 从 Child 只查 public：链上第一个 public 区的 age 在 Base
    const hit = findHierarchyMember(parsed, child, 'age', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.member.scope).toBe('public');
      expect(hit.node.classDef.name).toBe('Base');
    }
  });

  it('链上都没有 → null', () => {
    const { parsed } = hierarchyParsed();
    const puppy = nodeOf(parsed, 'Puppy');
    expect(findHierarchyMember(parsed, puppy, 'missing', ['public'], true)).toBeNull();
  });

  it('跨文件：子类在当前文件、父类成员在依赖文件 → 命中依赖文件的父类节点', () => {
    const currentText = 'box::use(person)\nChild <- R6Class("Child", inherit = person$Person)';
    const depText =
      'Person <- R6Class("Person",\n' +
      '  public = list(greet = function() "hi")\n' +
      ')';
    const parsed = parsedFiles([
      { uri: 'analysis.R', text: currentText },
      { uri: 'person.R', text: depText },
    ]);
    const child = nodeOf(parsed, 'Child');
    const hit = findHierarchyMember(parsed, child, 'greet', ['public'], true);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.node.parsed.file.uri).toBe('person.R');
      expect(hit.node.classDef.name).toBe('Person');
    }
  });
});
