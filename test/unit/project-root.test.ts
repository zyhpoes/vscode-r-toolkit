import { describe, expect, it } from 'vitest';
import {
  collectCandidateRoots,
  parseBoxPathRoots,
  rootsFromConfig,
  rootsFromWorkspace,
} from '../../src/analysis/project-root';

// 来源①：settings.json 里 r-toolkit.boxPaths 配的根（优先级最高）
describe('rootsFromConfig 配置来源', () => {
  const folders = ['D:/workspace/demo'];

  it('绝对路径：原样作为候选（不依赖工作区文件夹）', () => {
    expect(rootsFromConfig(['D:/proj/R'], folders)).toEqual([
      { path: 'D:/proj/R', source: 'config' },
    ]);
  });

  it('相对路径：拼到工作区文件夹上', () => {
    expect(rootsFromConfig(['R'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
    ]);
  });

  it("相对路径里的 './' 与 '../' 交给 join 折叠", () => {
    expect(rootsFromConfig(['./R'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
    ]);
    expect(rootsFromConfig(['../shared'], folders)).toEqual([
      { path: 'D:/workspace/shared', source: 'config' },
    ]);
  });

  it('多根工作区：相对路径为每个文件夹各生成一个候选（保序）', () => {
    expect(rootsFromConfig(['R'], ['D:/a', 'D:/b'])).toEqual([
      { path: 'D:/a/R', source: 'config' },
      { path: 'D:/b/R', source: 'config' },
    ]);
  });

  it('${workspaceFolder} 的三种大小写都能识别，尾段照常拼接', () => {
    expect(rootsFromConfig(['${workspaceFolder}'], folders)).toEqual([
      { path: 'D:/workspace/demo', source: 'config' },
    ]);
    expect(rootsFromConfig(['${workspacefolder}/R'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
    ]);
    expect(rootsFromConfig(['${WORKSPACEFOLDER}/R'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
    ]);
  });

  it('多个条目：按书写顺序依次拼接（顺序 = 查找优先级）', () => {
    expect(rootsFromConfig(['R', 'D:/shared/modules'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
      { path: 'D:/shared/modules', source: 'config' },
    ]);
  });

  it('其它变量占位符：该条目作废，其余条目不受影响', () => {
    expect(rootsFromConfig(['${env:HOME}/x', 'R'], folders)).toEqual([
      { path: 'D:/workspace/demo/R', source: 'config' },
    ]);
  });

  it('空数组 / 空条目 / 只有空白 → 空结果（交给下一层来源）', () => {
    expect(rootsFromConfig([], folders)).toEqual([]);
    expect(rootsFromConfig(['', '   '], folders)).toEqual([]);
  });

  it('没打开工作区文件夹时：相对路径作废，绝对路径仍可用', () => {
    expect(rootsFromConfig(['R'], [])).toEqual([]);
    expect(rootsFromConfig(['D:/abs'], [])).toEqual([{ path: 'D:/abs', source: 'config' }]);
  });
});

// 来源2：项目级 .Rprofile 里的 options(box.path = ...)
describe('parseBoxPathRoots 解析 .Rprofile 的 box.path', () => {
  const dir = 'D:/workspace/demo';
  // 三个来源都返回 CandidateRoot[]，来源标记固定为 boxpath
  const root = (path: string) => [{ path, source: 'boxpath' }];

  it('绝对路径字面量 → 原样采用', () => {
    expect(parseBoxPathRoots('options(box.path = "D:/other/proj")', dir)).toEqual(
      root('D:/other/proj'),
    );
  });

  it("相对路径 './R' → 以 .Rprofile 所在目录为基准", () => {
    expect(parseBoxPathRoots("options(box.path = './R')", dir)).toEqual(root('D:/workspace/demo/R'));
  });

  it("相对路径 'R'（不写 ./）与 '../shared'（含 .. 折叠）", () => {
    expect(parseBoxPathRoots("options(box.path = 'R')", dir)).toEqual(root('D:/workspace/demo/R'));
    expect(parseBoxPathRoots("options(box.path = '../shared')", dir)).toEqual(
      root('D:/workspace/shared'),
    );
  });

  it('没有 box.path 这一行 → 空数组（交给下一层来源）', () => {
    const text = 'source("renv/activate.R")\noptions(width = 400)';
    expect(parseBoxPathRoots(text, dir)).toEqual([]);
  });

  it('重复定义 box.path（不规范写法）→ 取第一个遇到的，不做兼容', () => {
    const text =
      'options(box.path = "D:/first")\n' +
      'options(width = 400)\n' +
      "options(box.path = './R')";
    // R 里后写生效，但重复定义属不规范写法；我们按"找到第一个就返回"处理
    expect(parseBoxPathRoots(text, dir)).toEqual(root('D:/first'));
  });

  it('值里有注释也不影响解析', () => {
    const text = 'options(\n  box.path = # 说明\n    "./R"\n)';
    expect(parseBoxPathRoots(text, dir)).toEqual(root('D:/workspace/demo/R'));
  });

  it('看不懂的值（动态表达式）→ 本期宽松回落到 .Rprofile 所在目录', () => {
    expect(parseBoxPathRoots('options(box.path = getwd())', dir)).toEqual(root(dir));
  });

  it('值漏写（options(box.path =)）→ 同样回落到所在目录', () => {
    expect(parseBoxPathRoots('options(box.path =)', dir)).toEqual(root(dir));
  });

  it('括号不配对（文件不完整）→ 跳过这次 options()，返回空数组', () => {
    expect(parseBoxPathRoots('options(box.path = "./R"', dir)).toEqual([]);
  });
});

// 来源3：VS Code 打开的工作区文件夹（最后的兜底）
describe('rootsFromWorkspace 工作区来源', () => {
  it('单个工作区文件夹 → 一个候选，来源标记 workspace', () => {
    expect(rootsFromWorkspace(['D:/workspace/demo'])).toEqual([
      { path: 'D:/workspace/demo', source: 'workspace' },
    ]);
  });

  it('多根工作区 → 每个文件夹都是候选，保序', () => {
    expect(rootsFromWorkspace(['D:/a', 'D:/b'])).toEqual([
      { path: 'D:/a', source: 'workspace' },
      { path: 'D:/b', source: 'workspace' },
    ]);
  });

  it('没打开任何文件夹 → 空结果', () => {
    expect(rootsFromWorkspace([])).toEqual([]);
  });
});

// 三层编排：来源1 → 来源2 → 来源3，谁先给出非空结果就用谁
describe('collectCandidateRoots 编排', () => {
  const workspace = ['D:/workspace/demo'];
  const boxpath = { text: "options(box.path = './R')", dir: 'D:/workspace/demo' };

  it('来源1 有结果 → 只用它，不再看来源2/3', () => {
    expect(collectCandidateRoots({ config: ['D:/proj/R'], boxpath, workspace })).toEqual([
      { path: 'D:/proj/R', source: 'config' },
    ]);
  });

  it('来源1 没配 → 用来源2', () => {
    expect(collectCandidateRoots({ config: [], boxpath, workspace })).toEqual([
      { path: 'D:/workspace/demo/R', source: 'boxpath' },
    ]);
  });

  it('来源1 的条目全都识别不出（空结果）→ 视为"没给出结果"，落到来源2', () => {
    expect(collectCandidateRoots({ config: ['${env:HOME}/x'], boxpath, workspace })).toEqual([
      { path: 'D:/workspace/demo/R', source: 'boxpath' },
    ]);
  });

  it('来源2 的 .Rprofile 里没有 box.path → 落到来源3', () => {
    expect(
      collectCandidateRoots({
        config: [],
        boxpath: { text: 'source("renv/activate.R")', dir: 'D:/workspace/demo' },
        workspace,
      }),
    ).toEqual([{ path: 'D:/workspace/demo', source: 'workspace' }]);
  });

  it('没找到 .Rprofile（boxpath 缺省）→ 直接走来源3', () => {
    expect(collectCandidateRoots({ config: [], workspace })).toEqual([
      { path: 'D:/workspace/demo', source: 'workspace' },
    ]);
  });

  it('三层都给不出结果 → 空数组（上层据此不跳转）', () => {
    expect(collectCandidateRoots({ config: [], workspace: [] })).toEqual([]);
  });
});
