/**
 * box 导入解析：从 R 代码文本中提取 `box::use(...)` 导入的模块。
 * 纯逻辑：只分析文本，不读文件、不解析路径、不依赖 vscode。
 *
 * 用途：跨文件跳转的第一步 —— 知道当前文件依赖了哪些 box 模块，
 * 才能定位要去哪个文件找类定义。
 */

import { tokenize, type Token } from '../parser/tokenizer';
import { splitTopLevel } from '../parser/r6-parser';

/** 模块路径的基准：从哪找模块文件 */
export type BoxRelative = 'root' | 'file';

/** 一条 box 导入 */
export interface BoxImport {
  /** 路径（含 / 层级；./ 已去掉、../ 原样保留、[导出] 已去掉） */
  modulePath: string;
  /** 基准：root = 项目根；file = 相对当前文件目录（../ 层数由 path.resolve 计算） */
  relative: BoxRelative;
  /** box 关键字的位置 */
  offset: number;
}

/** 解析文本中所有 box::use 导入（按出现顺序） */
export function parseBoxImports(text: string): BoxImport[] {
  const tokens = tokenize(text);
  const result: BoxImport[] = [];

  for (let i = 0; i < tokens.length; i++) {
    // 找 `box :: use (` 模式
    if (!isBoxUseStart(tokens, i)) {
      continue;
    }

    // use 的 '(' 下标 = i + 3（box :: use (）
    const openIndex = i + 3;
    const open = tokens[openIndex];
    if (open === undefined || open.kind !== 'operator' || open.text !== '(') {
      continue;
    }

    // 找配对的 ')'（数圆括号深度）
    const close = findCloseParen(tokens, openIndex);
    if (close === -1) {
      continue; // 括号没配对（代码不完整），跳过
    }

    // 括号内按顶层逗号切成模块段，逐段解析
    const segments = splitTopLevel(tokens, openIndex + 1, close);
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

/** 从 openIndex（'(' 下标）数圆括号深度，找配对 ')'；没配对返回 -1 */
function findCloseParen(tokens: Token[], openIndex: number): number {
  let depth = 1;
  for (let j = openIndex + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind !== 'operator') {
      continue;
    }
    if (t.text === '(') {
      depth++;
    } else if (t.text === ')') {
      depth--;
      if (depth === 0) {
        return j;
      }
    }
  }
  return -1;
}

/**
 * 解析一个模块段（从 stSegment 开始）为 BoxImport。
 * 段内 token 形如：person、person [ Person ]、./helper、../utils/x、
 * "person/utils/x"（带引号）、"person/utils/x"[Person]（引号 + 导出）
 */
function parseSegment(tokens: Token[], stSegment: number, boxOffset: number): BoxImport | null {
  const first = tokens[stSegment];
  if (first === undefined) {
    return null;
  }

  // 带引号写法："person/utils/x" 是一个 string token，内容直接就是完整路径
  if (first.kind === 'string') {
    // 防御：合法写法是 `"path"[Person]`（导出列表在引号外）。
    // 万一用户误写成 `"path[Person]"`（把导出列表写进引号里，这是非法写法，
    // box 运行时会报错），这里剥掉字符串里误带的 [导出]，避免路径带上脏内容找错文件。
    const bracketIdx = first.text.indexOf('[');
    const modulePath = bracketIdx === -1 ? first.text : first.text.slice(0, bracketIdx);
    return { modulePath, relative: 'root', offset: boxOffset };
  }

  // 不带引号：段首必须是标识符（模块路径起点；./ 的 . 和 ../ 的 .. 也是标识符）
  if (first.kind !== 'identifier') {
    return null;
  }

  // 收集段内连续路径 token，拼成路径字符串。
  // 注意：'.' / '..' 在 R 里是合法标识符开头，tokenizer 把它们切成 identifier（如 "./" 的 . 是 identifier）；
  // 所以路径字符实际只有两类要收：identifier（person、proj、.、..）和 '/'（operator，层级分隔）。
  let pathText = '';
  for (let j = stSegment; j < tokens.length; j++) {
    const t = tokens[j];
    // 遇到 [ 表示开始导出列表，路径结束
    if (t.kind === 'operator' && t.text === '[') {
      break;
    }
    // 收路径字符：标识符（含 . 和 ..）或 '/'；其他 token（, ) 等）→ 路径结束
    if (t.kind === 'identifier') {
      pathText += t.text;
    } else if (t.kind === 'operator' && t.text === '/') {
      pathText += t.text;
    } else {
      break;
    }
  }

  if (pathText === '') {
    return null;
  }

  // 分类基准：./ 开头 → file（去掉 ./）；../ 开头 → file（保留）；无前缀 → root
  if (pathText.startsWith('./')) {
    return { modulePath: pathText.slice(2), relative: 'file', offset: boxOffset };
  }
  if (pathText.startsWith('../')) {
    return { modulePath: pathText, relative: 'file', offset: boxOffset };
  }
  return { modulePath: pathText, relative: 'root', offset: boxOffset };
}
