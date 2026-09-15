/**
 * 定义跳转 Provider（边界层：全项目唯一允许碰 vscode 的地方之一）。
 * 职责：把纯逻辑（resolveMemberDefinition / resolveClassDefinition / resolveVariableDefinition）
 * 翻译成 VS Code 的跳转结果。
 * 不含解析逻辑 —— 解析都在核心层（analysis/），已单测。
 * 额外职责（边界层）：读取 box 依赖文件，让查询能跨文件找类。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  resolveClassDefinition,
  resolveVariableDefinition,
  type DefinitionSite,
} from '../analysis/definitions';
import { resolveMemberDefinition } from '../analysis/members';
import { createContextFromParsed, type AnalysisContext } from '../analysis/context';
import { findTokenIndexAt } from '../analysis/cursor';
import { moduleBindingName, modulePathOf, parseBoxImports, segmentAtOffset, type BoxImport } from '../analysis/box';
import { baseDirsForImport, resolveModuleFilePath } from '../analysis/module-file';
import { resolveModuleMemberDefinition } from '../analysis/module-symbols';
import { resolveBoxRoots } from './box-roots';
import { toPosix } from '../utils/paths';
import { tokenize } from '../parser/tokenizer';
import { dedupeFiles, parseSourceFile, type SourceFile } from '../analysis/source-file';

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
    // 当前文件的 uri 和全文
    const uri = document.uri.toString();
    const text = document.getText();

    // 光标文件切一次词：解析导入、建 ctx 都用这一份（全项目只有这里与 parseSourceFile 切词）
    const cursorTokens = tokenize(text);

    // box 导入 + 候选根：模块跳转与"加载依赖文件"共用（各只算一次）
    const imports = parseBoxImports(cursorTokens);
    const rootDirs = resolveBoxRoots(document.uri).map((root) => root.path);

    // 文件清单 = 光标文件 + box 依赖文件
    // moduleUris 是"模块绑定名 → 模块文件 uri"，`schema$xxx` 的成员跳转要用
    const boxModules = await loadBoxModules(document, imports, rootDirs, this.output);

    // 按 uri 去重：同一文件被两条导入指向（`./x` 与 `R/x`）时不重复解析
    const files = dedupeFiles([{ uri, text }, ...boxModules.files]);

    // 每个文件解析一次；光标文件那份**复用上面切好的 token**（不再切第二遍）
    const parsed = files.map((file) =>
      parseSourceFile(file, file.uri === uri ? cursorTokens : undefined),
    );

    // 组装分析上下文：只做"校验 + 建聚合索引"，不解析（解析已在上面完成）
    const ctx = createContextFromParsed(parsed, uri);

    // 光标位置（行列）→ 偏移量（纯逻辑只认偏移量）；行索引用 ctx 里那份，不另建
    const cursorOffset = ctx.cursorFile.lines.offsetAt(position.line, position.character);

    // 先试模块跳转：光标踩在 box::use(...) 的某一段上 → 跳那个模块文件
    // （放在最前面：用户在 import 路径上点击，意图明确就是"去这个模块"）
    const moduleFile = locateModuleFile(ctx, cursorOffset, imports, document, rootDirs);
    if (moduleFile !== null) {
      // 模块跳转落在文件开头（第 1 行第 1 列）
      const location = new vscode.Location(vscode.Uri.file(moduleFile), new vscode.Position(0, 0));
      this.logHit('模块', location);
      return location;
    }

    // 再试模块成员跳转：`schema$get_table_label` 里的 get_table_label →
    // 模块文件里的同名顶层符号（不看 `#' @export`，见 docs/box-模块规则.md）
    const moduleMember = resolveModuleMemberDefinition(ctx, cursorOffset, boxModules.urisByName);
    if (moduleMember !== null) {
      return this.returnSite('模块成员', moduleMember);
    }

    // 再试成员跳转（self$xxx / private$xxx / 类名$xxx 的成员部分）
    const memberDef = resolveMemberDefinition(ctx, cursorOffset);
    if (memberDef !== null) {
      return this.returnSite('成员', memberDef);
    }

    // 再试类名跳转（类名本身）
    const classDef = resolveClassDefinition(ctx, cursorOffset);
    if (classDef !== null) {
      return this.returnSite('类名', classDef);
    }

    // 最后试变量跳转（普通变量 → 它的赋值行；类名已在上一步命中，到不了这里）
    const varDef = resolveVariableDefinition(ctx, cursorOffset);
    if (varDef !== null) {
      return this.returnSite('变量', varDef);
    }

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
  const tokenIndex = findTokenIndexAt(ctx, cursorOffset);
  if (tokenIndex === -1) {
    return null;
  }

  const hit = segmentAtOffset(imports, ctx.cursorFile.tokens[tokenIndex].offset);
  if (hit === undefined) {
    return null;
  }

  return resolveImportFilePath(document, hit.imp, hit.segmentIndex, rootDirs) ?? null;
}

/** box 模块加载结果 */
interface BoxModules {
  /** 依赖文件（喂给 createContext，跨文件查询的原料） */
  files: SourceFile[];
  /** 模块绑定名 → 模块文件 uri（`schema$xxx` 成员跳转用；附着写法不绑名，不进这张表） */
  urisByName: Map<string, string>;
}

/**
 * 加载当前文件所有 box 导入对应的模块文件。
 * 找文件用三层候选根（`resolveBoxRoots` → `resolveModuleFilePath`）；
 * 找不到的写进输出面板 —— 不静默失败（见 docs/项目根解析.md 的「失败诊断」）。
 */
async function loadBoxModules(
  document: vscode.TextDocument,
  imports: BoxImport[],
  rootDirs: string[],
  output: vscode.OutputChannel,
): Promise<BoxModules> {
  const files: SourceFile[] = [];
  const urisByName = new Map<string, string>();

  for (const imp of imports) {
    // 加载依赖要的是"整条路径对应的文件"，所以段号取最后一段
    const filePath = resolveImportFilePath(document, imp, imp.segments.length - 1, rootDirs);
    if (filePath === undefined) {
      // 已安装的第三方包也会走到这里（本地找不到文件）——所以是"提示"不是"错误"
      output.appendLine(
        `[box] 未找到模块文件：${modulePathOf(imp)}｜候选根：${rootDirs.join(' , ') || '（无）'}`,
      );
      continue;
    }

    try {
      // 交给 VS Code 打开：能拿到用户未保存的缓冲区内容，比自己 fs 读更准
      const depDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      files.push({ uri: depDoc.uri.toString(), text: depDoc.getText() });

      // 模块绑定名（`box::use(R/schema/schema)` → schema；别名写法取别名）
      const bindingName = moduleBindingName(imp);
      if (bindingName !== undefined) {
        urisByName.set(bindingName, depDoc.uri.toString());
      }
    } catch (error) {
      output.appendLine(`[box] 依赖文件打不开：${filePath}（${String(error)}）`);
    }
  }

  return { files, urisByName };
}

/**
 * box 导入 → 磁盘文件路径（posix 形式）；解析不出来 → undefined。
 * @param segmentIndex 按前几段找（点第 n 段传 n；加载依赖传最后一段）
 */
function resolveImportFilePath(
  document: vscode.TextDocument,
  imp: BoxImport,
  segmentIndex: number,
  rootDirs: string[],
): string | undefined {
  const segments = imp.segments.map((segment) => segment.name);
  const fileDir = toPosix(path.dirname(document.uri.fsPath));
  const searchDirs = baseDirsForImport(imp.relative, fileDir, rootDirs);

  return resolveModuleFilePath(searchDirs, segments, segmentIndex, fs.existsSync);
}
