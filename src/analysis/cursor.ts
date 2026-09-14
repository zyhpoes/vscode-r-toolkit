/**
 * 光标定位查询：判断"光标落在文本的哪个地方"的通用能力。
 * 纯逻辑：不依赖 vscode，可在纯 Node 中测试。
 *
 * 归属约定：本文件只放"与光标位置有关"的查询（取光标下的词、将来可能的
 * 取光标前一个 token 之类）。与具体功能无关的工具不要塞进来 ——
 * 它是"光标定位"的家，不是杂物抽屉。
 */

import type { AnalysisContext } from './context';

/**
 * 找光标下的标识符（identifier）token 的下标。
 * 边界用半开区间 [offset, offset + 长度)：光标落在词开头算命中，落在词末尾不算
 * （即 `Person|$` 这种"光标贴在词尾"不算踩在这个词上）。
 * 之所以返回下标而不是 token：成员跳转还要用下标回看前两个 token
 * （'$' 与 '$' 前面的那个词）。
 * @returns 命中返回 token 在 ctx.cursorTokens 里的下标；光标不在任何标识符上 → -1
 */
export function findWordIndexAt(ctx: AnalysisContext, cursorOffset: number): number {
  return ctx.cursorTokens.findIndex(
    (t) =>
      t.kind === 'identifier' &&
      t.offset <= cursorOffset &&
      cursorOffset < t.offset + t.text.length,
  );
}
