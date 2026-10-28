/**
 * CST 解析器自检：拿 R 自己的解析结果当标准答案，和我们的 parseCst 对比结构。
 *
 * 用法：node scripts/cst-check.mjs [额外的 R 代码片段...]
 *
 * 做法：
 *   1. 用 esbuild 把 src/parser/cst-parser.ts 打成临时 cjs（不改项目构建产物）
 *   2. 每段代码，我们解析成 CST，再压成"骨架表达式"（sexp）
 *   3. 同一段代码，让 Rscript 用 parse() 出树，也压成同一种 sexp
 *   4. 两边字符串相同 → OK；不同 → 打印两边方便看差在哪
 *
 * 为什么能比：R 的语法树和我们的语法树形状应该一致（这是 P1-c 的验收标准）。
 * 节点名、位置、字面量数值这些肯定不同，所以骨架里只留"结构 + 运算符 + 名字"。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(ROOT, 'out', 'cst-check.bundle.cjs');

/** 把我们的 CST 压成骨架：只留结构、运算符、名字；字面量统一写 NUM */
function toSexp(node) {
  if (node === null || node === undefined) return '?';
  switch (node.kind) {
    case 'Identifier':
      return node.text;
    case 'Literal':
      return 'NUM';
    case 'Paren':
      return toSexp(node.expr); // 骨架里括号不体现（R 的 deparse 会加回括号，见下面注释）
    case 'BinaryOp':
    case 'Assign':
    case 'NamespaceOp':
      return `(${node.operator.text} ${toSexp(node.lhs)} ${toSexp(node.rhs)})`;
    case 'UnaryOp':
      return `(${node.operator.text} ${toSexp(node.operand)})`;
    case 'Extract':
      return `(${node.operator.text} ${toSexp(node.target)} ${toSexp(node.member)})`;
    case 'Call': {
      const args = node.arguments.map(toSexp).filter((s) => s !== '');
      return `(${toSexp(node.callee)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    case 'Argument':
      // 空参（f(a, ) / x[1, ]）在骨架里直接跳过，和 R 的输出对齐
      if (node.value === undefined) return '';
      return node.name === undefined ? toSexp(node.value) : `(= ${node.name.text} ${toSexp(node.value)})`;
    case 'Subset': {
      const args = node.arguments.map(toSexp).filter((s) => s !== '');
      return `([ ${toSexp(node.target)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    case 'Subset2': {
      const args = node.arguments.map(toSexp).filter((s) => s !== '');
      return `([[ ${toSexp(node.target)}${args.length ? ` ${args.join(' ')}` : ''})`;
    }
    case 'Comma':
      return ',';
    case 'Error':
      return 'ERR';
    case 'Missing':
      return 'MISSING';
    default:
      return String(node.kind);
  }
}

/** R 侧：用 parse + 递归，输出同一种骨架。
 *  两个注意点（都是为了和我们的骨架对齐）：
 *    1. R 里 `(a)` 是一个 `(` 调用 → 骨架里要拆掉，只留里面（我们那边 Paren 也是拆掉的）
 *    2. 具名参数 `b = 2` 在 R 的 call 里是"名字 + 值" → 输出成 `(= b ...)`，和我们一样
 */
const R_SCRIPT = String.raw`
sexp <- function(e) {
  if (!is.call(e)) {
    if (is.name(e)) return(as.character(e))
    return("NUM")
  }
  head <- as.character(e[[1]])
  args <- as.list(e)[-1]

  # R 里的括号是个调用，拆掉（我们那边也拆）
  if (head == "(") return(sexp(args[[1]]))

  nms <- names(args)
  parts <- vapply(seq_along(args), function(i) {
    v <- sexp(args[[i]])
    if (!nzchar(v)) return("")            # 缺参（f(a, ) 的空位）→ 空串，最后过滤掉
    if (!is.null(nms) && nzchar(nms[i])) paste0("(= ", nms[i], " ", v, ")") else v
  }, character(1))
  parts <- parts[nzchar(parts)]
  if (length(parts) == 0) return(paste0("(", head, ")"))
  paste0("(", head, " ", paste(parts, collapse = " "), ")")
}
for (code in commandArgs(trailingOnly = TRUE)) {
  e <- tryCatch(parse(text = code)[[1]], error = function(err) NULL)
  cat(if (is.null(e)) "PARSE_ERROR" else sexp(e), "\n", sep = "")
}
`;

/**
 * 已知的"预期不一致"：我们和 R 的树本来就该不同，不算失败。
 * 每条写清原因，避免以后有人以为是 bug。
 */
const EXPECTED_DIFF = new Map([
  ['x |> f()', 'R 在语法层就把 |> 展开成 f(x)；我们保留 |> 原样（CST 要能还原原写法）'],
]);

const CASES = [
  'a$b$c',
  '1 + 2 * 3',
  '1 * 2 + 3',
  '-2^2',
  'a %in% b',
  'f(a)',
  'f(a, b = 2)',
  'x[1]',
  'x[[1]]',
  'a <- b <- 5',
  'a + b - c',
  '2^-2',
  '!a & b',
  '(1 + 2) * 3',
];

/** 我们侧：括号在骨架里会被丢掉，而 R 的 deparse 会把 ( ) 变成调用 —— 所以两边都先去掉 Paren */
function normalizeSexp(s) {
  return s.replace(/\s+/g, ' ').trim();
}

async function main() {
  const extra = process.argv.slice(2);
  const cases = extra.length > 0 ? extra : CASES;

  // 1) 打包我们的解析器
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  await build({
    entryPoints: [path.join(ROOT, 'src', 'parser', 'cst-parser.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: BUNDLE,
    logLevel: 'silent',
  });
  const { parseCst } = await import(`file://${BUNDLE.replace(/\\/g, '/')}?t=${Date.now()}`);
  const { tokenize } = await loadTokenizer();

  // 2) R 侧一次性跑完（把代码作为参数传过去）
  const rOut = runR(cases);

  // 3) 逐条对比
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  cases.forEach((code, i) => {
    const toks = tokenize(code, true);
    const program = parseCst(toks, (a, b) => !code.slice(a, b).includes('\n'));
    const mine = program.body.map(toSexp).map(normalizeSexp).join(' ; ');
    const theirs = (rOut[i] ?? '<无输出>').trim();
    const expected = EXPECTED_DIFF.get(code);
    const ok = mine === theirs || expected !== undefined;
    if (ok) pass += 1;
    else fail += 1;
    const tag = mine === theirs ? '✓' : expected !== undefined ? '≈' : '✗';
    if (mine !== theirs && expected !== undefined) skipped += 1;
    console.log(`${tag} ${code}`);
    if (mine !== theirs) {
      console.log(`    我们: ${mine}`);
      console.log(`    R   : ${theirs}`);
      if (expected !== undefined) console.log(`    （预期差异：${expected}）`);
    }
  });

  const total = cases.length;
  console.log(`\n通过 ${pass} / ${total}${fail ? `，失败 ${fail}` : ''}${skipped ? `（其中 ${skipped} 条是预期差异）` : ''}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function loadTokenizer() {
  const out = path.join(ROOT, 'out', 'cst-check-tokenizer.cjs');
  await build({
    entryPoints: [path.join(ROOT, 'src', 'parser', 'tokenizer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'silent',
  });
  return import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`);
}

function runR(cases) {
  const tmp = path.join(os.tmpdir(), `cst-check-${process.pid}.R`);
  fs.writeFileSync(tmp, R_SCRIPT, 'utf8');
  try {
    const stdout = execFileSync('Rscript', [tmp, ...cases], { encoding: 'utf8' });
    return stdout.split(/\r?\n/).filter((l, idx, arr) => idx < arr.length - 1 || l !== '');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

await main();
