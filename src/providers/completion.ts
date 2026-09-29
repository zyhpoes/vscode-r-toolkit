/**
 * 补全 Provider（边界层：允许碰 vscode）。
 * 职责：把分析层算好的候选（`Candidate[]`）翻译成 VS Code 的补全项。
 * 不含判定逻辑 —— 触发上下文与可见性规则都在 analysis/completion.ts（已单测）；
 * 原料装配走 providers/context.ts 那条与跳转共用的管线。
 */

import * as vscode from 'vscode';
import { completionTriggerAt, r6MemberCandidates, type Candidate } from '../analysis/completion';
import { buildQueryInput } from './context';

/** 实现 VS Code 的"补全提供者"接口：敲 `$` 或按 Ctrl+Space 时被编辑器调用 */
export class R6CompletionProvider implements vscode.CompletionItemProvider {
  /**
   * @param document 当前文档（R 源码）
   * @param position 光标位置（行列）
   * @returns 候选列表；"这里不归我管"返回 undefined，让别的来源（VS Code 词补全、vscode-R）接手
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    // 不传 output：补全每次按键都会调一次，写日志会把输出面板刷满
    const { ctx, cursorOffset } = await buildQueryInput(document, position);

    const trigger = completionTriggerAt(ctx, cursorOffset);
    if (trigger === null) return undefined;

    // `pkg::` 的包导出名还没做（见 DESIGN.md 第 5 项）；注册时也就不给 `:` 触发字符
    if (trigger.kind === 'namespace') return undefined;

    const candidates = r6MemberCandidates(
      ctx,
      trigger.container,
      trigger.containerIndex,
      cursorOffset,
    );
    // null = 容器不是 R6 类（普通变量、模块名、包名…）→ 交给别的来源，不抢
    if (candidates === null) return undefined;

    return candidates.map(toCompletionItem);
  }
}

/** 候选项 → VS Code 补全项 */
function toCompletionItem(candidate: Candidate, index: number): vscode.CompletionItem {
  // 图标统一用 Variable：解析器不区分方法/字段（与 outline.ts 同样的取舍）
  const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.Variable);
  item.detail = candidate.detail;
  // 我们的顺序有意义（本类成员在前、继承的在后）→ 补零序号，避免 VS Code 按字母重排
  item.sortText = `${index.toString().padStart(3, '0')}${candidate.label}`;
  return item;
}
