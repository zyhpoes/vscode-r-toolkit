/**
 * R 的语法树（CST 层）：只描述"源码怎么写"，不含任何语义判断。
 * 纯类型定义，没有任何逻辑；AST 层（cst 去掉逗号 / 错误节点 / 括号位置）以后再建。
 *
 * 设计依据（都在文档 / 脚本里，可复跑）：
 *   docs/表达式树-决策.md        节点划分、字段、例子
 *   evidence/demo2.R             R 的语法元素清单（R 自己报的）
 *   evidence/demo3.R             运算符优先级与结合性（实测）
 *
 * 三条规矩（照 tree-sitter 的做法）：
 *   1. 不存原文 text —— 要原文时用 stOffset/enOffset 去切源码，省内存也不会和源码不同步
 *      （`CstIdentifier` / `CstLiteral` 是例外：名字和字面量的文本本身就是语义）
 *   2. 括号、分号不是节点，记成父节点的 xxxRange 字段；逗号是节点
 *   3. 解析器永不失败：认不出的片段用 CstError、缺的用 CstMissing，树永远覆盖全文
 */

/**
 * 一段源码的位置区间。
 * 注意：这不是 VS Code 的 `Range`（那个是行 / 列）；这里是 token 下标 + 字符偏移。
 * 两个坐标系统都要：下标用来切 tokens，偏移用来算行列。CST 和 AST 两层共用。
 */
export interface Span {
  /** 起始 token 在 tokens 数组里的下标 */
  stIndex: number;
  /** 结束 token 的下标（含） */
  enIndex: number;
  /** 起始字符偏移 */
  stOffset: number;
  /** 结束字符偏移（不含，半开区间） */
  enOffset: number;
}

/** 一个运算符：符号本身 + 它在源码里的位置。用于 `$` `@` `+` `%in%` `::` `<-` 等。 */
export interface CstOperator extends Span {
  /** 符号的原文，如 `+` `$` `::` `%in%` `<-` */
  text: string;
}

// ---------------------------------------------------------------- 根与注释

/** 整个文件。不算表达式，不能出现在值的位置。 */
export interface CstProgram extends Span {
  kind: 'Program';
  body: CstExpr[];
  /** 语句之间的 `;`（body.length - 1 个左右，可能为空数组） */
  separators: Span[];
  /** 独占一行的注释（文件头注释也在这里） */
  ownLineComments: CstComment[];
  /** 跟在代码同一行后面的注释 */
  trailingComments: CstComment[];
}

/** 一条注释。不属于任何节点，只靠位置决定它挨着谁。 */
export interface CstComment extends Span {
  kind: 'Comment';
  /** 含 `#` 号的原文 */
  text: string;
}

// ---------------------------------------------------------------- 名字与字面量

/** 一个名字：`x`、`.x`、`..1`、`...`、带反引号的 `` `weird name` `` */
export interface CstIdentifier extends Span {
  kind: 'Identifier';
  text: string;
}

/** 一个字面量：`42` `"hi"` `TRUE` `NULL` `NA` `Inf` `1i` */
export interface CstLiteral extends Span {
  kind: 'Literal';
  literalKind: 'number' | 'string' | 'logical' | 'null' | 'na' | 'complex';
  /** 源码里的原文，如 `42` / `"hi"` / `TRUE`（值本身也是语义，所以存下来） */
  text: string;
}

// ---------------------------------------------------------------- 调用与取子集

/** `f(a, b = 2)` */
export interface CstCall extends Span {
  kind: 'Call';
  // 为什么类型是 CstExpr 而不是 CstIdentifier？因为被调用的不一定是名字
  callee: CstExpr;
  /** 左括号 `(` 的位置（括号不是节点） */
  openSpan: Span;
  arguments: CstArgument[];
  /** 右括号 `)` 的位置 */
  closeSpan: Span;
}

/** 调用 / 取子集里的一个参数。`f(a, )` 是合法的，所以 value 可缺。 */
export interface CstArgument extends Span {
  kind: 'Argument';
  /** 具名参数 `b = 2` 里的 `b` */
  name?: CstIdentifier;
  value?: CstExpr;
}

/** `x[1]` */
export interface CstSubset extends Span {
  kind: 'Subset';
  target: CstExpr;
  openSpan: Span;
  /** 下标列表；空位（`x[1, ]`）用缺 value 的 CstArgument 表示 */
  arguments: CstArgument[];
  closeSpan: Span;
}

/** `x[[1]]` */
export interface CstSubset2 extends Span {
  kind: 'Subset2';
  target: CstExpr;
  openSpan: Span;
  arguments: CstArgument[];
  closeSpan: Span;
}

/** 取成员：`p$name` / `p@name`。两者形状一样，靠 operator.text 区分。 */
export interface CstExtract extends Span {
  kind: 'Extract';
  target: CstExpr;
  operator: CstOperator;
  member: CstIdentifier;
}

// ---------------------------------------------------------------- 运算符与赋值

/** 一元：`-a` `+a` `!a` `~a` `?a`（优先级见 evidence/demo3.R） */
export interface CstUnaryOp extends Span {
  kind: 'UnaryOp';
  operator: CstOperator;
  operand: CstExpr;
}

/** 二元：`a + b`、`a %in% b`、`x |> f()`、`a:b`（符号在 operator.text 里） */
export interface CstBinaryOp extends Span {
  kind: 'BinaryOp';
  operator: CstOperator;
  lhs: CstExpr;
  rhs: CstExpr;
}

/** 命名空间：`pkg::fn` / `pkg:::fn` */
export interface CstNamespaceOp extends Span {
  kind: 'NamespaceOp';
  operator: CstOperator;
  lhs: CstExpr;
  rhs: CstExpr;
}

/** 赋值：`x <- 1`、`1 -> x`、`x <<- 1`、`x = 1`（方向看 operator.text） */
export interface CstAssign extends Span {
  kind: 'Assign';
  operator: CstOperator;
  lhs: CstExpr;
  rhs: CstExpr;
}

// ---------------------------------------------------------------- 函数

/** `function(x, y = 1) body` 或 `\(x) body`（写法记在 keyword 里） */
export interface CstFunction extends Span {
  kind: 'Function';
  keyword: 'function' | '\\';
  openSpan: Span;
  parameters: CstParameter[];
  closeSpan: Span;
  body: CstExpr;
}

/** 一个形参：`x` 或 `x = 1` */
export interface CstParameter extends Span {
  kind: 'Parameter';
  name: CstIdentifier;
  default?: CstExpr;
}

// ---------------------------------------------------------------- 控制流

/** `if (cond) then else other`（`else if` 就是 alternative 里再放一个 CstIf） */
export interface CstIf extends Span {
  kind: 'If';
  openSpan: Span;
  condition: CstExpr;
  closeSpan: Span;
  consequence: CstExpr;
  /** `else` 关键字本身的位置（R 里 `} else {` 和换行后的 else 语义不同，格式化要用） */
  elseSpan?: Span;
  alternative?: CstExpr;
}

/** `for (i in seq) body`（`in` 不是节点） */
export interface CstFor extends Span {
  kind: 'For';
  openSpan: Span;
  variable: CstIdentifier;
  sequence: CstExpr;
  closeSpan: Span;
  body: CstExpr;
}

/** `while (cond) body` */
export interface CstWhile extends Span {
  kind: 'While';
  openSpan: Span;
  condition: CstExpr;
  closeSpan: Span;
  body: CstExpr;
}

/** `repeat body` */
export interface CstRepeat extends Span {
  kind: 'Repeat';
  body: CstExpr;
}

/** `break` / `next` */
export interface CstKeyword extends Span {
  kind: 'Keyword';
  keyword: 'break' | 'next';
}

// ---------------------------------------------------------------- 结构

/** `{ a; b }` */
export interface CstBlock extends Span {
  kind: 'Block';
  openSpan: Span;
  body: CstExpr[];
  /** 语句之间的 `;` */
  separators: Span[];
  closeSpan: Span;
}

/** 括号：`(a)`。CST 里保留（原样还原 / 格式化要用）；转 AST 时去掉，只留里面那个表达式。 */
export interface CstParen extends Span {
  kind: 'Paren';
  openSpan: Span;
  expr: CstExpr;
  closeSpan: Span;
}

/** 逗号。只有位置，没有子节点；只有 CST 有（AST 靠"列表有几个元素"表达）。 */
export interface CstComma extends Span {
  kind: 'Comma';
}

// ---------------------------------------------------------------- 错误恢复（只有 CST 有）

/** 认不出的片段：包住那几个 token，保证树覆盖全文。 */
export interface CstError extends Span {
  kind: 'Error';
  /** 被包住的 token 在 tokens 数组里的下标 */
  tokens: number[];
}

/** 缺了但能推断的东西：`f(a` 缺 `)`、`x <-` 缺右值。 */
export interface CstMissing extends Span {
  kind: 'Missing';
  expected: ')' | ']' | '}' | 'expression' | 'name';
}

// ---------------------------------------------------------------- 联合类型

/** 能当值用的节点。`CstProgram` 不在里面（它是文件根）。 */
export type CstExpr =
  | CstIdentifier
  | CstLiteral
  | CstCall
  | CstArgument
  | CstSubset
  | CstSubset2
  | CstExtract
  | CstUnaryOp
  | CstBinaryOp
  | CstNamespaceOp
  | CstAssign
  | CstFunction
  | CstParameter
  | CstIf
  | CstFor
  | CstWhile
  | CstRepeat
  | CstKeyword
  | CstBlock
  | CstParen
  | CstComma
  | CstError
  | CstMissing;
