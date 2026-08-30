/**
 * 行 / 列位置（均为 0 起：第 0 行、第 0 列）。
 * 语义与 VS Code 的 Position 一致，但这里是纯数据，不依赖 vscode 模块
 * —— 核心层可以在纯 Node 中独立测试。
 */
export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

/**
 * 文本行索引工具：在「字符偏移量 offset」与「行 / 列位置」之间互转。
 *
 * 原理：构造时扫一遍文本，记录每行起始偏移量（starts）；
 * 之后每次查询用二分查找，O(log n)，与文本长度无关。
 *
 * 换行符：\n、\r\n、\r 都算换行（兼容 Unix / Windows / 老 Mac）。
 */
export class TextLines {
  private readonly text: string;
  private readonly starts: number[];

  constructor(text: string) {
    this.text = text;
    this.starts = computeLineStarts(text);
  }

  /** 总行数（空文本也算 1 行） */
  get lineCount(): number {
    return this.starts.length;
  }

  /** 文本总长度（字符数） */
  get length(): number {
    return this.text.length;
  }

  /** 偏移量 → 行列位置；越界偏移量钳制到最近的有效位置 */
  positionAt(offset: number): TextPosition {
    const clamped = clamp(offset, 0, this.text.length);
    const line = this.lineIndexAt(clamped);
    return { line, character: clamped - this.starts[line] };
  }

  /** 行列位置 → 偏移量；越界行钳制到最后一行，最终偏移量钳制到 [0, length] */
  offsetAt(line: number, character: number): number {
    const lineIndex = clamp(line, 0, this.starts.length - 1);
    return clamp(this.starts[lineIndex] + character, 0, this.text.length);
  }

  /** 某一行的文本内容（不含换行符） */
  lineText(lineIndex: number): string {
    const start = this.starts[lineIndex];
    const end = this.lineEndOffset(lineIndex);
    return this.text.slice(start, end);
  }

  /** 某行的结束偏移量（不含换行符；最后一行即文本末尾） */
  private lineEndOffset(lineIndex: number): number {
    if (lineIndex === this.starts.length - 1) {
      return this.text.length;
    }
    let end = this.starts[lineIndex + 1];
    if (end > 0 && this.text[end - 1] === '\n') {
      end -= 1; // 去掉 \n（可能是 \r\n 的 \n）
      if (end > 0 && this.text[end - 1] === '\r') {
        end -= 1; // 再去掉 \r
      }
    } else if (end > 0 && this.text[end - 1] === '\r') {
      end -= 1; // 单独 \r
    }
    return end;
  }

  /** 二分查找：包含该偏移量的行号 */
  private lineIndexAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }
}

/** 扫描文本，得到每行起始偏移量数组 */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    } else if (text[i] === '\r') {
      if (text[i + 1] === '\n') {
        i += 1; // \r\n 算一个换行，跳过 \n
      }
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 把 value 钳制到 [min, max] 区间 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
