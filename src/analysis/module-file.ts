/**
 * 模块文件定位：把一个 box 模块路径解析成磁盘上的某个文件。
 * 纯逻辑：不读文件（"是否存在"由调用方注入），不依赖 vscode，可在纯 Node 中测试。
 *
 * 路径一律用 posix 形式（正斜杠）传递，与 analysis/project-root.ts 保持一致；
 * 转成 VS Code 的 Uri 是 providers 层的事。
 *
 * 规则（见 docs/box-模块规则.md）：
 *   - 同一个目录下按顺序试：<路径>.R → <路径>.r → <路径>/__init__.R → <路径>/__init__.r
 *     （文件形态优先于目录形态，第一个存在的胜出）
 *   - 多个候选根按优先级依次试
 *   - 前缀命中：光标落在第 n 段 → 只用前 n+1 段去查找
 */

import * as path from 'path';
import type { BoxRelative } from './box';

/**
 * 解析"模块路径的某一段被点击"对应的文件。
 *
 * 前缀命中是这一步的核心：点 `R/schema/schema` 的第 1 段时，只用 `R` 去找，
 * 找不到 `R.R` / `R/__init__.R` 就不跳；点第 3 段才用整条路径去找。
 * 于是"点中间段没反应"不需要额外的判断，规则只有一条：没有文件就不跳。
 *
 * `..` 段不做特殊处理：点 `..` 时前缀就是 `..`，若父目录下正好有 `__init__.R`
 * （父目录本身是个目录模块）就会命中它 —— 这是相对路径照常兼容的一部分。
 *
 * @param baseDirs     候选根目录（posix 形式，已按优先级排好）；
 *                     相对导入（`./x` / `../x`）时传当前文件所在目录
 * @param segments     模块路径的分段名（`R/schema/schema` → ['R','schema','schema']）
 * @param segmentIndex 光标落在第几段（0 起）
 * @param exists       判断文件是否存在（注入以便测试；接线时传 fs.existsSync）
 * @returns 命中的文件路径（posix 形式）；没有任何候选存在 → undefined（不跳）
 */
export function resolveModuleFilePath(
  baseDirs: string[],
  segments: string[],
  segmentIndex: number,
  exists: (ptr: string) => boolean,
): string | undefined {
  // 段号必须是真实存在的一段。越界说明调用方算错了：这时若退化成
  // "拿整条路径去试"，会跳到用户没点的地方 —— 宁可返回"找不到"
  if (segmentIndex < 0 || segmentIndex >= segments.length) {
    return undefined;
  }

  const modulePath = segments.slice(0, segmentIndex + 1).join('/');

  // 根与根之间：前面的根整体优先于后面的根（含扩展名优先级）
  for (const baseDir of baseDirs) {
    for (const candidate of candidateModuleFiles(baseDir, modulePath)) {
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * 一次导入该在哪些目录里找模块文件。
 * `./x` / `../x`（relative = 'file'）→ 只看**当前文件所在目录**，
 * 与 box 一致：相对导入的基准是文件自己，不跟候选根走；
 * 其余 → 候选根，按优先级顺序。
 *
 * @param relative  导入的基准（来自 BoxImport.relative）
 * @param fileDir   当前文件所在目录（posix 形式）
 * @param rootDirs  候选根目录（posix 形式，已按优先级排好）
 */
export function baseDirsForImport(
  relative: BoxRelative,
  fileDir: string,
  rootDirs: string[],
): string[] {
  return relative === 'file' ? [fileDir] : rootDirs;
}

/** 一个模块路径在某个候选根下的全部候选文件，**数组顺序就是查找优先级** */
function candidateModuleFiles(baseDir: string, modulePath: string): string[] {
  const target = path.posix.join(baseDir, modulePath);
  return [
    target + '.R',
    target + '.r',
    path.posix.join(target, '__init__.R'),
    path.posix.join(target, '__init__.r'),
  ];
}
