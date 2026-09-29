/**
 * 定义跳转 Provider（边界层：全项目唯一允许碰 vscode 的地方之一）。
 * 职责：把纯逻辑（resolveMemberDefinition / resolveClassDefinition / resolveVariableDefinition）
 * 翻译成 VS Code 的跳转结果。
 * 不含解析逻辑 —— 解析都在核心层（analysis/），已单测。
 * 原料装配（含读 box 依赖文件）由 providers/context.ts 统一提供，与补全共用。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  resolveClassDefinition,
  resolveVariableDefinition,
  type DefinitionSite,
} from '../analysis/definitions';
import { resolveMemberDefinition } from '../analysis/members';
import type { AnalysisContext } from '../analysis/context';
import { findWordIndexAt } from '../analysis/cursor';
import { segmentAtOffset, type BoxImport } from '../analysis/box';
import {
  resolveAttachNameDefinition,
  resolveModuleBindingFile,
  resolveModuleMemberDefinition,
} from '../analysis/module-symbols';
import { buildQueryInput, resolveImportFilePath } from './context';

/** 实现 VS Code 的"定义提供者"接口：Ctrl+点击 / F12 时被编辑器调用 */
export class R6DefinitionProvider implements vscode.DefinitionProvider {
  private readonly output: vscode.OutputChannel;

  /**
   * @param output 诊断输出通道：box 模块找不到、每次跳转命中了哪个分支，都写进去（不静默失败）
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * @param document 当前文档（R 源码）
   * @param position 光标位置（行列）
   * @returns 跳转目标；未命中返回 null
   */
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | null> {
    // 装配原料（切词 / 导入 / 候选根 / box 依赖 / 每文件解析一次 / 组装 ctx）。
    // 与补全共用同一条管线，见 providers/context.ts
    const { ctx, cursorOffset, imports, rootDirs, boxModules } = await buildQueryInput(
      document,
      position,
      this.output,
    );

    // 先试模块跳转：光标踩在 box::use(...) 的某一段上 → 跳那个模块文件
    // （放在最前面：用户在 import 路径上点击，意图明确就是"去这个模块"）
    const moduleFile = locateModuleFile(ctx, cursorOffset, imports, document, rootDirs);
    if (moduleFile !== null) {
      const location = moduleFileLocation(vscode.Uri.file(moduleFile));
      this.logHit('模块', location);
      return location;
    }

    // 再试"模块绑定名"本身：`schema$xxx` 里的 schema、`box::use(m = ...)` 里的 m → 跳模块文件
    const bindingFileUri = resolveModuleBindingFile(ctx, cursorOffset, boxModules.urisByName);
    if (bindingFileUri !== null) {
      const location = moduleFileLocation(vscode.Uri.parse(bindingFileUri));
      this.logHit('模块名', location);
      return location;
    }

    // 再试模块成员跳转：`schema$get_table_label` 里的 get_table_label →
    // 模块文件里的同名顶层符号（不看 `#' @export`，见 docs/box-模块规则.md）
    const moduleMember = resolveModuleMemberDefinition(ctx, cursorOffset, boxModules.urisByName);
    if (moduleMember !== null) return this.returnSite('模块成员', moduleMember);

    // 再试成员跳转（self$xxx / private$xxx / 类名$xxx 的成员部分）
    const memberDef = resolveMemberDefinition(ctx, cursorOffset);
    if (memberDef !== null) return this.returnSite('成员', memberDef);

    // 再试类名跳转（类名本身）
    const classDef = resolveClassDefinition(ctx, cursorOffset);
    if (classDef !== null) return this.returnSite('类名', classDef);

    // 再试变量跳转（普通变量 → 它的赋值行；类名已在上一步命中，到不了这里）
    const varDef = resolveVariableDefinition(ctx, cursorOffset);
    if (varDef !== null) return this.returnSite('变量', varDef);

    // 最后兜底：附着清单引入的名字（`[FieldInfo]`、`[FI = FieldInfo]` 的 FI、`[get_label]`）
    // 放最后是因为 R 里后写的赋值会覆盖导入进来的绑定 —— 本地优先、附着兜底
    const attachName = resolveAttachNameDefinition(ctx, cursorOffset, boxModules.attachByName);
    if (attachName !== null) return this.returnSite('附着名', attachName);

    // 都不是 → null（编辑器显示"未找到定义"）
    this.output.appendLine(`[def] 未命中（${describePosition(document, cursorOffset)}）`);
    return null;
  }

  /** 统一出口：DefinitionSite → Location，并记一行日志 */
  private returnSite(branch: string, site: DefinitionSite): vscode.Location {
    const location = new vscode.Location(
      vscode.Uri.parse(site.uri),
      new vscode.Position(site.line, site.character),
    );
    this.logHit(branch, location);
    return location;
  }

  /** 跳转命中的日志：分支 + 目标文件:行（行号从 1 数，跟编辑器一致） */
  private logHit(branch: string, location: vscode.Location): void {
    this.output.appendLine(
      `[def] 命中 ${branch} → ${location.uri.fsPath}:${location.range.start.line + 1}`,
    );
  }
}

/** 模块文件跳转统一落在文件开头（第 1 行第 1 列） */
function moduleFileLocation(uri: vscode.Uri): vscode.Location {
  return new vscode.Location(uri, new vscode.Position(0, 0));
}

/** 光标位置的简短描述（日志用） */
function describePosition(document: vscode.TextDocument, cursorOffset: number): string {
  const position = document.positionAt(cursorOffset);
  return `${path.basename(document.uri.fsPath)}:${position.line + 1}:${position.character + 1}`;
}

/**
 * 模块跳转：光标踩在 `box::use(R/schema/schema)` 的某一段上时，返回那一段对应的模块文件。
 * 用"前缀命中"（点第 n 段就只用前 n+1 段去找），所以点中间的段自然找不到、不跳。
 * @returns 模块文件路径（posix）；不在段上或找不到文件 → null（交给后面的分支）
 */
function locateModuleFile(
  ctx: AnalysisContext,
  cursorOffset: number,
  imports: BoxImport[],
  document: vscode.TextDocument,
  rootDirs: string[],
): string | null {
  const tokenIndex = findWordIndexAt(ctx, cursorOffset);
  if (tokenIndex === -1) return null;

  const hit = segmentAtOffset(imports, ctx.cursorFile.tokens[tokenIndex].stOffset);
  if (hit === undefined) return null;

  return resolveImportFilePath(document, hit.imp, hit.segmentIndex, rootDirs) ?? null;
}
