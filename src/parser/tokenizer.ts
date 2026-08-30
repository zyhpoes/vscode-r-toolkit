/**
 * R 词法器：把 R 代码字符串切成 token 流。
 * 纯逻辑：不读文件、不依赖 vscode，可在纯 Node 中测试。
 *
 * 切分规则（按字符类别）：
 *   - 空白：跳过
 *   - #：注释，到行尾
 *   - " 或 '：字符串，到配对引号（支持转义）
 *   - 数字 / .数字：数字字面量
 *   - 字母 / _ / . 开头：标识符（含 `反引号标识符`）
 *   - 其它符号：运算符，按"最长匹配"（如 <-、<<-、%>%）
 */

/** token 种类 */
export type TokenKind =
  | 'identifier' // 名字：R6Class、Person、self
  | 'string' // 字符串（存内容，不含引号）
  | 'number' // 数字字面量
  | 'operator' // 符号：<- $ ( ) { } , 等
  | 'comment'; // 注释：# 到行尾

/** 一个 token：种类 + 文本 + 在原文中的起始偏移量 */
export interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

/** 把 R 代码文本切成 token 数组 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // 空白符：跳过（不产生 token）。含 \v 垂直制表符、\f 换页符（R 规范中的空白）
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f') {
      i++;
      continue;
    }

    // 注释：# 到行尾（\n 为止）
    if (ch === '#') {
      const start = i;
      while (i < n && text[i] !== '\n') {
        i++;
      }
      tokens.push({ kind: 'comment', text: text.slice(start, i), offset: start });
      continue;
    }

    // 字符串：读到配对的引号；反斜杠转义跳过下一个字符
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          i++; // 跳过转义符本身
        }
        i++; // 跳到被转义字符之后
      }
      i++; // 跳过结束引号（若没找到配对引号，i 会停在 n，slice 截断即可）
      tokens.push({ kind: 'string', text: text.slice(start + 1, i - 1), offset: start });
      continue;
    }

    // 数字：数字开头，或 . 紧跟数字（如 .5）；只处理简单形式（小数），
    // 科学计数法 1e5 不在范围（不影响 R6 解析）
    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1] ?? ''))) {
      const start = i;
      while (i < n && (isDigit(text[i]) || text[i] === '.')) {
        i++;
      }
      tokens.push({ kind: 'number', text: text.slice(start, i), offset: start });
      continue;
    }

    // 标识符：字母 / _ / . 开头；含 `反引号标识符`（内容就是名字）
    if (isIdentifierStart(ch) || ch === '`') {
      if (ch === '`') {
        const start = i;
        i++;
        while (i < n && text[i] !== '`') {
          i++;
        }
        i++; // 跳过结束反引号
        tokens.push({ kind: 'identifier', text: text.slice(start + 1, i - 1), offset: start });
      } else {
        const start = i;
        while (i < n && isIdentifierPart(text[i])) {
          i++;
        }
        tokens.push({ kind: 'identifier', text: text.slice(start, i), offset: start });
      }
      continue;
    }

    // 运算符：按"最长匹配"吃（<-、<<-、->>、%>% 等）
    const start = i;
    i += operatorLength(text, i);
    tokens.push({ kind: 'operator', text: text.slice(start, i), offset: start });
  }

  return tokens;
}

/** 字符工具：是否为数字 */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** 字符工具：是否为 ASCII 字母 */
function isLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/** 字符工具：能否作为标识符开头 */
function isIdentifierStart(ch: string): boolean {
  return isLetter(ch) || ch === '_' || ch === '.';
}

/** 字符工具：能否作为标识符中间字符 */
function isIdentifierPart(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_' || ch === '.';
}

/**
 * 运算符最长匹配：返回从 i 起应吃掉几个字符。
 * 顺序：三字符 → 两字符 → %...% 自定义中缀 → 单字符。
 */
function operatorLength(text: string, i: number): number {
  const rest = text.slice(i);

  // 三字符运算符
  if (rest.startsWith('<<-') || rest.startsWith('->>')) {
    return 3;
  }

  // 两字符运算符
  if (
    rest.startsWith('<-') ||
    rest.startsWith('->') ||
    rest.startsWith('<=') ||
    rest.startsWith('>=') ||
    rest.startsWith('==') ||
    rest.startsWith('!=') ||
    rest.startsWith('&&') ||
    rest.startsWith('||')
  ) {
    return 2;
  }

  // %...% 自定义中缀运算符（如 %>%、%in%、%>%）
  if (rest.startsWith('%')) {
    const end = rest.indexOf('%', 1);
    if (end > 1) {
      return end + 1;
    }
  }

  // 默认：单字符（$、(、)、{、}、, 等）
  return 1;
}
