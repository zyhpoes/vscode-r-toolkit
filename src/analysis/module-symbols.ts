/**
 * 模块成员：box 模块文件里的**顶层符号**（函数 / 常量 / R6 类）。
 * 纯逻辑：不读文件（模块文本从 ctx 里那份已加载的文件取），不依赖 vscode。
 *
 * 可见性规则见 docs/box-模块规则.md 的「我们的 v1 规则」：**宽松版** ——
 * 不看 `#' @export`、也不看 `box::export()`，把每个模块都当 box 的 legacy module
 * （顶层非隐藏名全部可见）。理由：静态工具负责"导航"，不负责"运行时校验"；
 * 按 box 严格规则做，模块里只要出现一个 `@export`，其余名字就全都跳不了 ——
 * "函数明明就在那个文件里，F12 却没反应"是最恼火的失败方式。
 */

import type { Token } from '../parser/tokenizer';
import type { AnalysisContext } from './context';
import { findWordIndexAt } from './cursor';
import { definitionSiteAt, type DefinitionSite } from './definitions';

/** 模块里的一个顶层符号 */
export interface TopLevelSymbol {
  /** 名字（赋值号左边那个） */
  name: string;
  /** 名字在模块文件里的偏移（就是跳转目标） */
  offset: number;
}

/**
 * 从**已有 token** 里取顶层符号（按出现顺序；同名多次赋值会都出现，调用方取第一个即可）。
 * 切词由调用方负责（provider 切光标文件、parseSourceFile 切依赖文件，全项目只有这两处切词）。
 *
 * "顶层"靠**括号深度**判断，与缩进无关：只有在深度 0 出现的 `名字 <- ...` / `名字 = ...` 才算。
 * 这样函数体内部的 `bar <- 1`、调用里的具名参数 `f(a = 1)` 都自然被排除。
 */
export function parseTopLevelSymbols(tokens: Token[]): TopLevelSymbol[] {
  const symbols: TopLevelSymbol[] = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === 'operator') {
      depth += bracketDepthDelta(token.text);
      continue;
    }

    if (depth !== 0 || token.kind !== 'identifier' || isHidden(token.text)) {
      continue;
    }
    if (!isAssignOperator(tokens[i + 1])) {
      continue;
    }
    symbols.push({ name: token.text, offset: token.offset });
  }

  return symbols;
}

/**
 * `模块$成员` 的成员跳转：光标踩在 `$` 后面的名字上时，去该模块文件里找同名顶层符号。
 *
 * @param moduleUriByBinding 模块绑定名 → 模块文件 uri。绑定名是"本文件里这个模块叫什么"
 *        （`box::use(R/schema/schema)` → `schema`；`box::use(m = ...)` → `m`），
 *        它对应哪个文件只有 provider 层（要读盘）知道，所以由调用方查好后传进来。
 * @returns 命中结果；不在 `模块$成员` 形状上、或模块/成员找不到 → null（交给别的分支）
 */
export function resolveModuleMemberDefinition(
  ctx: AnalysisContext,
  cursorOffset: number,
  moduleUriByBinding: Map<string, string>,
): DefinitionSite | null {
  const wordIndex = findWordIndexAt(ctx, cursorOffset);
  if (wordIndex === -1) {
    return null;
  }

  // 形状必须是 `绑定名 $ 成员名`
  const memberToken = ctx.cursorFile.tokens[wordIndex];
  const dollarToken = ctx.cursorFile.tokens[wordIndex - 1];
  const bindingToken = ctx.cursorFile.tokens[wordIndex - 2];
  if (dollarToken?.text !== '$' || bindingToken?.kind !== 'identifier') {
    return null;
  }

  const moduleUri = moduleUriByBinding.get(bindingToken.text);
  if (moduleUri === undefined) {
    return null; // 这个绑定名不是本文件的 box 模块（可能是 R6 类名等）
  }

  const moduleFile = ctx.parsed.find((parsed) => parsed.file.uri === moduleUri);
  if (moduleFile === undefined) {
    return null; // 模块文件没被加载（读不出来），跳不了
  }

  // 顶层符号在 ctx 组装时就随 parseSourceFile 算好了（每文件一份），这里查缓存、不重解析
  const symbol = moduleFile.symbols.find((one) => one.name === memberToken.text);
  if (symbol === undefined) {
    return null; // 模块里没有这个顶层名字
  }

  return definitionSiteAt(symbol.name, moduleFile, symbol.offset);
}

/** 括号对深度的贡献：开括号 +1、闭括号 -1、其它运算符 0 */
function bracketDepthDelta(text: string): number {
  if (text === '(' || text === '{' || text === '[') {
    return 1;
  }
  if (text === ')' || text === '}' || text === ']') {
    return -1;
  }
  return 0;
}

/** 是不是赋值号：`<<-` 不算（它写的是全局变量，不是模块的符号） */
function isAssignOperator(token: Token | undefined): boolean {
  return token?.kind === 'operator' && (token.text === '<-' || token.text === '=');
}

/** R 的隐藏名：以 `.` 开头（box 的 legacy 规则同样不导出它们） */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}
