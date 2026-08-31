/**
 * 定义解析：给定 R 代码文本和光标偏移量，判断光标下是否是 R6 类名，
 * 是则返回类定义的位置（行、列）。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { tokenize } from '../parser/tokenizer';
import { parseR6 } from '../parser/r6-parser';
import { TextLines } from '../utils/text';

/** 命中结果：类名 + 定义位置（行列，0 起） */
export interface ClassDefinition {
  name: string;       // 类名
  line: number;       // 行号
  character: number;  // 列号(根据AI的说法这里采用character而不是columns是因为VS Code 官方就叫 character)
}

/**
 * 解析光标处的类定义。
 * @param text         R 代码全文
 * @param cursorOffset 光标偏移量（第几个字符）
 * @returns 命中返回定义位置；未命中返回 null
 */
export function resolveClassDefinition(text: string, cursorOffset: number): ClassDefinition | null {
  // 找光标下的词：覆盖光标位置的 identifier token
  // 边界用半开区间 [offset, offset+长度)：光标在词开头算命中，在词末尾不算
  const tokens = tokenize(text);
  const word = tokens.find(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
  if (word === undefined) {
    return null;
  }

  // 这个词是不是类名：在 parseR6 的类清单里按名字匹配
  const cls = parseR6(text).find((c) => c.name === word.text);
  if (cls === undefined) {
    return null;
  }

  // 把类名的偏移量换算成行列（VS Code 跳转需要的格式）
  const pos = new TextLines(text).positionAt(cls.nameOffset);
  return { name: cls.name, line: pos.line, character: pos.character };
}
