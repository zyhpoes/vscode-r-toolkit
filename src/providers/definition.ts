/**
 * 定义跳转 Provider（边界层：全项目唯一允许碰 vscode 的地方之一）。
 * 职责：把纯逻辑（resolveClassDefinition）翻译成 VS Code 的跳转结果。
 * 不含任何解析逻辑 —— 解析都在核心层（analysis/definitions.ts），已单测。
 */

import * as vscode from 'vscode';
import { resolveClassDefinition } from '../analysis/definitions';
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

    // 调纯逻辑
    const def = resolveClassDefinition(text, cursorOffset);

    // 未命中 → null（编辑器显示"未找到定义"）
    if (def === null) {
      return null;
    }

    // 命中 → 包装成 Location（哪个文件的哪个位置），交给编辑器跳转
    const target = new vscode.Position(def.line, def.character);
    return new vscode.Location(document.uri, target);
  }
}
