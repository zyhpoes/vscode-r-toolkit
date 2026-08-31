/**
 * 成员定义解析：给定 R 代码文本和光标偏移量，判断光标下的成员引用
 * （self$xxx / private$xxx / 类名$xxx）指向哪个成员定义。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 */

import { tokenize } from '../parser/tokenizer';
import { parseR6, type R6ClassDef, type R6Member, type R6Scope } from '../parser/r6-parser';
import { TextLines } from '../utils/text';

/** 命中结果：成员名 + 定义位置（行列，0 起） */
export interface MemberDefinition {
  name: string;
  line: number;
  character: number;
}

/**
 * 解析光标处的成员定义。
 * @param text         R 代码全文
 * @param cursorOffset 光标偏移量
 * @returns 命中返回成员定义位置；未命中返回 null
 */
export function resolveMemberDefinition(text: string, cursorOffset: number): MemberDefinition | null {
  const tokens = tokenize(text);

  // 找光标下的 identifier（findIndex 返回下标）
  const wordIdx = tokens.findIndex(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
  if (wordIdx === -1) {
    return null;
  }
  const word = tokens[wordIdx];

  // 向前找紧邻的 '$'（wordIdx-1 必须是 '$'，否则不是成员引用）
  const dollar = tokens[wordIdx - 1];
  if (dollar?.kind !== 'operator' || dollar.text !== '$') {
    return null;
  }

  // 看 '$' 前是什么，确定"查哪个类、哪个区"
  const before = tokens[wordIdx - 2];
  if (before?.kind !== 'identifier') {
    return null;
  }

  const classes = parseR6(text);

  // 三种情况：self$ / private$ / 类名$
  let targetClass: R6ClassDef | undefined;
  let scopes: R6Scope[];

  if (before.text === 'self' || before.text === 'private') {
    // 位置反查：self/private 所在的 token 落在哪个类的调用范围内
    targetClass = classes.find((c) => c.stIndex <= wordIdx && wordIdx <= c.enIndex);
    scopes = before.text === 'self' ? ['public', 'active'] : ['private'];
  } else {
    // 类名$：按类名查
    targetClass = classes.find((c) => c.name === before.text);
    scopes = ['public', 'active'];
  }

  if (targetClass === undefined) {
    return null;
  }

  // 在对应区里找同名成员
  const member = targetClass.members.find(
    (m: R6Member) => m.name === word.text && scopes.includes(m.scope),
  );
  if (member === undefined) {
    return null;
  }

  // 把成员名偏移量换算成行列
  const pos = new TextLines(text).positionAt(member.nameOffset);
  return { name: member.name, line: pos.line, character: pos.character };
}
