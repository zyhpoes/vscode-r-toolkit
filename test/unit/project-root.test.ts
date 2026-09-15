import { describe, expect, it } from 'vitest';
import {
  collectCandidateRoots,
  findNearestRprofile,
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

// 来源2 的前置动作：从当前文件目录向上找最近的 .Rprofile（边界 = 工作区文件夹）
describe('findNearestRprofile 向上找 .Rprofile', () => {
  // 辅助：只有列出的文件算"存在" —— 让测试完全不碰磁盘
  function existsOnly(...hitList: string[]): (ptr: string) => boolean {
    return (ptr) => hitList.includes(ptr);
  }

  // 辅助：记录"问过哪些路径"，顺便让一切都"不存在"
  function recordAsked(asked: string[]): (ptr: string) => boolean {
    return (ptr) => {
      asked.push(ptr);
      return false;
    };
  }

  it('起点目录自己就有 → 用它', () => {
    const hit = 'D:/demo/.Rprofile';
    expect(findNearestRprofile('D:/demo', 'D:/demo', existsOnly(hit))).toBe(hit);
  });

  it('起点没有、边界那一级有 → 用它（边界本身也要查）', () => {
    const hit = 'D:/demo/.Rprofile';
    expect(findNearestRprofile('D:/demo/R/model', 'D:/demo', existsOnly(hit))).toBe(hit);
  });

  it('多级都有 → 取**最近**的那一级，不是最上面那个', () => {
    expect(
      findNearestRprofile(
        'D:/demo/R/model',
        'D:/demo',
        existsOnly('D:/demo/.Rprofile', 'D:/demo/R/.Rprofile'),
      ),
    ).toBe('D:/demo/R/.Rprofile');
  });

  it('边界内都没有 → undefined', () => {
    expect(findNearestRprofile('D:/demo/R', 'D:/demo', existsOnly())).toBeUndefined();
  });

  it('边界之上有 .Rprofile 也不看（这是"不读用户级配置"的落地）', () => {
    // D:/.Rprofile 在边界 D:/demo 之上，属于"项目外"，必须无视
    expect(findNearestRprofile('D:/demo/R', 'D:/demo', existsOnly('D:/.Rprofile'))).toBeUndefined();
  });

  it('文件不在工作区里 → 直接 undefined，不上溯', () => {
    expect(
      findNearestRprofile('D:/outside/R', 'D:/demo', existsOnly('D:/outside/.Rprofile')),
    ).toBeUndefined();
  });

  it('包含性判断要带分隔符：D:/demoo 不算在 D:/demo 里面', () => {
    expect(findNearestRprofile('D:/demoo/R', 'D:/demo', existsOnly('D:/demoo/.Rprofile'))).toBe(
      undefined,
    );
  });

  it('边界是盘根时也认得出"在里面"（workspace 就开在 D:/）', () => {
    const hit = 'D:/.Rprofile';
    expect(findNearestRprofile('D:/demo/R', 'D:/', existsOnly(hit))).toBe(hit);
  });

  it('边界是 Unix 根时同样能走到根那一级', () => {
    const hit = '/.Rprofile';
    expect(findNearestRprofile('/home/me/proj', '/', existsOnly(hit))).toBe(hit);
  });

  it('边界是盘根、边界内没有时**不会死循环**（dirname 永远走不到 D:/）', () => {
    // 没有兜底终止的话，这条会卡死：D:/demo → D: → . → . → ……
    const asked: string[] = [];
    expect(findNearestRprofile('D:/demo', 'D:/', recordAsked(asked))).toBeUndefined();
    expect(asked).toEqual(['D:/demo/.Rprofile', 'D:/.Rprofile', '.Rprofile']);
  });

  it('试的目录顺序是"从近到远"，到边界为止', () => {
    const asked: string[] = [];
    findNearestRprofile('D:/demo/R/model', 'D:/demo', recordAsked(asked));
    expect(asked).toEqual([
      'D:/demo/R/model/.Rprofile',
      'D:/demo/R/.Rprofile',
      'D:/demo/.Rprofile',
    ]);
  });

  it('尾斜杠不影响：起点 D:/demo/R/ 与边界 D:/demo/ 结果一样', () => {
    const asked: string[] = [];
    findNearestRprofile('D:/demo/R/', 'D:/demo/', recordAsked(asked));
    expect(asked[0]).toBe('D:/demo/R/.Rprofile');
  });

  it('相对路径：归一化后照常工作（边界 proj，起点 proj/R）', () => {
    const hit = 'proj/.Rprofile';
    expect(findNearestRprofile('proj/R', 'proj', existsOnly(hit))).toBe(hit);
  });

  it('只认文件名恰好是 .Rprofile：site 级的 Rprofile.site 不算', () => {
    expect(
      findNearestRprofile('D:/demo', 'D:/demo', existsOnly('D:/demo/Rprofile.site')),
    ).toBeUndefined();
  });
});
