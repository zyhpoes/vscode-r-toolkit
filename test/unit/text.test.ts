import { describe, expect, it } from 'vitest';
import { TextLines } from '../../src/utils/text';

describe('TextLines 位置换算', () => {
  it('单行文本：偏移量与行列一一对应', () => {
    const tl = new TextLines('hello');
    expect(tl.lineCount).toBe(1);
    expect(tl.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(tl.positionAt(5)).toEqual({ line: 0, character: 5 });
    expect(tl.offsetAt(0, 3)).toBe(3);
  });

  it('多行文本（\\n）', () => {
    const tl = new TextLines('hello\nworld');
    expect(tl.lineCount).toBe(2);
    expect(tl.positionAt(6)).toEqual({ line: 1, character: 0 });
    expect(tl.lineText(0)).toBe('hello');
    expect(tl.lineText(1)).toBe('world');
  });

  it('Windows 换行（\\r\\n）只算一个换行', () => {
    const tl = new TextLines('a\r\nb');
    expect(tl.lineCount).toBe(2);
    expect(tl.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(tl.lineText(0)).toBe('a');
    expect(tl.lineText(1)).toBe('b');
  });

  it('老 Mac 换行（\\r）也只算一个换行', () => {
    const tl = new TextLines('a\rb');
    expect(tl.lineCount).toBe(2);
    expect(tl.positionAt(2)).toEqual({ line: 1, character: 0 });
  });

  it('末尾换行产生一个空行', () => {
    const tl = new TextLines('a\n');
    expect(tl.lineCount).toBe(2);
    expect(tl.positionAt(2)).toEqual({ line: 1, character: 0 });
    expect(tl.lineText(1)).toBe('');
  });

  it('偏移量与行列互转可往返（round-trip）', () => {
    const text = 'line1\nline2\r\nline3\rline4'; // 三种换行混用
    const tl = new TextLines(text);
    for (let i = 0; i <= text.length; i++) {
      const pos = tl.positionAt(i);
      expect(tl.offsetAt(pos.line, pos.character)).toBe(i);
    }
  });

  it('越界输入被钳制到有效范围', () => {
    const tl = new TextLines('hi');
    expect(tl.positionAt(-5)).toEqual({ line: 0, character: 0 });
    expect(tl.positionAt(999)).toEqual({ line: 0, character: 2 });
    expect(tl.offsetAt(0, 999)).toBe(2);
    expect(tl.offsetAt(99, 0)).toBe(0);
  });

  it('空文本视为一行', () => {
    const tl = new TextLines('');
    expect(tl.lineCount).toBe(1);
    expect(tl.positionAt(0)).toEqual({ line: 0, character: 0 });
  });
});
