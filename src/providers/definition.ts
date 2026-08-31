/**
 * 定义跳转 Provider（边界层：全项目唯一允许碰 vscode 的地方之一）。
 * 职责：把纯逻辑（resolveClassDefinition / resolveMemberDefinition）翻译成 VS Code 的跳转结果。
 * 不含任何解析逻辑 —— 解析都在核心层（analysis/），已单测。
 */

import * as vscode from 'vscode';
import { resolveClassDefinition } from '../analysis/definitions';
import { resolveMemberDefinition } from '../analysis/members';
import { TextLines } from '../utils/text';

/** 实现 VS Code 的"定义提供者"接口：Ctrl+点击 / F12 时被编辑器调用 */
export class R6DefinitionProvider implements vscode.DefinitionProvider {
  /**
   * @param document 当前文档（R 源码）
   * @param position 光标位置（行列）
   * @returns 跳转目标；未命中返回 null
   */
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Definition> {
    // 取文档全文
    const text = document.getText();

    // 光标位置（行列）→ 偏移量（纯逻辑只认偏移量）
    const cursorOffset = new TextLines(text).offsetAt(position.line, position.character);

    // 先试成员跳转（self$xxx / private$xxx / 类名$xxx 的成员部分）
    const memberDef = resolveMemberDefinition(text, cursorOffset);
    if (memberDef !== null) {
      const target = new vscode.Position(memberDef.line, memberDef.character);
      return new vscode.Location(document.uri, target);
    }

    // 再试类名跳转（类名本身）
    const classDef = resolveClassDefinition(text, cursorOffset);
    if (classDef !== null) {
      const target = new vscode.Position(classDef.line, classDef.character);
      return new vscode.Location(document.uri, target);
    }

    // 都不是 → null（编辑器显示"未找到定义"）
    return null;
  }
}
