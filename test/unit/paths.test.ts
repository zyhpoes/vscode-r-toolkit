import { describe, expect, it } from 'vitest';
import { isAbsoluteLike, stripTrailingSep, toPosix } from '../../src/utils/paths';

describe('toPosix 把反斜杠统一成正斜杠', () => {
  it('Windows 路径 → 正斜杠', () => {
    expect(toPosix('D:\\workspace\\demo\\R')).toBe('D:/workspace/demo/R');
  });

  it('本来就是正斜杠 → 原样返回', () => {
    expect(toPosix('D:/workspace/demo/R')).toBe('D:/workspace/demo/R');
  });

  it('混合分隔符 → 全部统一成正斜杠', () => {
    expect(toPosix('D:\\workspace/demo\\R')).toBe('D:/workspace/demo/R');
  });

  it('Unix 路径与相对路径不受影响', () => {
    expect(toPosix('/home/me/demo')).toBe('/home/me/demo');
    expect(toPosix('R/schema/schema')).toBe('R/schema/schema');
    expect(toPosix('./R')).toBe('./R');
  });

  it('没有分隔符的裸名字 → 原样返回', () => {
    expect(toPosix('.Rprofile')).toBe('.Rprofile');
    expect(toPosix('schema')).toBe('schema');
  });

  it('不做其它清理：末尾斜杠、重复斜杠都原样保留（由后续函数各司其职）', () => {
    expect(toPosix('D:\\demo\\R\\')).toBe('D:/demo/R/');
    expect(toPosix('D:\\\\demo')).toBe('D://demo');
  });
});

describe('isAbsoluteLike 同时认同 Windows 与 Unix 的绝对路径', () => {
  it('Windows 盘符路径（正斜杠与反斜杠写法）→ 绝对', () => {
    expect(isAbsoluteLike('D:/workspace/demo')).toBe(true);
    expect(isAbsoluteLike('D:\\workspace\\demo')).toBe(true);
    expect(isAbsoluteLike('D:/')).toBe(true);
  });

  it('Unix 绝对路径 → 绝对', () => {
    expect(isAbsoluteLike('/home/me/demo')).toBe(true);
    expect(isAbsoluteLike('/')).toBe(true);
  });

  it('UNC 网络路径（两种写法）→ 绝对', () => {
    expect(isAbsoluteLike('//server/share/file')).toBe(true);
    expect(isAbsoluteLike('\\\\server\\share\\file')).toBe(true);
  });

  it('相对路径 → 不是绝对', () => {
    expect(isAbsoluteLike('R')).toBe(false);
    expect(isAbsoluteLike('./R')).toBe(false);
    expect(isAbsoluteLike('../shared')).toBe(false);
    expect(isAbsoluteLike('.')).toBe(false);
  });

  it('空串 → 不是绝对', () => {
    expect(isAbsoluteLike('')).toBe(false);
  });

  it('盘符相对写法（D: / C:foo）→ 不是绝对（Windows 语义如此，容易误解，专门钉住）', () => {
    expect(isAbsoluteLike('D:')).toBe(false);
    expect(isAbsoluteLike('C:foo')).toBe(false);
  });
});

describe('stripTrailingSep 去掉末尾斜杠（保护盘根）', () => {
  it('普通路径：去掉末尾斜杠', () => {
    expect(stripTrailingSep('D:/demo/R/')).toBe('D:/demo/R');
  });

  it('重复的末尾斜杠一起去掉', () => {
    expect(stripTrailingSep('D:/demo/R///')).toBe('D:/demo/R');
  });

  it('本来就没有末尾斜杠 → 原样返回', () => {
    expect(stripTrailingSep('D:/demo/R')).toBe('D:/demo/R');
  });

  it('盘根保护：/ 与 D:/ 原样保留（去掉斜杠语义就变了）', () => {
    expect(stripTrailingSep('/')).toBe('/');
    expect(stripTrailingSep('D:/')).toBe('D:/');
    expect(stripTrailingSep('D://')).toBe('D:/');
  });

  it('只有斜杠的输入 → 归一成根 /', () => {
    expect(stripTrailingSep('//')).toBe('/');
    expect(stripTrailingSep('///')).toBe('/');
  });

  it('UNC 路径：去掉末尾斜杠但保留前导 //', () => {
    expect(stripTrailingSep('//server/share/')).toBe('//server/share');
  });

  it('空串与裸名字 → 原样返回', () => {
    expect(stripTrailingSep('')).toBe('');
    expect(stripTrailingSep('R')).toBe('R');
  });
});
