import { describe, expect, it } from 'vitest';
import { baseDirsForImport, resolveModuleFilePath } from '../../src/analysis/module-file';

// 辅助：只有列出的文件算"存在"，其余一律不存在 —— 让测试完全不碰磁盘
function existsOnly(...hitList: string[]): (ptr: string) => boolean {
  return (ptr) => hitList.includes(ptr);
}

// 候选根（posix 形式，和 project-root.ts 的产出一致）
const PROJ = 'D:/proj';

describe('resolveModuleFilePath 模块路径 → 文件', () => {
  it('文件形态命中：<路径>.R', () => {
    const hit = `${PROJ}/R/schema/schema.R`;
    expect(resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 2, existsOnly(hit))).toBe(hit);
  });

  it('文件形态命中：只有小写 <路径>.r 时也能找到', () => {
    const hit = `${PROJ}/R/schema/schema.r`;
    expect(resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 2, existsOnly(hit))).toBe(hit);
  });

  it('大写 .R 优先于小写 .r（两个都存在时选 .R）', () => {
    const upper = `${PROJ}/R/schema/schema.R`;
    const lower = `${PROJ}/R/schema/schema.r`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 2, existsOnly(upper, lower)),
    ).toBe(upper);
  });

  it('目录形态命中：<路径>/__init__.R', () => {
    const hit = `${PROJ}/R/bio/__init__.R`;
    expect(resolveModuleFilePath([PROJ], ['R', 'bio'], 1, existsOnly(hit))).toBe(hit);
  });

  it('目录形态命中：只有小写 __init__.r 时也能找到', () => {
    const hit = `${PROJ}/R/bio/__init__.r`;
    expect(resolveModuleFilePath([PROJ], ['R', 'bio'], 1, existsOnly(hit))).toBe(hit);
  });

  it('__init__.R 优先于 __init__.r', () => {
    const upper = `${PROJ}/R/bio/__init__.R`;
    const lower = `${PROJ}/R/bio/__init__.r`;
    expect(resolveModuleFilePath([PROJ], ['R', 'bio'], 1, existsOnly(upper, lower))).toBe(upper);
  });

  it('文件形态优先于目录形态：schema.R 与 schema/__init__.R 都在 → 选 schema.R', () => {
    const fileForm = `${PROJ}/R/schema.R`;
    const dirForm = `${PROJ}/R/schema/__init__.R`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema'], 1, existsOnly(fileForm, dirForm)),
    ).toBe(fileForm);
  });

  it('四个候选都不存在 → undefined（不跳）', () => {
    expect(resolveModuleFilePath([PROJ], ['R', 'nope'], 1, existsOnly())).toBeUndefined();
  });
});

describe('resolveModuleFilePath 前缀命中（点第几段就用前几段）', () => {
  it('点第 1 段：只用 `R` 去找，找不到 R.R / R/__init__.R → 不跳', () => {
    // 完整路径的文件存在，但光标在第 1 段 → 不应该用它
    const full = `${PROJ}/R/schema/schema.R`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 0, existsOnly(full)),
    ).toBeUndefined();
  });

  it('点第 2 段：只用 `R/schema` 去找，同样不跳', () => {
    const full = `${PROJ}/R/schema/schema.R`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 1, existsOnly(full)),
    ).toBeUndefined();
  });

  it('点第 2 段且那段自己是个目录模块（R/schema/__init__.R）→ 命中它', () => {
    const twoSeg = `${PROJ}/R/schema/__init__.R`;
    const full = `${PROJ}/R/schema/schema.R`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 1, existsOnly(twoSeg, full)),
    ).toBe(twoSeg);
  });

  it('段号越界（3 段路径给 3）→ undefined，不退化成用整条路径去试', () => {
    const full = `${PROJ}/R/schema/schema.R`;
    expect(
      resolveModuleFilePath([PROJ], ['R', 'schema', 'schema'], 3, existsOnly(full)),
    ).toBeUndefined();
  });

  it('段号为负 → undefined', () => {
    const hit = `${PROJ}/R/schema.R`;
    expect(resolveModuleFilePath([PROJ], ['R', 'schema'], -1, existsOnly(hit))).toBeUndefined();
  });
});

describe('resolveModuleFilePath 多候选根与相对导入', () => {
  it('前面的根没有就用后面的根', () => {
    const hit = 'D:/shared/R/bio.R';
    expect(resolveModuleFilePath(['D:/cfg', 'D:/shared'], ['R', 'bio'], 1, existsOnly(hit))).toBe(
      hit,
    );
  });

  it('根的优先级高于扩展名：先命中的根里只有 .r，也不去看后面的根里的 .R', () => {
    const first = 'D:/cfg/R/bio.r';
    const second = 'D:/shared/R/bio.R';
    expect(
      resolveModuleFilePath(['D:/cfg', 'D:/shared'], ['R', 'bio'], 1, existsOnly(first, second)),
    ).toBe(first);
  });

  it('相对导入 ./helper：基准是当前文件所在目录', () => {
    const hit = `${PROJ}/R/model/helper.R`;
    expect(
      resolveModuleFilePath([`${PROJ}/R/model`], ['helper'], 0, existsOnly(hit)),
    ).toBe(hit);
  });

  it('相对导入 ../person：`..` 交给 join 折叠，基准仍是当前文件所在目录', () => {
    const hit = `${PROJ}/R/person.R`;
    expect(
      resolveModuleFilePath([`${PROJ}/R/model`], ['..', 'person'], 1, existsOnly(hit)),
    ).toBe(hit);
  });

  it('相对导入的 `..` 段：点它本身会命中父目录的 __init__.R（父目录作为模块）', () => {
    const parentInit = `${PROJ}/R/__init__.R`;
    expect(
      resolveModuleFilePath([`${PROJ}/R/model`], ['..', 'person'], 0, existsOnly(parentInit)),
    ).toBe(parentInit);
  });
});

describe('baseDirsForImport 该在哪些目录里找', () => {
  const roots = ['D:/cfg', 'D:/demo'];

  it('相对导入（./ ../）→ 只看当前文件所在目录，不跟候选根走', () => {
    expect(baseDirsForImport('file', 'D:/demo/R/model', roots)).toEqual(['D:/demo/R/model']);
  });

  it('普通导入 → 候选根，按优先级原样传下去', () => {
    expect(baseDirsForImport('root', 'D:/demo/R/model', roots)).toEqual(roots);
  });

  it('候选根为空（三层都没给出结果）→ 空数组，上层据此不跳', () => {
    expect(baseDirsForImport('root', 'D:/demo/R/model', [])).toEqual([]);
  });
});
