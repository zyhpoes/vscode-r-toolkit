/**
 * 跨 provider 共用的"原料装配"（边界层：允许碰 vscode、读盘）。
 * 跳转（definition.ts）与补全（completion.ts）需要同一套原料，只有这一份，避免两份管线漂。
 *
 * 装配顺序：切词 → 解析 box 导入 → 算候选根 → 加载依赖文件 → 每文件解析一次 → 组装 AnalysisContext。
 * 纯规则都在 analysis/，这里只负责"从 VS Code 环境取料 + 拼接"。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createContextFromParsed, type AnalysisContext } from '../analysis/context';
import { moduleBindingName, modulePathOf, parseBoxImports, type BoxImport } from '../analysis/box';
import { baseDirsForImport, resolveModuleFilePath } from '../analysis/module-file';
import type { AttachNameTarget } from '../analysis/module-symbols';
import { dedupeFiles, parseSourceFile, type SourceFile } from '../analysis/source-file';
import { tokenize } from '../parser/tokenizer';
import { toPosix } from '../utils/paths';
import { resolveBoxRoots } from './box-roots';

/** box 模块加载结果 */
export interface BoxModules {
  /** 依赖文件（喂给 createContext，跨文件查询的原料） */
  files: SourceFile[];
  /** 模块绑定名 → 模块文件 uri（`schema$xxx` 成员跳转用；附着写法不绑名，不进这张表） */
  urisByName: Map<string, string>;
  /** 附着清单本地名 → { 模块文件 uri, 模块内名 }（`[FieldInfo]` / `[FI = FieldInfo]` 跳转用） */
  attachByName: Map<string, AttachNameTarget>;
}

/** 一次查询的全部原料（跳转 / 补全共用） */
export interface QueryInput {
  /** 光标文件 uri */
  uri: string;
  /** 组装好的分析上下文（含光标文件 + box 依赖文件的解析产物） */
  ctx: AnalysisContext;
  /** 光标偏移量（行列已换算成字符偏移；纯逻辑只认偏移量） */
  cursorOffset: number;
  /** 光标文件的 box 导入（模块跳转要按段匹配） */
  imports: BoxImport[];
  /** 候选根（posix 形式，已按优先级排好） */
  rootDirs: string[];
  /** box 依赖加载结果（两张表 + 依赖文件文本） */
  boxModules: BoxModules;
}

/**
 * 把"当前文档 + 光标位置"加工成一次查询所需的普通对象（`QueryInput`，不含 vscode 对象）：
 * 切词、解析 box 导入、读依赖文件、每文件解析一次、把行列换算成字符偏移（顺序见文件头）。
 * 补全与跳转共用这一条管线，只此一份；这里是唯一的读盘处 ——
 * 补全每按一次键就跑一遍，成本都在这儿。
 * @param output 诊断输出通道；不传就静默（补全不传：否则每按键都会往面板写行）
 */
export async function buildQueryInput(
  document: vscode.TextDocument,
  position: vscode.Position,
  output?: vscode.OutputChannel,
): Promise<QueryInput> {
  const uri = document.uri.toString();
  const text = document.getText();

  const cursorTokens = tokenize(text);

  // box 导入 + 候选根：模块跳转与"加载依赖文件"共用（各只算一次）
  const imports = parseBoxImports(cursorTokens);
  const rootDirs = resolveBoxRoots(document.uri).map((root) => root.path);

  const boxModules = await loadBoxModules(document, imports, rootDirs, output);

  // 按 uri 去重：同一文件被两条导入指向（`./x` 与 `R/x`）时不重复解析
  const files = dedupeFiles([{ uri, text }, ...boxModules.files]);

  // 每个文件解析一次；光标文件那份**复用上面切好的 token**（不再切第二遍）
  const parsedFiles = files.map((file) =>
    parseSourceFile(file, file.uri === uri ? cursorTokens : undefined),
  );

  // 组装分析上下文：只做"校验 + 建聚合索引"，不解析（解析已在上面完成）
  const ctx = createContextFromParsed(parsedFiles, uri);

  // 行索引用 ctx 里那份，不另建
  const cursorOffset = ctx.cursorFile.lines.offsetAt(position.line, position.character);

  return { uri, ctx, cursorOffset, imports, rootDirs, boxModules };
}

/**
 * box 导入 → 磁盘文件路径（posix 形式）；解析不出来 → undefined。
 * @param segmentIndex 按前几段找（点第 n 段传 n；加载依赖传最后一段）
 */
export function resolveImportFilePath(
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

/**
 * 加载当前文件所有 box 导入对应的模块文件。
 * 找文件用三层候选根（`resolveBoxRoots` → `resolveModuleFilePath`）；
 * 找不到的写进输出面板 —— 不静默失败（见 docs/项目根解析.md 的「失败诊断」）；跳转传通道，补全不传。
 */
async function loadBoxModules(
  document: vscode.TextDocument,
  imports: BoxImport[],
  rootDirs: string[],
  output?: vscode.OutputChannel,
): Promise<BoxModules> {
  const files: SourceFile[] = [];
  const urisByName = new Map<string, string>();
  const attachByName = new Map<string, AttachNameTarget>();

  for (const imp of imports) {
    // 加载依赖要的是"整条路径对应的文件"，所以段号取最后一段
    const filePath = resolveImportFilePath(document, imp, imp.segments.length - 1, rootDirs);
    if (filePath === undefined) {
      // 已安装的第三方包也会走到这里（本地找不到文件）——所以是"提示"不是"错误"
      output?.appendLine(
        `[box] 未找到模块文件：${modulePathOf(imp)}｜候选根：${rootDirs.join(' , ') || '（无）'}`,
      );
      continue;
    }

    try {
      // 交给 VS Code 打开：能拿到用户未保存的缓冲区内容，比自己 fs 读更准
      const depDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const depUri = depDoc.uri.toString();
      files.push({ uri: depUri, text: depDoc.getText() });

      // 模块绑定名（`box::use(R/schema/schema)` → schema；别名写法取别名）
      const bindingName = moduleBindingName(imp);
      if (bindingName !== undefined) {
        urisByName.set(bindingName, depUri);
      }

      // 附着清单：每个本地名都指向"这个模块文件 + 模块内那个名字"
      // （同名写法 `[a]` 的 source 也是 a；重命名 `[g = f]` 才需要 source 区分）
      for (const attachName of imp.attach ?? []) {
        attachByName.set(attachName.alias, { moduleUri: depUri, source: attachName.source });
      }
    } catch (error) {
      output?.appendLine(`[box] 依赖文件打不开：${filePath}（${String(error)}）`);
    }
  }

  return { files, urisByName, attachByName };
}
