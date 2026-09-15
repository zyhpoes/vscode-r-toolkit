import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/tokenizer';
import {
  moduleBindingName,
  modulePathOf,
  parseBoxImports,
  segmentAtOffset,
} from '../../src/analysis/box';

// 辅助：只取测试关心的字段（分段名 / 基准 / box 关键字偏移），避免断言里堆偏移量
function brief(text: string) {
  return parseBoxImports(tokenize(text)).map((imp) => ({
    segments: imp.segments.map((s) => s.name),
    relative: imp.relative,
    offset: imp.offset,
  }));
}

describe('parseBoxImports 解析 box::use', () => {
  it('简单模块：box::use(person)', () => {
    expect(brief('box::use(person)')).toEqual([
      { segments: ['person'], relative: 'root', offset: 0 },
    ]);
  });

  it('带导出列表：box::use(person[Person])', () => {
    expect(brief('box::use(person[Person])')).toEqual([
      { segments: ['person'], relative: 'root', offset: 0 },
    ]);
  });

  it('相对当前文件：box::use(./helper) → 前导 . 不算一段', () => {
    expect(brief('box::use(./helper)')).toEqual([
      { segments: ['helper'], relative: 'file', offset: 0 },
    ]);
  });

  it('上级目录：box::use(../person) → .. 保留为一段', () => {
    expect(brief('box::use(../person)')).toEqual([
      { segments: ['..', 'person'], relative: 'file', offset: 0 },
    ]);
  });

  it('上两级目录：box::use(../../utils/x)', () => {
    expect(brief('box::use(../../utils/x)')).toEqual([
      { segments: ['..', '..', 'utils', 'x'], relative: 'file', offset: 0 },
    ]);
  });

  it('多个模块按顺序：box::use(person, ./helper)', () => {
    const text = 'box::use(person, ./helper)';
    // 两个模块来自同一个 box::use，offset 都是 box 关键字的位置（0）
    expect(brief(text)).toEqual([
      { segments: ['person'], relative: 'root', offset: 0 },
      { segments: ['helper'], relative: 'file', offset: 0 },
    ]);
  });

  it('含 / 的 root 路径：box::use(proj/sub)', () => {
    expect(brief('box::use(proj/sub)')).toEqual([
      { segments: ['proj', 'sub'], relative: 'root', offset: 0 },
    ]);
  });

  it('三段路径（临床项目写法）：box::use(R/schema/schema)', () => {
    expect(brief('box::use(R/schema/schema)')).toEqual([
      { segments: ['R', 'schema', 'schema'], relative: 'root', offset: 0 },
    ]);
  });

  it('注释里的 box::use 不算数', () => {
    expect(parseBoxImports(tokenize('# box::use(person)'))).toEqual([]);
  });

  it('带引号的路径：box::use("person/utils/x") → 整串算一段', () => {
    expect(brief('box::use("person/utils/x")')).toEqual([
      { segments: ['person/utils/x'], relative: 'root', offset: 0 },
    ]);
  });

  it('引号路径 + 外部导出：box::use("person/utils/x"[Person])', () => {
    // [Person] 在引号外（合法写法），路径 = 引号内容
    expect(brief('box::use("person/utils/x"[Person])')).toEqual([
      { segments: ['person/utils/x'], relative: 'root', offset: 0 },
    ]);
  });

  it('引号误带导出（非法写法）：box::use("person/utils/x[Person]") 剥掉 [导出]', () => {
    // 防御：导出列表误写进引号（box 运行时会报错），剥掉避免路径带脏
    expect(brief('box::use("person/utils/x[Person]")')).toEqual([
      { segments: ['person/utils/x'], relative: 'root', offset: 0 },
    ]);
  });

  it('字符串里的 box::use 不算数', () => {
    expect(parseBoxImports(tokenize('x <- "box::use(person)"'))).toEqual([]);
  });

  it('没有 box 导入 → 空数组', () => {
    expect(parseBoxImports(tokenize('x <- 1'))).toEqual([]);
  });
});

describe('parseBoxImports 分段偏移（点击跳转要判断光标落在哪一段）', () => {
  it('每段的偏移指向它在原文中的位置', () => {
    const text = 'box::use(R/schema/schema)';
    const [imp] = parseBoxImports(tokenize(text));
    expect(imp.segments.map((s) => text.slice(s.offset, s.offset + s.name.length))).toEqual([
      'R',
      'schema',
      'schema',
    ]);
    // 三段各自的起点
    expect(imp.segments.map((s) => s.offset)).toEqual([
      text.indexOf('R/schema'),
      text.indexOf('schema'),
      text.lastIndexOf('schema'),
    ]);
  });

  it("相对路径 './helper' 里 helper 的偏移指向 helper 本身（不含前导 ./）", () => {
    const text = 'box::use(./helper)';
    const [imp] = parseBoxImports(tokenize(text));
    expect(imp.segments).toEqual([{ name: 'helper', offset: text.indexOf('helper') }]);
  });

  it('引号写法：段的偏移指向开引号位置', () => {
    const text = 'box::use("person/utils/x")';
    const [imp] = parseBoxImports(tokenize(text));
    expect(imp.segments).toEqual([{ name: 'person/utils/x', offset: text.indexOf('"') }]);
  });
});

describe('modulePathOf 由分段派生路径字符串', () => {
  it('三段路径还原成原文写法', () => {
    const [imp] = parseBoxImports(tokenize('box::use(R/schema/schema)'));
    expect(modulePathOf(imp)).toBe('R/schema/schema');
  });

  it("'./helper' 还原成去掉前导 ./ 的 'helper'（与旧行为一致）", () => {
    const [imp] = parseBoxImports(tokenize('box::use(./helper)'));
    expect(modulePathOf(imp)).toBe('helper');
  });

  it("'../utils/x' 原样保留", () => {
    const [imp] = parseBoxImports(tokenize('box::use(../utils/x)'));
    expect(modulePathOf(imp)).toBe('../utils/x');
  });
});

describe('模块别名 m = path 与模块绑定名', () => {
  it('别名写法：box::use(m = R/model/base) → 别名 m，路径照常分段', () => {
    const [imp] = parseBoxImports(tokenize('box::use(m = R/model/base)'));
    expect(imp.alias).toBe('m');
    expect(imp.segments.map((s) => s.name)).toEqual(['R', 'model', 'base']);
    expect(imp.relative).toBe('root');
    expect(modulePathOf(imp)).toBe('R/model/base');
  });

  it('别名 + 附着清单（官方示例）：box::use(mod = prefix/mod[name1, name2])', () => {
    const [imp] = parseBoxImports(tokenize('box::use(mod = prefix/mod[name1, name2])'));
    expect(imp.alias).toBe('mod');
    expect(imp.segments.map((s) => s.name)).toEqual(['prefix', 'mod']);
    // 清单内容（[name1, name2]）由下面「附着清单」那组用例断言
  });

  it('别名 + 相对路径：box::use(m = ./helper)', () => {
    const [imp] = parseBoxImports(tokenize('box::use(m = ./helper)'));
    expect(imp.alias).toBe('m');
    expect(imp.segments.map((s) => s.name)).toEqual(['helper']);
    expect(imp.relative).toBe('file');
  });

  it('别名 + 引号路径：box::use(m = "person/utils/x")', () => {
    const [imp] = parseBoxImports(tokenize('box::use(m = "person/utils/x")'));
    expect(imp.alias).toBe('m');
    expect(imp.segments.map((s) => s.name)).toEqual(['person/utils/x']);
  });

  it('没写别名 → alias 为 undefined，绑定名取路径最后一段', () => {
    const [imp] = parseBoxImports(tokenize('box::use(R/schema/schema)'));
    expect(imp.alias).toBeUndefined();
    expect(moduleBindingName(imp)).toBe('schema');
  });

  it('别名改变绑定名：m = R/model/base → 绑定名是 m（不是 base）', () => {
    const [imp] = parseBoxImports(tokenize('box::use(m = R/model/base)'));
    expect(moduleBindingName(imp)).toBe('m');
  });

  it('附着清单里的 = 不会被误认成别名：box::use(field_info[FI = FieldInfo])', () => {
    const [imp] = parseBoxImports(tokenize('box::use(field_info[FI = FieldInfo])'));
    expect(imp.alias).toBeUndefined(); // `=` 属于清单，不是模块别名
    expect(imp.segments.map((s) => s.name)).toEqual(['field_info']);
    // 有清单 → 不绑模块名（field_info 这个名字在 R 里不存在）
    expect(moduleBindingName(imp)).toBeUndefined();
  });

  it('别名后面漏写路径（非法写法）→ 不算导入', () => {
    expect(parseBoxImports(tokenize('box::use(m = )'))).toEqual([]);
  });
});

describe('附着清单 [a, b] / [g = f] 与"不绑模块名"', () => {
  it('单名附着：box::use(R/model/base[BaseModel]) → 名单里有 BaseModel，且不绑模块名', () => {
    const [imp] = parseBoxImports(tokenize('box::use(R/model/base[BaseModel])'));
    expect(imp.segments.map((s) => s.name)).toEqual(['R', 'model', 'base']);
    // 只写一个名字 → 本地名与模块内名相同
    expect(imp.attach).toEqual({ names: [{ alias: 'BaseModel', source: 'BaseModel' }], all: false });
    // 关键：R 里没有 base 这个绑定，所以模块绑定名应为 undefined
    expect(moduleBindingName(imp)).toBeUndefined();
  });

  it('多名附着：box::use(person[Person, helper]) → names 两个，保序', () => {
    const [imp] = parseBoxImports(tokenize('box::use(person[Person, helper])'));
    expect(imp.attach).toEqual({
      names: [
        { alias: 'Person', source: 'Person' },
        { alias: 'helper', source: 'helper' },
      ],
      all: false,
    });
  });

  it('重命名附着：box::use(pkg[g = f]) → 本地名 g、模块内名 f', () => {
    const [imp] = parseBoxImports(tokenize('box::use(pkg[g = f])'));
    expect(imp.attach).toEqual({ names: [{ alias: 'g', source: 'f' }], all: false });
  });

  it('重命名附着：box::use(R/schema/field_info[FI = FieldInfo]) → 本地名 FI、模块内名 FieldInfo', () => {
    const [imp] = parseBoxImports(tokenize('box::use(R/schema/field_info[FI = FieldInfo])'));
    expect(imp.attach).toEqual({
      names: [{ alias: 'FI', source: 'FieldInfo' }],
      all: false,
    });
  });

  it('附着全部 [...] → all = true、names 为空，同样不绑模块名', () => {
    const [imp] = parseBoxImports(tokenize('box::use(person[...])'));
    expect(imp.attach).toEqual({ names: [], all: true });
    expect(moduleBindingName(imp)).toBeUndefined();
  });

  it('混合：box::use(pkg[g = f, ...]) → 一个重命名 + all true', () => {
    const [imp] = parseBoxImports(tokenize('box::use(pkg[g = f, ...])'));
    expect(imp.attach).toEqual({ names: [{ alias: 'g', source: 'f' }], all: true });
  });

  it('别名 + 附着清单：box::use(m = prefix/mod[name1, name2])', () => {
    const [imp] = parseBoxImports(tokenize('box::use(m = prefix/mod[name1, name2])'));
    expect(imp.alias).toBe('m');
    expect(imp.segments.map((s) => s.name)).toEqual(['prefix', 'mod']);
    expect(imp.attach).toEqual({
      names: [
        { alias: 'name1', source: 'name1' },
        { alias: 'name2', source: 'name2' },
      ],
      all: false,
    });
    expect(moduleBindingName(imp)).toBeUndefined();
  });

  it('引号路径 + 清单：box::use("person/utils/x"[Person]) → 路径一段、附着一名', () => {
    const [imp] = parseBoxImports(tokenize('box::use("person/utils/x"[Person])'));
    expect(imp.segments.map((s) => s.name)).toEqual(['person/utils/x']);
    expect(imp.attach).toEqual({ names: [{ alias: 'Person', source: 'Person' }], all: false });
  });

  it('名单里混着注释：注释不占名字，也不打乱左右对应', () => {
    const text = ['box::use(pkg[', '  # 字段类型', '  FI = FieldInfo,', '  helper,', '])'].join('\n');
    const [imp] = parseBoxImports(tokenize(text));
    expect(imp.attach).toEqual({
      names: [
        { alias: 'FI', source: 'FieldInfo' },
        { alias: 'helper', source: 'helper' },
      ],
      all: false,
    });
  });

  it('右侧写坏了（box::use(pkg[g = ])）→ 模块内名退回本地名', () => {
    const [imp] = parseBoxImports(tokenize('box::use(pkg[g = ])'));
    expect(imp.attach).toEqual({ names: [{ alias: 'g', source: 'g' }], all: false });
  });

  it('本项的 = 不会串到下一项：box::use(pkg[a, g = f])', () => {
    const [imp] = parseBoxImports(tokenize('box::use(pkg[a, g = f])'));
    expect(imp.attach).toEqual({
      names: [
        { alias: 'a', source: 'a' },
        { alias: 'g', source: 'f' },
      ],
      all: false,
    });
  });

  it('没有清单 → attach 为 undefined，仍绑模块名', () => {
    const [imp] = parseBoxImports(tokenize('box::use(person)'));
    expect(imp.attach).toBeUndefined();
    expect(moduleBindingName(imp)).toBe('person');
  });

  it('清单方括号没配对（代码写一半）→ 当作没有清单，路径照常解析', () => {
    const [imp] = parseBoxImports(tokenize('box::use(person[Person)'));
    expect(imp.segments.map((s) => s.name)).toEqual(['person']);
    expect(imp.attach).toBeUndefined();
  });
});

describe('segmentAtOffset 光标踩在第几段上（模块名跳转用）', () => {
  it('裸路径：每段的偏移就是它在原文里的位置', () => {
    // box::use(R/schema/schema)
    //           ^9 ^11      ^18
    const imports = parseBoxImports(tokenize('box::use(R/schema/schema)'));
    expect(segmentAtOffset(imports, 9)?.segmentIndex).toBe(0);
    expect(segmentAtOffset(imports, 11)?.segmentIndex).toBe(1);
    expect(segmentAtOffset(imports, 18)?.segmentIndex).toBe(2);
  });

  it('命中的导入对象是对的（多行、多个导入时）', () => {
    // 第一行 'box::use(a)' 占 0..10，'\n' 在 11，第二行从 12 开始 → 它的 'R' 在 21
    const imports = parseBoxImports(tokenize('box::use(a)\nbox::use(R/schema/schema)'));
    const hit = segmentAtOffset(imports, 21);
    expect(hit?.imp).toBe(imports[1]);
    expect(hit?.segmentIndex).toBe(0);
  });

  it('偏移不等于任何段起点（点在 box、分隔符 / 、收尾 ) 上）→ 不命中', () => {
    // box::use(R/schema)：R=9、/=10、schema=11..16、)=17
    const imports = parseBoxImports(tokenize('box::use(R/schema)'));
    expect(segmentAtOffset(imports, 0)).toBeUndefined(); // 'box' 的 b
    expect(segmentAtOffset(imports, 10)).toBeUndefined(); // 分隔符 '/'
    expect(segmentAtOffset(imports, 17)).toBeUndefined(); // 收尾的 ')'
    expect(segmentAtOffset(imports, 11)?.segmentIndex).toBe(1); // 'schema' 本身命中
  });

  it('引号写法：段的偏移是开引号位置，点引号上也算命中', () => {
    // box::use("person/utils/x") —— 引号在 9
    const imports = parseBoxImports(tokenize('box::use("person/utils/x")'));
    const hit = segmentAtOffset(imports, 9);
    expect(hit?.segmentIndex).toBe(0);
    expect(modulePathOf(hit!.imp)).toBe('person/utils/x');
  });

  it('相对路径：前导 ./ 不算一段，偏移指向真正的段名', () => {
    // box::use(./helper) —— '.' 在 9、'/' 在 10、'helper' 在 11
    const imports = parseBoxImports(tokenize('box::use(./helper)'));
    expect(segmentAtOffset(imports, 11)?.segmentIndex).toBe(0);
    expect(segmentAtOffset(imports, 9)).toBeUndefined(); // 前导 '.' 不是段
  });

  it('没有导入 → undefined', () => {
    expect(segmentAtOffset([], 5)).toBeUndefined();
  });
});
