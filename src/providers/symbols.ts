/**
 * 大纲 Provider（边界层：允许碰 vscode 的地方）。
 * 职责：把纯逻辑（analysis/outline.ts 的 OutlineNode）翻译成 VS Code 的 DocumentSymbol。
 * 不含解析逻辑 —— 树结构在核心层算好，且已单测。
 *
 * 效果：VS Code 的「大纲」面板、面包屑（编辑器顶部那行）、Ctrl+Shift+O 都用它。
 */

import * as vscode from 'vscode';
import { buildOutline, type OutlineNode } from '../analysis/outline';
import { createContext } from '../analysis/context';
import { TextLines } from '../utils/text';

/** 实现 VS Code 的"文档符号提供者"接口：打开/编辑 R 文件时被调用 */
export class R6DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  /**
   * @param document 当前文档（R 源码）
   * @returns 大纲树的根节点列表（类 → 区 → 成员）；没有 R6 类时返回空数组
   */
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const uri = document.uri.toString();
    const text = document.getText();

    // 只处理当前文件：类清单与 token 都取自它自己（大纲不涉及依赖文件）
    const ctx = createContext([{ uri, text }], uri);
    const nodes = buildOutline(ctx.cursorParsed.classes, ctx.cursorTokens);

    // 偏移量 → 行列：VS Code 的符号要的是行列范围
    const lines = new TextLines(text);
    return nodes.map((node) => toSymbol(node, lines));
  }
}

/** OutlineNode → vscode.DocumentSymbol（递归带上子节点） */
function toSymbol(node: OutlineNode, lines: TextLines): vscode.DocumentSymbol {
  const symbol = new vscode.DocumentSymbol(
    node.name,
    '', // detail：v1 留空（将来可放"继承自 X"之类）
    symbolKindOf(node),
    toRange(node.stOffset, node.enOffset, lines), // 整块范围（折叠 / 高亮）
    toRange(node.nameOffset, node.nameOffset + node.name.length, lines), // 名字范围（点击定位）
  );
  symbol.children = node.children.map((child) => toSymbol(child, lines));
  return symbol;
}

/** 节点 → VS Code 的图标种类 */
function symbolKindOf(node: OutlineNode): vscode.SymbolKind {
  if (node.kind === 'class') {
    return vscode.SymbolKind.Class;
  }
  if (node.kind === 'scope') {
    return vscode.SymbolKind.Namespace; // 区是分组容器
  }
  // 成员：active 绑定"读起来像字段、实际是函数"，用 Property 最贴切；
  // 其余成员暂用 Variable —— parser 目前不区分方法/字段，图标准确度要等它支持后再提升
  return node.scope === 'active' ? vscode.SymbolKind.Property : vscode.SymbolKind.Variable;
}

/** 偏移量区间 → vscode.Range */
function toRange(stOffset: number, enOffset: number, lines: TextLines): vscode.Range {
  const st = lines.positionAt(stOffset);
  const en = lines.positionAt(enOffset);
  return new vscode.Range(st.line, st.character, en.line, en.character);
}
