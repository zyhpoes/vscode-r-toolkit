/**
 * provider 层的"环境读取"：把 VS Code 环境读成 analysis 层要的原料。
 *
 * 分层约定（见 docs/项目根解析.md）：
 *   规则在 analysis（纯逻辑、可单测）—— 三层优先级、`.Rprofile` 解析、向上找文件
 *   读盘 / 读设置 / 写日志在 provider —— 就是本文件
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { toPosix } from '../utils/paths';
import {
  collectCandidateRoots,
  findNearestRprofile,
  type CandidateRoot,
  type CandidateRootsInput,
} from '../analysis/project-root';

/** 配置节名与键名（与 package.json 的 contributes.configuration 一致） */
const CONFIG_SECTION = 'r-toolkit';
const BOX_PATHS_KEY = 'boxPaths';

/**
 * 算出这个文件的 box 候选根：
 * 来源1 `r-toolkit.boxPaths` → 来源2 项目级 `.Rprofile` 的 `box.path` → 来源3 工作区根。
 * @param documentUri 当前 R 文件的 uri（决定"从哪向上找 .Rprofile"、"相对路径按哪个工作区展开"）
 * @returns 候选根（含来源标记，用于诊断输出）；三层都空 → 空数组（上层据此不跳转）
 */
export function resolveBoxRoots(documentUri: vscode.Uri): CandidateRoot[] {
  return collectCandidateRoots(readRootsInput(documentUri));
}

/** 把 VS Code 环境读成三层来源的原始材料 */
function readRootsInput(documentUri: vscode.Uri): CandidateRootsInput {
  const config = readBoxPathsSetting();
  const workspace = workspaceFolderPaths();
  const boxpath = readNearestRprofile(documentUri);

  // 本项目开了 exactOptionalPropertyTypes：`boxpath?: X` 不接受显式传 undefined，
  // 所以"没有 .Rprofile"时要整个键都不写
  if (boxpath === undefined) {
    return { config, workspace };
  }
  return { config, boxpath, workspace };
}

/** 读 `r-toolkit.boxPaths`；不是数组、或条目不是字符串 → 一律丢弃（不猜用户意图） */
function readBoxPathsSetting(): string[] {
  const raw: unknown = vscode.workspace.getConfiguration(CONFIG_SECTION).get(BOX_PATHS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/** 工作区文件夹的路径（posix 形式；多根工作区按 VS Code 给的顺序，全部作为候选） */
function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => toPosix(folder.uri.fsPath));
}

/**
 * 找并读项目级 `.Rprofile`（来源2 的原料）。
 * 边界 = 文件所属的工作区文件夹：没有工作区、或文件不在工作区里 → 不认项目级配置。
 * 读不出来（权限等）→ 当这一层不存在（一层配置读失败不该拖垮整个跳转）。
 */
function readNearestRprofile(documentUri: vscode.Uri): { text: string; dir: string } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (folder === undefined) {
    return undefined;
  }

  const fileDir = path.posix.dirname(toPosix(documentUri.fsPath));
  const stopDir = toPosix(folder.uri.fsPath);
  const rprofilePath = findNearestRprofile(fileDir, stopDir, fs.existsSync);
  if (rprofilePath === undefined) {
    return undefined;
  }

  try {
    return {
      text: fs.readFileSync(rprofilePath, 'utf8'),
      dir: path.posix.dirname(rprofilePath), // 相对 box.path 的基准 = .Rprofile 所在目录
    };
  } catch {
    return undefined;
  }
}
