/**
 * 定义跳转 Provider（边界层：全项目唯一允许碰 vscode 的地方之一）。
 * 职责：把纯逻辑（resolveClassDefinition / resolveMemberDefinition）翻译成 VS Code 的跳转结果。
 * 不含解析逻辑 —— 解析都在核心层（analysis/），已单测。
 * 额外职责（边界层）：读取 box 依赖文件，让查询能跨文件找类。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveClassDefinition } from '../analysis/definitions';
import { resolveMemberDefinition } from '../analysis/members';
import { parseBoxImports, type BoxImport } from '../analysis/box';
import { TextLines } from '../utils/text';
import type { SourceFile } from '../analysis/source-file';

/** 实现 VS Code 的"定义提供者"接口：Ctrl+点击 / F12 时被编辑器调用 */
export class R6DefinitionProvider implements vscode.DefinitionProvider {
  /**
   * @param document 当前文档（R 源码）
   * @param position 光标位置（行列）
   * @returns 跳转目标；未命中返回 null
   */
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | null> {
    // 当前文件的 uri 和全文
    const uri = document.uri.toString();
    const text = document.getText();

    // 文件列表 = 当前文件 + box 依赖文件（跨文件查找的原料）
    const files: SourceFile[] = [{ uri, text }];
    const deps = await loadDependencyFiles(document);
    files.push(...deps);

    // 光标位置（行列）→ 偏移量（纯逻辑只认偏移量）
    const cursorOffset = new TextLines(text).offsetAt(position.line, position.character);

    // 先试成员跳转（self$xxx / private$xxx / 类名$xxx 的成员部分）
    const memberDef = resolveMemberDefinition(files, uri, cursorOffset);
    if (memberDef !== null) {
      const target = new vscode.Position(memberDef.line, memberDef.character);
      return new vscode.Location(vscode.Uri.parse(memberDef.uri), target);
    }

    // 再试类名跳转（类名本身）
    const classDef = resolveClassDefinition(files, uri, cursorOffset);
    if (classDef !== null) {
      const target = new vscode.Position(classDef.line, classDef.character);
      return new vscode.Location(vscode.Uri.parse(classDef.uri), target);
    }

    // 都不是 → null（编辑器显示"未找到定义"）
    return null;
  }
}

/** 读取当前文件的 box 依赖文件，返回 [{uri, text}]；读取失败的文件静默跳过 */
async function loadDependencyFiles(document: vscode.TextDocument): Promise<SourceFile[]> {
  const imports = parseBoxImports(document.getText());
  const deps: SourceFile[] = [];

  for (const imp of imports) {
    const fileUri = resolveModuleFileUri(imp, document);
    if (fileUri === undefined) {
      continue; // 路径解析不出来（如项目根未知），跳过
    }
    try {
      const depDoc = await vscode.workspace.openTextDocument(fileUri);
      deps.push({ uri: depDoc.uri.toString(), text: depDoc.getText() });
    } catch {
      // 文件不存在 / 读不了 → 跳过（不报错，避免打扰用户）
    }
  }

  return deps;
}

/**
 * 把 box 导入解析成真实文件 uri。
 * - relative 'file'：相对当前文件目录（path.resolve 处理 ../ 层数）
 * - relative 'root'：相对项目根（第一版用工作区根兜底，box.path 解析后续加）
 * 文件规则：先找 <路径>.R，找不到再试 <路径>/<路径>.R（box 目录模块）
 */
function resolveModuleFileUri(imp: BoxImport, document: vscode.TextDocument): vscode.Uri | undefined {
  const baseDir = imp.relative === 'file'
    ? path.dirname(document.uri.fsPath)
    : workspaceRoot();

  if (baseDir === undefined) {
    return undefined;
  }

  // 规范化路径（path.resolve 处理 ../ 和 ./）
  const resolved = path.resolve(baseDir, imp.modulePath);

  // 试两种文件形态：person.R 或 person/person.R
  const candidates = [
    vscode.Uri.file(`${resolved}.R`),
    vscode.Uri.file(path.join(resolved, path.basename(resolved) + '.R')),
  ];

  // 返回第一个存在的候选（用 fs 同步判断存在性）
  for (const cand of candidates) {
    if (fs.existsSync(cand.fsPath)) {
      return cand;
    }
  }
  return undefined;
}

/** 项目根：第一版用工作区第一个文件夹；没有工作区返回 undefined */
function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}
