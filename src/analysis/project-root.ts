import * as path from 'path';
import { isAbsoluteLike, stripTrailingSep } from '../utils/paths';
import { tokenize } from '../parser/tokenizer';
import { matchBracket } from '../parser/brackets';
import { nextNonComment } from '../parser/token-utils';
import { splitTopLevel } from '../parser/r6-parser';

/** 候选根来源：用户配置 / .Rprofile 的 box.path / VS Code 工作区根 */
export type RootSource = 'config' | 'boxpath' | 'workspace';

/** VS Code 的"工作区文件夹"占位符（扩展不会自动展开，要我们自己替换；只支持这一个变量）
 *  统一转小写：比较时把输入也转小写，做到大小写不敏感 */
export const WORKSPACE_FOLDER = '${workspaceFolder}'.toLowerCase();

/** 一个候选根：路径 + 来源（来源用于诊断输出） */
export interface CandidateRoot {
  path: string;
  source: RootSource;
}

/**
 * collectCandidateRoots 的输入。
 * 三个字段与三个来源一一对应（字段名 = 来源标记名）：
 *   config    → 来源于r-toolkit这个插件的根目录设置
 *   boxpath   → 来源于.Rprofile文件中的box.path设置
 *   workspace → 来源于VSCode打开的根目录
 */
export interface CandidateRootsInput {
  /** 来源 'config'：`settings.json` 里 `r-toolkit.boxPaths` 的值（字符串数组，没配就是空数组） */
  config: string[];
  /** 来源 'boxpath'：向上找到的最近一个 .Rprofile（**尚未解析**的文本 + 它所在目录）；没有则 undefined */
  boxpath?: { text: string; dir: string };
  /** 来源 'workspace'：VS Code 工作区根（多根工作区按顺序全部传入） */
  workspace: string[];
}

/**
 * 候选根编排：按 来源1 → 来源2 → 来源3 的顺序问，**第一个给出非空结果的就用它**。
 * 三个来源各自返回 CandidateRoot[]（自带来源标记），所以这里只比"有没有结果"。
 * @param input 三层来源的原始材料（读设置/读盘由 provider 层准备）
 * @returns 候选根列表；三层都给不出结果 → 空数组（上层据此不跳转）
 */
export function collectCandidateRoots(input: CandidateRootsInput): CandidateRoot[] {
  // 来源1：用户配置（配了就不再看后面两层）
  const fromConfig = rootsFromConfig(input.config, input.workspace);
  if (fromConfig.length > 0) {
    return fromConfig;
  }

  // 来源2：项目级 .Rprofile 的 box.path
  if (input.boxpath !== undefined) {
    const fromBoxPath = parseBoxPathRoots(input.boxpath.text, input.boxpath.dir);
    if (fromBoxPath.length > 0) {
      return fromBoxPath;
    }
  }

  // 来源3：VS Code 工作区文件夹（兜底）
  return rootsFromWorkspace(input.workspace);
}

/**
 * 来源1（优先级最高）：`settings.json` 里 `r-toolkit.boxPaths` 配的根。
 * 逐条目解析、按书写顺序拼接（顺序 = "先在哪找"的优先级）。
 * 读取设置由 provider 层负责（见 docs/项目根解析.md 的「实现位置」）。
 */
export function rootsFromConfig(entries: string[], workspaceFolders: string[]): CandidateRoot[] {
  const roots: CandidateRoot[] = [];
  for (const entry of entries) {
    roots.push(...rootsFromConfigEntry(entry, workspaceFolders));
  }
  return roots;
}

/** `.Rprofile` 的文件名（只找这一个名字；用户级 `~/.Rprofile` 与 site 级 `Rprofile.site` 都不在范围内） */
const RPROFILE_NAME = '.Rprofile';

/**
 * 来源2 的前置动作：从 stDir 起向上逐级找最近的 `.Rprofile`（含 stDir 这一级）。
 * 只回答"文件在哪"，读它的内容由 provider 层负责。
 *
 * **边界（stStopDir = 工作区文件夹）**：只在这个范围内上溯，到边界那一级就停。
 * 这条边界是"只解析项目级 `.Rprofile`"（不读用户级 `~/.Rprofile`）的落地方式 ——
 * 只靠 `dirname` 上溯的话，工作区在用户目录下时必然经过 `C:/Users/me`，
 * 会把用户级配置当项目配置读进来。
 * 文件压根不在工作区里 → 直接返回 undefined（同样不认项目级配置）。
 *
 * 终止性：起点要么等于边界、要么在边界之下（否则上面已经返回），
 * 每轮 `dirname` 都朝边界靠近一级，所以必然在边界那一级停下。
 *
 * @param stDir     起点目录（通常是当前文件所在目录），posix 形式
 * @param stStopDir 边界目录（工作区文件夹），posix 形式；**必须传**，没有工作区就别调这个函数
 * @param exists    判断文件是否存在（注入以便测试；接线时传 fs.existsSync）
 * @returns `.Rprofile` 的路径（posix 形式）；边界内没有 → undefined
 */
export function findNearestRprofile(
  stDir: string,
  stStopDir: string,
  exists: (ptr: string) => boolean,
): string | undefined {
  const stopDir = stripTrailingSep(path.posix.normalize(stStopDir));
  let dir = stripTrailingSep(path.posix.normalize(stDir));

  // 包含性判断要带分隔符（`D:/demoo` 不能被 `D:/demo` 认成"在里面"）；
  // 边界自己是根（'/' 或 'D:/'）时已经在末尾带分隔符，直接用它。
  // 这里不做大小写转换：两个路径都来自 VS Code，大小写一致。
  const insidePrefix = stopDir.endsWith('/') ? stopDir : stopDir + '/';
  if (dir !== stopDir && !dir.startsWith(insidePrefix)) {
    return undefined;
  }

  while (true) {
    const candidate = path.posix.join(dir, RPROFILE_NAME);
    if (exists(candidate)) {
      return candidate; // 最近的一级，找到就停
    }
    if (dir === stopDir) {
      return undefined; // 边界那一级也查过了 → 不再上溯
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) {
      // 兜底终止：dirname 到了固定点（'/' 或 '.'）却始终没碰到边界。
      // 这不是空想 —— 边界是**盘根** `D:/` 时就会走到这里：
      // `dirname('D:/') === '.'`，靠"上溯到边界"永远碰不到 `D:/` 本身。
      return undefined;
    }
    dir = parent;
  }
}

/**
 * 来源2（优先级次之）：项目级 `.Rprofile` 里的 `options(box.path = ...)`。
 * 规则（最简版）：
 *   值是字符串字面量 → 绝对路径直读；相对路径以该 `.Rprofile` 所在目录为基准
 *   其它任何写法（`getwd()` 等动态表达式、`c(...)` 向量、值漏写）→ 回落到该目录
 *   找到第一个 `box.path` 就返回 —— 重复定义属不规范写法，不做兼容
 * 动态写法**有意不解析**，原因与将来可加项见 docs/项目根解析.md。
 * @param rprofileText `.Rprofile` 全文
 * @param rprofileDir  `.Rprofile` 所在目录（相对路径的基准；依据是 R 只从启动目录读它）
 * @returns 候选根列表；文件里没有 `box.path` → 空数组（交给下一层来源）
 */
export function parseBoxPathRoots(rprofileText: string, rprofileDir: string): CandidateRoot[] {
  const tokens = tokenize(rprofileText);

  for (let i = 0; i < tokens.length; i++) {
    // 只找 `options (` 这种调用
    if (tokens[i].kind !== 'identifier' || tokens[i].text !== 'options') {
      continue;
    }
    if (tokens[i + 1]?.kind !== 'operator' || tokens[i + 1].text !== '(') {
      continue;
    }

    const closeIndex = matchBracket(tokens, i + 1, '(');
    if (closeIndex === -1) {
      continue; // 括号没配对（文件不完整）→ 跳过这次 options()
    }

    // 在参数里找 `box.path = ...`（按顶层逗号切参数：options(a = 1, box.path = "...")）
    for (const [stArg] of splitTopLevel(tokens, i + 1, closeIndex)) {
      if (tokens[stArg]?.kind !== 'identifier' || tokens[stArg].text !== 'box.path') {
        continue;
      }
      if (tokens[stArg + 1]?.kind !== 'operator' || tokens[stArg + 1].text !== '=') {
        continue; // 写法不规范（box.path 不是具名参数）→ 不当它是配置
      }

      // 找到 box.path：能识别的字面量就用它，其余（动态表达式 / 值漏写）回落所在目录
      const valueToken = nextNonComment(tokens, stArg + 2);
      if (valueToken?.kind === 'string') {
        const literal = valueToken.text;
        const root = isAbsoluteLike(literal)
          ? path.posix.normalize(literal) // 绝对路径：规范化后直读
          : path.posix.join(rprofileDir, literal); // 相对路径：拼到 .Rprofile 所在目录
        return [{ path: root, source: 'boxpath' }];
      }
      return [{ path: rprofileDir, source: 'boxpath' }];
    }
  }

  return []; // 整个文件里没有 box.path
}

/**
 * 来源3（最后的兜底）：VS Code 打开的工作区文件夹。
 * 多根工作区时每个文件夹都是候选（保序）；读取 workspaceFolders 由 provider 层负责。
 * @param workspaceFolders 工作区文件夹的绝对路径
 * @returns 候选根列表；没打开任何文件夹 → 空数组
 */
export function rootsFromWorkspace(workspaceFolders: string[]): CandidateRoot[] {
  return workspaceFolders.map((folder) => ({ path: folder, source: 'workspace' }));
}

/**
 * 解析配置里的**一个**条目 → 候选根。
 * 三种写法：绝对路径直接用；`${workspaceFolder}` 与相对路径都按工作区根展开（多根工作区 → 每个根各一个候选）。
 * 其它 `${...}` 变量占位符不猜（返回空，由 boxPathSettingProblem 报告给日志）。
 * 私有辅助，不导出 —— 行为由 rootsFromConfig 的测试覆盖。
 */
function rootsFromConfigEntry(entry: string, workspaceFolders: string[]): CandidateRoot[] {
  const trimmed = entry.trim();
  // 传入的是空值的话那也返回空数组
  if (trimmed === '') {
    return [];
  }

  // 占位符大小写不敏感：输入转小写后与（已转小写的）常量比较；切尾巴用原长度（长度不随大小写变）
  if (trimmed.toLowerCase().startsWith(WORKSPACE_FOLDER)) {
    const rest = trimmed.slice(WORKSPACE_FOLDER.length); // '' 或 '/R' 或 '/R/schema'
    return workspaceFolders.map((folder) => ({
      path: path.posix.join(folder, rest),
      source: 'config',
    }));
  }

  // 无法识别的情况直接返回空数组
  if (trimmed.includes('${')) {
    return [];
  }

  // 如果是绝对路径就直接返回
  if (isAbsoluteLike(trimmed)) {
    return [{ path: trimmed, source: 'config' }];
  }

  // 处理相对路径：相对"工作区文件夹"，多根工作区时每个文件夹各算一个候选
  return workspaceFolders.map((folder) => ({
    path: path.posix.join(folder, trimmed),
    source: 'config',
  }));
}
