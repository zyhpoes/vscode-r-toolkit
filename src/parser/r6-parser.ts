/**
 * R6 解析器：从 R 代码文本中识别 R6 类定义与成员。
 * 纯逻辑：输入文本，输出类清单 [{name, nameOffset, members}]，不依赖 vscode。
 *
 * 识别规则：
 *   - 调用形式：`R6Class(...)` 或 `R6::R6Class(...)`
 *   - 类名：`<-` 左侧的标识符（引用名）；没有 `<-` 赋值 → 跳过
 *   - 成员：从 public/private/active = list(...) 中提取
 *   - 嵌套在其它调用内部的 R6Class 定义 → 跳过（v1 只认顶层类）
 */

import { tokenize, type Token } from './tokenizer';
import { matchBracket } from './brackets';

/** 成员所属的区 */
export type R6Scope = 'public' | 'private' | 'active';

/** 一个成员：名字 + 属于哪个区 + 名字在原文中的偏移（跳转目标） */
export interface R6Member {
  name: string;
  scope: R6Scope;
  nameOffset: number;
}

/** 一个识别出的 R6 类定义：名字 + 名字偏移 + 成员清单 + 调用范围（token 下标） */
export interface R6ClassDef {
  // 类名
  name: string;
  // 类名在原文的偏移
  nameOffset: number;

  /**
   * 例子: Person <- R6Class("Person",
   *         public = list(greet = function() "hi", name = NULL),
   *         private = list(age = NA),
   *         active = list(age = function(value) private$age)
   *       )
   * 
   * members 拿到的结果为: [
   *    {scope: 'public', name: 'greet', nameOffset: 38 },
   *    {scope: 'public', name: 'name', nameOffset: 65 },
   *    {scope: 'private', name: 'age', nameOffset: 95 },
   *    {scope: 'active', name: 'age', nameOffset: 122 }
   * ]
   */
  members: R6Member[];

  /** 合成成员（R6 自动生成、非用户定义）。v1 只含 new：有 initialize 指向它，否则指向类名 */
  synthetic: SyntheticMember[];

  /** 父类引用（inherit = X）；类没写 inherit → undefined */
  inherit: InheritRef | undefined;

  /** 例子：Person <- R6Class("Person", ...) 里，stIndex = "R6Class" 的坐标 */
  stIndex: number;
  /** 同一个例子里，enIndex = 最外层配对 ')' 的坐标 */
  enIndex: number;
}

/** R6 合成成员：跳转目标（nameOffset 指向 initialize 或类名） */
export interface SyntheticMember {
  name: string; // 合成成员名（如 'new'）
  nameOffset: number; // 跳转目标：initialize 的偏移（有）或类名偏移（无）
}

/**
 * inherit 参数的父类引用（三种常见写法）。
 * 例子：
 *   inherit = A        → kind 'name'，className = A
 *   inherit = pkg$A    → kind 'chain'，className = A（$ 链链尾名，模块限定的类）
 *   inherit = "A"      → kind 'string'，className = A（引号字符串内容）
 */
export interface InheritRef {
  /** 引用写法：裸类名 / $ 链（模块限定）/ 引号字符串 */
  kind: 'name' | 'chain' | 'string';
  /** 父类名（解析父类定义时按它找） */
  className: string;
  /** 父类名所在 token 的偏移（将来"点击 inherit 里的类名跳父类"可用） */
  offset: number;
}

/** 从 R 代码文本中识别所有 R6 类定义 */
export function parseR6(text: string): R6ClassDef[] {
  const tokens = tokenize(text);
  const result: R6ClassDef[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // 当前位置是否是 R6Class 调用的名字开头
    const callName = r6CallTokenRange(tokens, i);
    if (callName === null) {
      continue;
    }

    // 名字后必须紧跟 '('，否则只是同名变量，不是调用
    const openToken = tokens[callName.enIndex + 1];
    if (openToken === undefined || openToken.kind !== 'operator' || openToken.text !== '(') {
      continue;
    }

    // 确定圆括号的坐标，方便后续调用
    const openIndex = callName.enIndex + 1;
    const closeIndex = matchBracket(tokens, openIndex, '(');
    if (closeIndex === -1) {
      continue; // 括号没配对（代码不完整），跳过
    }

    // 定类名：只看 <- 左侧；没有赋值则跳过。举个例子:
    // Persion <- R6::R6Class("Persion", ...) --> 保留
    // R6::R6Class("Persion", ...) ---> 缺少赋值行为，不保留
    const cls = findClassNameAndOffset(tokens, callName.stIndex);
    if (cls !== null) {
      // 从调用范围提取成员（public/private/active 三个区）
      const members = extractMembers(tokens, openIndex, closeIndex);
      // 生成合成成员（v1 只含 new）：有 initialize 指向它，没有指向类名
      const synthetic = buildSynthetic(members, cls.nameOffset);
      // 返回结果
      result.push({
        name: cls.name,               // 类名
        nameOffset: cls.nameOffset,   // 类名的偏移量
        members,                      // 成员清单（public/private/active 提取结果）
        synthetic,                    // 合成成员（new）
        inherit: extractInherit(tokens, openIndex, closeIndex), // 父类引用（inherit = X）
        stIndex: callName.stIndex,    // 调用名第一个 token 的下标（调用范围起点）
        enIndex: closeIndex,          // 配对 ')' 的下标（调用范围终点）
      });
    }

    // 跳过整个调用（含内部嵌套的 R6Class），避免重复扫描
    i = closeIndex;
  }

  return result;
}

/**
 * 判断 tokens[index] 是否为一个 R6Class 调用的名字开头。
 * 返回 { stIndex, enIndex }：调用名在 token 数组中的起止下标（范围）；
 * 不是调用则返回 null。
 * （export 供 analysis/bindings.ts 复用：判断赋值右侧是不是 R6Class）
 */
export function r6CallTokenRange(
  tokens: Token[],
  index: number,
): { stIndex: number; enIndex: number } | null {
  const t = tokens[index];
  if (t.kind !== 'identifier') {
    return null;
  }

  // 裸形式：R6Class（只占 1 个 token，起止下标相同）
  if (t.text === 'R6Class') {
    return { stIndex: index, enIndex: index };
  }

  // 命名空间形式：R6 :: R6Class（占 3 个 token）
  if (
    t.text === 'R6' &&
    tokens[index + 1]?.kind === 'operator' &&
    tokens[index + 1].text === '::' &&
    tokens[index + 2]?.kind === 'identifier' &&
    tokens[index + 2].text === 'R6Class'
  ) {
    return { stIndex: index, enIndex: index + 2 };
  }

  return null;
}

/**
 * 定类名：只看 `<-` 左侧的标识符（引用名）。
 * 返回 { name, nameOffset }：类名 + 类名在原文中的偏移。
 * 没有 `<-` 赋值 → 返回 null（调用方跳过）。
 * 注：字符串参数不再作为兜底 —— 没有 <- 的类无法被引用，跳转没有意义。
 */
function findClassNameAndOffset(
  tokens: Token[],
  stIndex: number, // 调用名第一个 token 的下标（R6Class 或 R6）
): { name: string; nameOffset: number } | null {
  // 如果tokens[stIndex]判断是R6类定义了
  // 那tokens[stIndex - 1]应该是 `<-` 操作符。在ts中数组越界不会报错会返回undefined
  // 那tokens[stIndex - 2]应该是类名。在ts中数组越界不会报错会返回undefined
  const oper = tokens[stIndex - 1];
  const name = tokens[stIndex - 2];

  // 符合R6类的定义
  if (oper?.kind === 'operator' && oper.text === '<-' && name?.kind === 'identifier') {
    return { name: name.text, nameOffset: name.offset };
  }
  return null;
}

/**
 * 从 R6Class 调用范围中提取成员（public/private/active 三个区）。
 * @param openIndex  外层 '(' 的下标
 * @param closeIndex 配对 ')' 的下标
 * @returns 成员清单；没有任何区则返回空数组
 */
function extractMembers(tokens: Token[], openIndex: number, closeIndex: number): R6Member[] {
  const members: R6Member[] = [];

  /**
   * 把 R6Class 的参数区（开括号之后、闭括号之前）按"顶层逗号"切成参数块。
   *
   * 例：Person <- R6::R6Class("Person",
   *        public = list(A = a, B = b),
   *        private = list(C = c, D = d))
   *
   * 返回每个参数块在 token 数组中的下标范围 [start, end)：
   *   1. "Person" 这一块的坐标
   *   2. "public = list(A = a, B = b)" 这一块的坐标
   *   3. "private = list(C = c, D = d)" 这一块的坐标
   * （end 不含：该块到 end 前一个 token 为止）
   * 无关参数（如 lock_objects）也会被切成块，是否区名由下面的循环逐个判断。
   */
  const argRanges = splitTopLevel(tokens, openIndex, closeIndex);

  // 每个参数块：看开头是不是 `区名 = list( ... )`
  // （只关心块起点 start；end 用不上，不解构避免未使用警告）
  for (const [start] of argRanges) {
    // 块第一个 token 必须是目标参数(public/private/active)
    // 如果不是目标参数，则剔除掉。比如: lock_objects就不是目标参数
    const scope = scopeOf(tokens[start]?.text ?? '');
    if (scope === null) {
      continue;
    }

    // 区名后必须跟 `= list(`
    if (tokens[start + 1]?.kind !== 'operator' || tokens[start + 1].text !== '=') {
      continue;
    }
    if (tokens[start + 2]?.kind !== 'identifier' || tokens[start + 2].text !== 'list') {
      continue;
    }
    if (tokens[start + 3]?.kind !== 'operator' || tokens[start + 3].text !== '(') {
      continue;
    }

    // 找 scope（public/private/active）的 list 配对 ')'；配对失败说明代码不完整，跳过
    const scopeCloseIndex = matchBracket(tokens, start + 3, '(');
    if (scopeCloseIndex !== -1) {
      // tokens: 整个文件的 token
      // start + 3: scope 的 list 开括号 '('
      // scopeCloseIndex: 配对 ')' 的下标
      // scope: 成员所属类别（public/private/active）
      // 作用：解析 list 内容，得到该区成员，展开后收进 members
      members.push(...parseMemberList(tokens, start + 3, scopeCloseIndex, scope));
    }
  }

  return members;
}

/**
 * 从 R6Class 调用范围中提取父类引用（inherit = X）。
 * 只认三种写法（其余表达式形状一律视为没写）：
 *   inherit = A        → 裸类名（kind 'name'）
 *   inherit = pkg$A    → $ 链（kind 'chain'，链尾名是父类名）
 *   inherit = "A"      → 引号字符串（kind 'string'）
 * 注意：inherit 参数在参数区的位置不固定（可能在 public/private 之后），
 * 所以和 extractMembers 一样扫全部顶层参数块。
 * @param openIndex  外层 '(' 的下标
 * @param closeIndex 配对 ')' 的下标
 * @returns 父类引用；没写 inherit / 写法不认 → undefined
 */
function extractInherit(
  tokens: Token[],
  openIndex: number,
  closeIndex: number,
): InheritRef | undefined {
  const argRanges = splitTopLevel(tokens, openIndex, closeIndex);

  for (const [start] of argRanges) {
    // 块起点必须是 inherit（public/private/active 等其它参数块直接跳过）
    if (tokens[start]?.kind !== 'identifier' || tokens[start].text !== 'inherit') {
      continue;
    }
    // inherit 后必须跟 =
    if (tokens[start + 1]?.kind !== 'operator' || tokens[start + 1].text !== '=') {
      return undefined;
    }
    const ref = tokens[start + 2];
    if (ref === undefined) {
      return undefined; // inherit = 后漏写（代码不完整）
    }

    // 引号字符串写法：inherit = "A"（内容即父类名）
    if (ref.kind === 'string') {
      return { kind: 'string', className: ref.text, offset: ref.offset };
    }

    // 标识符写法：inherit = A 或 inherit = pkg$A
    if (ref.kind === 'identifier') {
      // 沿 $ 链走：名字与 $ 成对出现，每次 +2 移到下一个名字
      let nameIdx = start + 2;
      let isChain = false;
      while (
        tokens[nameIdx + 1]?.kind === 'operator' &&
        tokens[nameIdx + 1].text === '$' &&
        tokens[nameIdx + 2]?.kind === 'identifier'
      ) {
        nameIdx += 2;
        isChain = true;
      }

      // 链尾若是 new 调用（pkg$A$new()，inherit 传实例是非法用法），
      // 父类名取 new 前一个名字，避免把 new 当父类名（与 RHS 求值器的做法一致）
      let clsIdx = nameIdx;
      if (
        isChain &&
        tokens[clsIdx].text === 'new' &&
        tokens[clsIdx + 1]?.kind === 'operator' &&
        tokens[clsIdx + 1].text === '('
      ) {
        clsIdx -= 2;
      }

      // 最终名字后紧跟 '(' → 是函数调用形状（如 inherit = build()），写法不认
      if (tokens[clsIdx + 1]?.kind === 'operator' && tokens[clsIdx + 1].text === '(') {
        return undefined;
      }

      return {
        kind: isChain ? 'chain' : 'name',
        className: tokens[clsIdx].text,
        offset: tokens[clsIdx].offset,
      };
    }

    // 其它形状（表达式等）→ 不认
    return undefined;
  }

  return undefined;
}

/**
 * 按"顶层逗号"把括号内部（开括号之后、闭括号之前）切成子区间数组。
 * 区间为 [openIndex+1, closeIndex)：跳过开括号本身、不含闭括号。
 *
 * 例：R6Class("Persion", public = list(A = a), private = list(C = c), lock_objects = FALSE)
 *     → 切成 4 块：["Persion", "public = list(A = a)", "private = list(C = c)", "lock_objects = FALSE"]
 *     注意：切的是"参数块"，每块内部的逗号（list 里的、{} 里的）不会误切。
 *     是否区名、要不要剔除，由调用方（extractMembers）判断 —— 本函数只负责切块。
 *     （export 供 analysis/box.ts 复用：切 box::use 括号内的模块）
 */
export function splitTopLevel(
  tokens: Token[], // 整个文件 tokenize 的结果
  openIndex: number, // 开括号 '(' 的下标（函数内部从它的下一个开始切）
  closeIndex: number // 配对 ')' 的下标（区间不含它，只作边界）
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // 第一个块的起点 = 开括号的下一个 token（跳过 '(' 本身）
  let stItem = openIndex + 1;
  let depth = 0;
  // 从开括号的下一个开始，扫到闭括号前结束
  for (let j = openIndex + 1; j < closeIndex; j++) {
    const t = tokens[j];
    // 只有运算符参与切分判断（括号进/出深度、逗号分隔），其他 token 跳过
    if (t.kind === 'operator') {
      if (t.text === '(' || t.text === '{' || t.text === '[') {
        depth++; // 进嵌套：里面的逗号不算顶层
      } else if (t.text === ')' || t.text === '}' || t.text === ']') {
        depth--; // 出嵌套
      } else if (t.text === ',' && depth === 0) {
        // 顶层逗号：当前块结束（[stItem, j)），新块从逗号后开始
        ranges.push([stItem, j]);
        stItem = j + 1;
      }
    }
  }
  // 最后一块没有"结尾逗号"触发收尾，所以循环结束后必须手动补上 [stItem, closeIndex)。
  // 反面例子：若不补，R6Class("Persion", public = list(...), private = list(...))
  // 只会切出 ["Persion", "public = list(...)"]，private 块会丢失。
  ranges.push([stItem, closeIndex]);
  return ranges;
}

/**
 * 解析 scope（public/private/active）的 list 内容：按顶层逗号切成员项，每项取名字。
 * @param scopeOpenIndex  scope 的 list 开括号 '(' 下标
 * @param scopeCloseIndex scope 的 list 配对 ')' 下标
 */
function parseMemberList(
  tokens: Token[],
  scopeOpenIndex: number,
  scopeCloseIndex: number,
  scope: R6Scope,
): R6Member[] {
  const members: R6Member[] = [];

  // 复用 splitTopLevel：按顶层逗号把 list 内容切成成员项
  // （方法体/索引里的逗号被括号挡在"非顶层"，不会被误切）
  const itemRanges = splitTopLevel(tokens, scopeOpenIndex, scopeCloseIndex);
  for (const [start] of itemRanges) {
    const m = memberName(tokens, start, scope);
    if (m !== null) {
      members.push(m);
    }
  }

  return members;
}

/**
 * 从成员项中取成员名：取第一个 token（合法写法下它就是成员名）。
 * 第一个 token 不是标识符（代码不合法）→ 返回 null，由调用方跳过。
 */
function memberName(tokens: Token[], stIndex: number, scope: R6Scope): R6Member | null {
  // 合法代码里成员项的第一个 token 就是成员名；
  // 只有代码不合法时第一个 token 才不是标识符 —— 这种情况直接返回 null，不处理。
  const t = tokens[stIndex];
  if (t.kind === 'identifier') {
    return { name: t.text, scope, nameOffset: t.offset };
  }
  return null;
}

/** 判断标识符文本是否是 R6 的区名；是则返回区名，否则返回 null */
function scopeOf(text: string): R6Scope | null {
  return text === 'public' || text === 'private' || text === 'active' ? text : null;
}

/**
 * 生成合成成员（v1 只含 new）。
 * R6 语义：`$new()` 是自动构造函数；类里定义了 initialize 则 new 调用它，
 * 没定义则 new 用默认空构造 —— 所以 new 的跳转目标：有 initialize 指向 initialize，
 * 没有则指向类名（跳到类定义处）。
 */
function buildSynthetic(members: R6Member[], classNameOffset: number): SyntheticMember[] {
  // 查找这个R6类是否定义了initialize函数
  const initialize = members.find(
    (m) => m.name === 'initialize' && m.scope === 'public',
  );

  // 如果R6定义了initialize函数，那点击Person$new()时会跳转到initialize
  // 如果R6没定义initialize函数，那点击Person$new()时会跳转到Person
  return [
    {
      name: 'new',
      nameOffset: initialize !== undefined ? initialize.nameOffset : classNameOffset,
    },
  ];
}
