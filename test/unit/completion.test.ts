import { describe, expect, it } from 'vitest';
import { completionTriggerAt, r6MemberCandidates, type Candidate } from '../../src/analysis/completion';
import { createContext, type AnalysisContext } from '../../src/analysis/context';
import { R6_GENERATOR_SLOTS } from '../../src/analysis/members';

// 辅助：把单文件文本包装成 ctx（当前文件 uri 固定为 test.R）
function singleCtx(text: string): AnalysisContext {
  return createContext([{ uri: 'test.R', text }], 'test.R');
}

describe('completionTriggerAt 补全触发上下文', () => {
  it('`容器$` 后面一个字都没输 → member（跳转那套光标模型在这里拿不到词）', () => {
    const text = 'self$';
    expect(completionTriggerAt(singleCtx(text), text.length)).toMatchObject({
      kind: 'member',
      container: 'self',
    });
  });

  it('`容器$半词` 光标在词尾 → member', () => {
    const text = 'self$gr';
    expect(completionTriggerAt(singleCtx(text), text.length)).toMatchObject({
      kind: 'member',
      container: 'self',
    });
  });

  it('`容器$半词` 光标在词中间 → 同样 member', () => {
    const text = 'self$gr';
    expect(completionTriggerAt(singleCtx(text), text.indexOf('r'))).toMatchObject({
      kind: 'member',
      container: 'self',
    });
  });

  it('四种容器都识别：private$ / super$ / 类名$ / 实例$', () => {
    const cases = [
      ['private$', 'private'],
      ['super$', 'super'],
      ['Person$', 'Person'],
      ['p$', 'p'],
    ] as const;
    for (const [text, container] of cases) {
      expect(completionTriggerAt(singleCtx(text), text.length)).toMatchObject({
        kind: 'member',
        container,
      });
    }
  });

  it('`包名::` → namespace', () => {
    const text = 'stats::';
    expect(completionTriggerAt(singleCtx(text), text.length)).toMatchObject({
      kind: 'namespace',
      container: 'stats',
    });
  });

  it('`包名::半词` 光标在词尾 → namespace', () => {
    const text = 'stats::run';
    expect(completionTriggerAt(singleCtx(text), text.length)).toMatchObject({
      kind: 'namespace',
      container: 'stats',
    });
  });

  it('`:::` 不做 → 不触发', () => {
    const text = 'stats:::r';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
  });

  it('光标在 `Person$new()` 的 new 中间 → member（容器是类名）', () => {
    const text = 'Person$new()';
    expect(completionTriggerAt(singleCtx(text), text.indexOf('new') + 1)).toMatchObject({
      kind: 'member',
      container: 'Person',
    });
  });

  it('box::use(...) 括号内部 → 不触发（v1 不补导入语句内部）', () => {
    const text = 'box::use(R/schema/schema)';
    expect(completionTriggerAt(singleCtx(text), text.indexOf('schema'))).toBeNull();
  });

  it('box::use(...) 收尾括号之后 → 不触发', () => {
    const text = 'box::use(R/x)';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
  });

  it('注释里 → 不触发', () => {
    const text = 'x <- 1 # 说明';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
  });

  it('未闭合字符串里 / 字符串末尾 → 不触发', () => {
    const text = 'x <- "abc';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
    expect(completionTriggerAt(singleCtx(text), text.indexOf('b'))).toBeNull();
  });

  it('字符串里的 `#` 不算注释（该位置仍在字符串里）→ 不触发', () => {
    const text = 'x <- "a#b';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
  });

  it('裸名字（v1 不做补全）→ 不触发', () => {
    const text = 'foo';
    expect(completionTriggerAt(singleCtx(text), text.length)).toBeNull();
  });

  it('空白处 / 空文件 → 不触发', () => {
    expect(completionTriggerAt(singleCtx('x <- 1 '), 7)).toBeNull();
    expect(completionTriggerAt(singleCtx(''), 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R6 成员候选：夹具是一对父子类（子类遮蔽父类同名成员、父类另有 private）
// ---------------------------------------------------------------------------
const R6_TEXT = [
  'BaseModel <- R6Class("BaseModel",', // 0
  '  public = list(', // 1
  '    greet = function() "base",', // 2
  '    name = NULL', // 3
  '  ),', // 4
  '  private = list(secret = 1)', // 5
  ')', // 6
  'Child <- R6Class("Child",', // 7
  '  inherit = BaseModel,', // 8
  '  public = list(', // 9
  '    greet = function() "child",', // 10
  '    run = function() self$greet,', // 11
  '    call_super = function() super$greet', // 12
  '  ),', // 13
  '  private = list(', // 14
  '    inner = function() private$secret', // 15
  '  ),', // 16
  '  active = list(', // 17
  '    label = function(value) "x"', // 18
  '  )', // 19
  ')', // 20
  'Child$greet', // 21
  'p <- Child$new()', // 22
  'p$greet', // 23
  'q$greet', // 24
  'schema$get_label', // 25
].join('\n');

/** 辅助：光标放到 `needle` 之后（补全最常发生在"容器$"之后） */
function after(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`测试文本里找不到 ${needle}`);
  return at + needle.length;
}

/** 辅助：走完整链路（触发判定 → R6 候选）；容器不是 R6 类/实例时返回 null */
function r6At(ctx: AnalysisContext, text: string, needle: string): Candidate[] | null {
  const cursor = after(text, needle);
  const trigger = completionTriggerAt(ctx, cursor);
  if (trigger === null) throw new Error(`测试文本在 ${needle} 处没有触发补全`);
  return r6MemberCandidates(ctx, trigger.container, trigger.containerIndex, cursor);
}

/** 辅助：只取候选名 */
function labels(candidates: Candidate[] | null): string[] | null {
  return candidates === null ? null : candidates.map((c) => c.label);
}

/** 辅助：取某个候选的 detail */
function detailOf(candidates: Candidate[] | null, label: string): string | undefined {
  return candidates?.find((c) => c.label === label)?.detail;
}

describe('r6MemberCandidates R6 成员候选', () => {
  const ctxOf = (text: string = R6_TEXT) => singleCtx(text);

  it('self$ → 本类 public/active（源码顺序）+ 继承来的（不含 new：实例上没有 new）', () => {
    expect(labels(r6At(ctxOf(), R6_TEXT, 'self$'))).toEqual([
      'greet',
      'run',
      'call_super',
      'label',
      'name',
    ]);
  });

  it('detail：能算出类型就给类型，算不出退回所在区', () => {
    const items = r6At(ctxOf(), R6_TEXT, 'self$');
    expect(detailOf(items, 'greet')).toBe('函数');
    expect(detailOf(items, 'label')).toBe('函数'); // active 先统一显示"函数"
    expect(detailOf(items, 'name')).toBe('public 成员'); // name = NULL → 推不出类型
  });

  it('detail：字段类型四态（类生成器 / 实例 / 函数 / 推不出）', () => {
    const text = [
      'FieldInfo <- R6Class("FieldInfo", public = list(x = 1))',
      'Holder <- R6Class("Holder",',
      '  public = list(',
      '    cls = FieldInfo,',
      '    inst = FieldInfo$new(),',
      '    greet = function() 1,',
      '    v = 1',
      '  )',
      ')',
      'h <- Holder$new()',
      'h$',
    ].join('\n');
    const items = r6At(singleCtx(text), text, 'h$');
    expect(detailOf(items, 'cls')).toBe('FieldInfo类');
    expect(detailOf(items, 'inst')).toBe('FieldInfo实例');
    expect(detailOf(items, 'greet')).toBe('函数');
    expect(detailOf(items, 'v')).toBe('public 成员');
  });

  it('private$ → 只本类 private（R6：private 不随继承可见；实测私有环境里没有 clone）', () => {
    expect(labels(r6At(ctxOf(), R6_TEXT, 'private$'))).toEqual(['inner']);
    expect(detailOf(r6At(ctxOf(), R6_TEXT, 'private$'), 'inner')).toBe('函数');
  });

  it('super$ → 只父类链的 public/active（不含本类、不含 new）', () => {
    const items = r6At(ctxOf(), R6_TEXT, 'super$');
    expect(labels(items)).toEqual(['greet', 'name']);
    expect(detailOf(items, 'greet')).toBe('函数');
  });

  it('类名$ → 只给生成器自带槽（R 里生成器上取不到用户成员）', () => {
    const items = r6At(ctxOf(), R6_TEXT, 'Child$');
    // new 排最前（它由 parser 的 synthetic 给），其余按槽表原样；
    // toEqual 是精确比对：greet / run / call_super / label / name 一个都不该出现
    expect(labels(items)).toEqual(['new', ...R6_GENERATOR_SLOTS]);
    expect(detailOf(items, 'new')).toBe('合成成员（R6 自动生成）');
    expect(detailOf(items, 'public_fields')).toBe('R6 自带槽');
  });

  it('实例$（p <- Child$new()）→ 与 self$ 同一套成员', () => {
    expect(labels(r6At(ctxOf(), R6_TEXT, 'p$'))).toEqual([
      'greet',
      'run',
      'call_super',
      'label',
      'name',
    ]);
  });

  it('子类与父类同名成员 → 只列一次，取子类那个', () => {
    const items = r6At(ctxOf(), R6_TEXT, 'self$');
    expect(items?.filter((c) => c.label === 'greet')).toHaveLength(1);
    expect(detailOf(items, 'greet')).toBe('函数');
  });

  it('同类里 public 与 active 同名 → 只列第一个（与跳转的 find 语义一致）', () => {
    const text = [
      'Person <- R6Class("Person",',
      '  public = list(',
      '    x = 1,',
      '    f = function() self$x',
      '  ),',
      '  active = list(x = function(value) 1)',
      ')',
    ].join('\n');
    expect(labels(r6At(singleCtx(text), text, 'self$'))).toEqual(['x', 'f']);
  });

  it('类型推不出的实例（q$）→ null（不猜）', () => {
    expect(r6At(ctxOf(), R6_TEXT, 'q$')).toBeNull();
  });

  it('不是类的容器（模块名 schema$）→ null（交给模块/包来源）', () => {
    expect(r6At(ctxOf(), R6_TEXT, 'schema$')).toBeNull();
  });

  it('self$ 写在类外 → null', () => {
    const text = 'self$greet';
    expect(r6At(singleCtx(text), text, 'self$')).toBeNull();
  });

  it('链式：字段值是生成器 → 出槽；值是实例 → 出成员；推不出 → 不给', () => {
    const text = [
      'FieldInfo <- R6Class("FieldInfo", public = list(x = 1, y = 2))',
      'Holder <- R6Class("Holder",',
      '  public = list(',
      '    key_id = FieldInfo,',
      '    inst_id = FieldInfo$new(),',
      '    plain = 1',
      '  )',
      ')',
      'h <- Holder$new()',
      'h$key_id$',
      'h$inst_id$',
      'h$plain$',
      'h$nope$',
    ].join('\n');

    // 字段装的是类生成器：`h$key_id$x` 在 R 里取不到（实测），所以只给自带槽
    expect(labels(r6At(singleCtx(text), text, 'h$key_id$'))).toEqual(['new', ...R6_GENERATOR_SLOTS]);

    // 字段装的是实例 → 列那个类的成员
    expect(labels(r6At(singleCtx(text), text, 'h$inst_id$'))).toEqual(['x', 'y']);

    // 推不出类型 / 成员不存在 → 不给候选（不猜）
    expect(r6At(singleCtx(text), text, 'h$plain$')).toBeNull();
    expect(r6At(singleCtx(text), text, 'h$nope$')).toBeNull();
  });

  it('链式：链头是关键字（self / private）', () => {
    const selfText = [
      'FieldInfo <- R6Class("FieldInfo", public = list(x = 1))',
      'Holder <- R6Class("Holder",',
      '  public = list(',
      '    key_id = FieldInfo,',
      '    run = function() self$key_id$',
      '  )',
      ')',
    ].join('\n');
    expect(labels(r6At(singleCtx(selfText), selfText, 'self$key_id$'))).toEqual([
      'new',
      ...R6_GENERATOR_SLOTS,
    ]);

    const privateText = [
      'FieldInfo <- R6Class("FieldInfo", public = list(x = 1))',
      'Holder <- R6Class("Holder",',
      '  private = list(cfg = FieldInfo$new()),',
      '  public = list(',
      '    run = function() private$cfg$',
      '  )',
      ')',
    ].join('\n');
    expect(labels(r6At(singleCtx(privateText), privateText, 'private$cfg$'))).toEqual(['x']);
  });

  it('链式：折叠不动就退回"只看最后一段"（模块$类 与今天一致）', () => {
    const text = [
      'Person <- R6Class("Person", public = list(name = NULL))',
      'person$Person$',
    ].join('\n');
    expect(labels(r6At(singleCtx(text), text, 'person$Person$'))).toEqual([
      'new',
      ...R6_GENERATOR_SLOTS,
    ]);
  });

  it('生成器值的变量出槽、实例值的变量出成员（按类型分派，不看名字）', () => {
    const text = [
      'Person <- R6Class("Person", public = list(name = NULL))',
      'P <- Person',
      'Q <- Person$new()',
      'P$',
      'Q$',
    ].join('\n');
    // P 是类生成器：R 里 P$name 取到 NULL（生成器上只有自带槽）
    expect(labels(r6At(singleCtx(text), text, 'P$'))).toEqual(['new', ...R6_GENERATOR_SLOTS]);
    // Q 是实例：正常出成员
    expect(labels(r6At(singleCtx(text), text, 'Q$'))).toEqual(['name']);
  });

  it('跨文件继承 → 用**父类所在文件**的 token 算成员类型', () => {
    const baseText = [
      'FieldInfo <- R6Class("FieldInfo", public = list(x = 1))',
      'BaseModel <- R6Class("BaseModel",',
      '  public = list(',
      '    name = NULL,',
      '    info = FieldInfo',
      '  )',
      ')',
    ].join('\n');
    const childText = [
      'Child <- R6Class("Child",',
      '  inherit = BaseModel,',
      '  public = list(greet = function() self$greet)',
      ')',
    ].join('\n');
    const ctx = createContext(
      [
        { uri: 'child.R', text: childText },
        { uri: 'base.R', text: baseText },
      ],
      'child.R',
    );
    const items = r6At(ctx, childText, 'self$');
    expect(labels(items)).toEqual(['greet', 'name', 'info']);
    // 关键：info 定义在 base.R 里，算它的类型必须用 base.R 的 token（用 child.R 的会算错）
    expect(detailOf(items, 'info')).toBe('FieldInfo类');
    expect(detailOf(items, 'name')).toBe('public 成员'); // name = NULL → 推不出
  });
});
