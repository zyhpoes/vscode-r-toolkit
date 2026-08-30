/**
 * 插件入口。
 * activate() 是 VS Code 加载插件时调用的"开机仪式"：
 * 在这里注册能力（命令、补全、跳转等）并登记资源清理。
 */

// vscode 模块是 VS Code 运行时注入的（打包时 external，不编译进产物）。
// 现在要用运行时的 API（状态栏），所以用普通导入。
import * as vscode from 'vscode';

/**
 * 插件激活时调用。
 * @param context 插件上下文：提供订阅管理、全局状态、存储路径等
 */
export function activate(context: vscode.ExtensionContext): void {
  // 状态栏提示：插件激活后，底部状态栏显示这行字，
  // 用来"肉眼确认"插件真的生效了（不用翻日志）。
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.text = '$(symbol-class) R Toolkit 已就绪';
  statusBar.show();
  // 登记进订阅：插件被卸载时 VS Code 会自动销毁它，不用手动清理
  context.subscriptions.push(statusBar);

  // 备用确认：调试控制台里也能看到这行（用 warn 因为 lint 只允许 warn/error）
  console.warn('[r-toolkit] 插件已激活');
}

/**
 * 插件被禁用/卸载时调用（可选）。
 * 目前没有需要手动清理的资源，留空即可。
 */
export function deactivate(): void {}
