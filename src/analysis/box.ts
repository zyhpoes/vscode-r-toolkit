/**
 * box 导入解析：从 R 代码文本中提取 `box::use(...)` 导入的模块。
 * 纯逻辑：只分析文本，不读文件、不解析路径、不依赖 vscode。
 *
 * 用途：跨文件跳转的第一步 —— 知道当前文件依赖了哪些 box 模块，
 * 才能定位要去哪个文件找类定义。
 */

import { type Token } from '../parser/tokenizer';
import { matchBracket } from '../parser/brackets';
import { nextNonComment, nextNonCommentIndex } from '../parser/token-utils';
import { splitTopLevel } from '../parser/r6-parser';

/** 模块路径的基准：从哪找模块文件 */
export type BoxRelative = 'root' | 'file';

/** 模块路径里的一段（如 `R/schema/schema` 的三段） */
export interface ModuleSegment {
  /** 段名：'R' / 'schema' / '.' / '..'（`./x` 的前导 . 会在解析时去掉） */
  name: string;
  /** 这一段在原文中的偏移（用于判断光标落在哪一段上） */
  offset: number;
}

/** 附着清单里的一个名字：别名（本地名）↔ 模块内的名字（两侧通常同名） */
export interface BoxAttachName {
  /** 别名（左侧）：进当前作用域、代码里直接写的那个名字 */
  alias: string;
  /** 模块内的名字（右侧）：`[g = f]` 的 f；只写 `[a]` 时等于 alias */
  source: string;
}

/** 附着清单 `[...]`：把模块里的某些名字直接引进当前作用域（不需要 `模块$` 前缀） */
export interface BoxAttach {
  /**
   * 明确列出的名字：`[a, b]` → a/a、b/b；`[g = f]` → 别名 g、模块内名 f。
   * 跳转时用 alias 找"这名字哪来的"，到模块文件里找定义时用 source。
   */
  names: BoxAttachName[];
  /** 含 `...`（附着模块的全部导出名）；具体名字静态未知，所以只记这个事实 */
  all: boolean;
}

/** 一条 box 导入 */
export interface BoxImport {
  /** 路径分段（`R/schema/schema` → 三段；引号写法整串算一段）；`[附着清单]` 不算在内 */
  segments: ModuleSegment[];
  /** 基准：root = 候选根（box 根）；file = 相对当前文件目录 */
  relative: BoxRelative;
  /** 别名（`m = R/model/base` 里的 m）；没写别名 → undefined */
  alias: string | undefined;
  /** 附着清单；没写 `[...]` → undefined */
  attach: BoxAttach | undefined;
  /** box 关键字的位置 */
  offset: number;
}

/** 模块路径字符串：各段用 '/' 连接（= box::use 里写的路径，前导 ./ 已去掉） */
export function modulePathOf(imp: BoxImport): string {
  return imp.segments.map((segment) => segment.name).join('/');
}

/**
 * 这条导入在当前作用域绑定的"模块名"（代码里 `schema$xxx` 的 schema 就是它）。
 * 规则：写了附着清单 `[a, b]` → **不绑模块名**（R 里那些名字是裸名字，没有 `pkg$`）；
 *       否则默认取路径最后一段，写了别名则取别名。
 * @returns 模块绑定名；不绑模块名（附着写法）→ undefined
 */
export function moduleBindingName(imp: BoxImport): string | undefined {
  if (imp.attach !== undefined) {
    return undefined;
  }
  return imp.alias ?? imp.segments[imp.segments.length - 1]?.name;
}

/**
 * 光标（token 起点偏移）踩在哪个导入的哪一段上 —— 模块名跳转的入口查询。
 * 用"**精确相等**"而不是区间判断：段的 offset 就是那个 token 的起点，
 * 裸路径对标识符 token、引号路径对 string token（起点是开引号）都成立，
 * 于是完全不需要长度/边界的换算，也就没有 off-by-one 的空间。
 * @param imports parseBoxImports 的结果
 * @param offset  光标所在 token 的起点偏移
 * @returns 命中的导入与段号（0 起）；不在任何段上 → undefined
 */
export function segmentAtOffset(
  imports: BoxImport[],
  offset: number,
): { imp: BoxImport; segmentIndex: number } | undefined {
  for (const imp of imports) {
    const segmentIndex = imp.segments.findIndex((segment) => segment.offset === offset);
    if (segmentIndex !== -1) {
      return { imp, segmentIndex };
    }
  }
  return undefined;
}

/**
 * 从**已有 token** 里解析所有 box::use 导入（按出现顺序）。
 * 切词由调用方负责（provider 切光标文件、parseSourceFile 切依赖文件，全项目只有这两处切词）。
 */
export function parseBoxImports(tokens: Token[]): BoxImport[] {
  const result: BoxImport[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // 找 `box :: use (` 模式
    if (!isBoxUseStart(tokens, i)) {
      continue;
    }

    // use 的 '(' 下标 = i + 3（box :: use (）
    const openIndex = i + 3;
    const openToken = tokens[openIndex];
    if (openToken === undefined || openToken.kind !== 'operator' || openToken.text !== '(') {
      continue;
    }

    // 找配对的 ')'（复用 parser 的括号工具：数同类括号深度，没配对返回 -1）
    const closeIndex = matchBracket(tokens, openIndex, '(');
    if (closeIndex === -1) {
      continue; // 括号没配对（代码不完整），跳过
    }

    // 括号内按顶层逗号切成模块段，逐段解析
    const segments = splitTopLevel(tokens, openIndex, closeIndex);
    for (const [segStart] of segments) {
      const imp = parseSegment(tokens, segStart, tokens[i].offset);
      if (imp !== null) {
        result.push(imp);
      }
    }
  }

  return result;
}

/** 判断 tokens[i] 是否是 `box :: use` 的开头 */
function isBoxUseStart(tokens: Token[], i: number): boolean {
  return (
    tokens[i]?.kind === 'identifier' && tokens[i].text === 'box' &&
    tokens[i + 1]?.kind === 'operator' && tokens[i + 1].text === '::' &&
    tokens[i + 2]?.kind === 'identifier' && tokens[i + 2].text === 'use'
  );
}

/**
 * 解析一个条目 → BoxImport（只做编排：可选别名 + 模块路径 + 附着清单）。
 * 条目形如：person、./helper、../utils/x、"person/utils/x"、
 * m = R/model/base（别名）、R/model/base[BaseModel]（附着清单）。
 */
function parseSegment(tokens: Token[], stSegment: number, boxOffset: number): BoxImport | null {
  // 可选别名：`m = R/model/base` 里 `=` 前是别名，路径从 `=` 之后开始
  const alias = readEntryAlias(tokens, stSegment);
  const stPath = alias === undefined ? stSegment : stSegment + 2;

  const path = readModulePath(tokens, stPath);
  if (path === null) {
    return null;
  }

  // 从路径停下的位置接着读附着清单（每段 token 只读一次，不重复扫描）
  const attach = readAttachList(tokens, path.enIndex);

  return {
    segments: path.segments,
    relative: path.relative,
    alias,
    attach,
    offset: boxOffset,
  };
}

/** 读条目开头的别名（`m = path` → 'm'）；没有别名 → undefined */
function readEntryAlias(tokens: Token[], stSegment: number): string | undefined {
  const first = tokens[stSegment];
  const second = tokens[stSegment + 1];
  if (first?.kind === 'identifier' && second?.kind === 'operator' && second.text === '=') {
    return first.text;
  }
  return undefined;
}

/**
 * 读模块路径：返回路径分段、基准（root = 候选根；file = 相对当前文件目录）
 * 以及**停在了哪个 token**（enIndex，供调用方接着读附着清单）。
 * 支持两种写法：不带引号（`R/schema/schema`，`.` / `..` 也是合法段）与带引号（整串算一段）。
 * 走到非路径 token（`[`、`,`、`)` 等）就停；形状不合法 → null。
 */
function readModulePath(
  tokens: Token[],
  stPath: number,
): { segments: ModuleSegment[]; relative: BoxRelative; enIndex: number } | null {
  const first = tokens[stPath];
  if (first === undefined) {
    return null;
  }

  // 带引号写法："person/utils/x" 是一个 string token，内容直接就是完整路径（整串算一段）
  if (first.kind === 'string') {
    // 防御：合法写法是 `"path"[Person]`（导出列表在引号外）。
    // 万一用户误写成 `"path[Person]"`（把导出列表写进引号里，这是非法写法，
    // box 运行时会报错），这里剥掉字符串里误带的 [导出]，避免路径带上脏内容找错文件。
    const bracketIdx = first.text.indexOf('[');
    const name = bracketIdx === -1 ? first.text : first.text.slice(0, bracketIdx);
    if (name === '') {
      return null;
    }
    // 引号后面一个 token 就是路径之外（可能是 `[`）
    return { segments: [{ name, offset: first.offset }], relative: 'root', enIndex: stPath + 1 };
  }

  // 不带引号：路径起点必须是标识符（person、proj；./ 的 . 和 ../ 的 .. 也是标识符）
  if (first.kind !== 'identifier') {
    return null;
  }

  // 收路径分段：只认标识符（段名）与 '/'（层级分隔），遇到其他 token 就结束
  const segments: ModuleSegment[] = [];
  let j = stPath;
  for (; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === 'operator' && t.text === '[') {
      break; // 开始附着清单 → 路径结束
    }
    if (t.kind === 'identifier') {
      segments.push({ name: t.text, offset: t.offset });
      continue;
    }
    if (t.kind === 'operator' && t.text === '/') {
      continue;
    }
    break; // 其他 token（, ) 等）→ 路径结束
  }
  // 停在哪个 token：终止符本身，或数组末尾（越界）
  const enIndex = j;

  if (segments.length === 0) {
    return null;
  }

  // './x'：前导的 '.' 只是"相对当前文件"的标记，不是路径段 → 去掉
  const stIsDot = segments[0].name === '.';
  if (stIsDot) {
    segments.shift();
  }
  if (segments.length === 0) {
    return null;
  }

  // 基准：'./' 或 '../' 开头 → 相对当前文件目录；其余 → 候选根
  const relative: BoxRelative = stIsDot || segments[0].name === '..' ? 'file' : 'root';
  return { segments, relative, enIndex };
}

/**
 * 读附着清单：openIndex 处若是 `[`，解析里面的名字。
 * `[a, b]` → 两个名字（别名与模块内名同名）；`[g = f]` → 别名 g、模块内名 f；
 * `[...]` → all = true。没有清单 / `[` 没配对 → undefined。
 * @param openIndex 期望是 `[` 的下标；调用方给的是"路径读完停下的位置"，
 *                  可能是 `)` / `,` / 越界，所以函数自己要先校验一次
 */
function readAttachList(tokens: Token[], openIndex: number): BoxAttach | undefined {
  const openToken = tokens[openIndex];
  if (openToken?.kind !== 'operator' || openToken.text !== '[') {
    return undefined;
  }

  const closeIndex = matchBracket(tokens, openIndex, '[');
  if (closeIndex === -1) {
    return undefined; // 括号没配对（代码不完整）→ 不当有清单
  }

  const names: BoxAttachName[] = [];
  let all = false;
  for (const [stItemIndex, enItemIndex] of splitTopLevel(tokens, openIndex, closeIndex)) {
    const aliasIndex = nextNonCommentIndex(tokens, stItemIndex);
    if (aliasIndex === undefined) {
      continue; // 空块（`[a,]` 的尾块）或整块只有注释
    }
    const aliasToken = tokens[aliasIndex];
    if (aliasToken.kind !== 'identifier') {
      continue; // `[1]`、`["a"]` 这类认不出来的写法：宁可漏记，也不乱记
    }
    if (aliasToken.text === '...') {
      all = true; // 附着全部导出名（具体名字静态未知）
      continue;
    }
    names.push({ alias: aliasToken.text, source: readAttachSource(tokens, aliasIndex, enItemIndex) });
  }

  return { names, all };
}

/**
 * 读一个附着项里"模块内的名字"（来源名，右侧）：`g = f` → 'f'；只写 `a` → 'a'（两侧同名）。
 * @param aliasIndex   本项第一个名字（别名，左侧）的下标
 * @param enItemIndex  本项区间的终点（不含），由 splitTopLevel 给出，防止找 `=` 时串到下一项
 */
function readAttachSource(tokens: Token[], aliasIndex: number, enItemIndex: number): string {
  const aliasToken = tokens[aliasIndex];
  for (let j = aliasIndex + 1; j < enItemIndex; j++) {
    const t = tokens[j];
    if (t.kind !== 'operator' || t.text !== '=') {
      continue;
    }
    // 右侧写了名字就用它；没写 / 写坏了（`[g = ]`、`[g = "f"]`）→ 退回别名，两侧同名
    const source = nextNonComment(tokens, j + 1);
    return source?.kind === 'identifier' ? source.text : aliasToken.text;
  }
  return aliasToken.text; // 没写 `=`
}
