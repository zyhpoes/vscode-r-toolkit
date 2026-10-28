/**
 * 打印 R 代码解析出来的 CST（给人看的）。
 *
 * 用法：
 *   node scripts/cst-tree.mjs                       # 跑内置的一批例子
 *   node scripts/cst-tree.mjs "a$b$c" "-2^2"        # 跑你给的代码
 *
 * 输出是缩进树：每个节点一行，冒号后面是它的字段。位置字段太啰嗦，默认不打印
 * （加 --pos 会打印每个节点的字符区间）。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(ROOT, 'out', 'cst-tree.bundle.cjs');
const ENTRY = path.join(ROOT, 'out', 'cst-tree.entry.ts');

const DEFAULTS = [
  // 'p$name',
  // 'a$b$c',
  // '1 + 2 * 3',
  // '1 * 2 + 3',
  // '1 * (2 + 3)',
  'f(a, b = 2)',
  // '-2^2',
  // 'f(a, b = 2)',
  // 'f(a, )',
  // '(1 + 2) * 3',
  // 'x <- y <- 5',
  // 'x[1]',
  // 'a + b # 尾注释',
];

/** 打印一个节点的树。位置字段默认省略，`--pos` 时打印字符区间。 */
function show(node, depth, showPos) {
  const pad = '  '.repeat(depth);
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((n) => show(n, depth, showPos));
    return;
  }
  if (typeof node !== 'object') return;

  // 纯 Span（没有 kind，只有 4 个位置字段）：直接打成区间，别让它看起来是空的
  if (node.kind === undefined) {
    if (typeof node.stOffset === 'number') {
      console.log(`${pad}[${node.stOffset}, ${node.enOffset})  ← token ${node.stIndex}..${node.enIndex}`);
    }
    return;
  }

  const bits = [];
  if (node.kind === 'Identifier') bits.push(`"${node.text}"`);
  if (node.kind === 'Literal') bits.push(`(${node.literalKind}) "${node.text}"`);
  if (['BinaryOp', 'UnaryOp', 'Assign', 'NamespaceOp', 'Extract'].includes(node.kind)) {
    bits.push(`"${node.operator.text}"`);
  }
  if (node.kind === 'Comment') bits.push(`"${node.text}"`);
  if (node.kind === 'Keyword') bits.push(`"${node.keyword}"`);
  if (node.kind === 'Argument' && node.name === undefined && node.value === undefined) bits.push('(空参)');
  if (showPos) bits.push(`[${node.stOffset}, ${node.enOffset})`);

  console.log(`${pad}${node.kind}${bits.length ? ' ' + bits.join(' ') : ''}`);

  const skip = new Set(['kind', 'text', 'literalKind', 'operator', 'keyword']);
  if (!showPos) ['stIndex', 'enIndex', 'stOffset', 'enOffset'].forEach((k) => skip.add(k));
  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue;
    const v = node[key];
    if (v === undefined) continue;

    const isSpan = !Array.isArray(v) && typeof v === 'object' && v?.kind === undefined && typeof v?.stOffset === 'number';
    const isSpanArray =
      Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'object' && x?.kind === undefined && typeof x?.stOffset === 'number');

    // 纯坐标字段（openSpan / closeSpan / separators）：只有 --pos 才显示
    if (isSpan || isSpanArray) {
      if (!showPos) continue;
      if (isSpan) console.log(`${pad}  ${key}: [${v.stOffset}, ${v.enOffset})`);
      else console.log(`${pad}  ${key}: ${v.map((x) => `[${x.stOffset}, ${x.enOffset})`).join(' ')}`);
      continue;
    }

    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      console.log(`${pad}  ${key}:`);
      v.forEach((n) => show(n, depth + 2, showPos));
    } else if (typeof v === 'object') {
      console.log(`${pad}  ${key}:`);
      show(v, depth + 2, showPos);
    }
  }
}

/** 递归去掉坐标字段（--no-pos 用）。Span 对象只由这 4 个字段组成，清空后整个字段一起消失。 */
function stripPositions(node) {
  const POS = ['stIndex', 'enIndex', 'stOffset', 'enOffset'];
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (POS.includes(k)) continue;
    const cleaned = stripPositions(v);
    // 清空成 {} 的（就是原来的 Span）整个字段删掉，别留空壳
    if (typeof cleaned === 'object' && cleaned !== null && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
      continue;
    }
    out[k] = cleaned;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const showPos = args.includes('--pos');
  const toJson = args.includes('--json');
  // --no-pos：JSON 里不写坐标（默认写；只看结构时关掉，文件会小很多）
  const noPos = args.includes('--no-pos');
  const codes = args.filter((a) => !['--pos', '--json', '--no-pos'].includes(a));
  const list = codes.length > 0 ? codes : DEFAULTS;

  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  fs.writeFileSync(
    ENTRY,
    "export { parseCst } from '../src/parser/cst-parser';\nexport { tokenize } from '../src/parser/tokenizer';\n",
    'utf8',
  );
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: BUNDLE,
    logLevel: 'silent',
  });
  const { parseCst, tokenize } = await import(`file://${BUNDLE.replace(/\\/g, '/')}?t=${Date.now()}`);

  // --json：把每段代码的 CST 写进 out/cst-parser.json（直接看文件核对用）
  if (toJson) {
    const cases = list.map((code) => {
      const cst = parseCst(tokenize(code, true), (a, b) => !code.slice(a, b).includes('\n'));
      return { code, cst: noPos ? stripPositions(cst) : cst };
    });
    const payload = {
      note: noPos
        ? '由 scripts/cst-tree.mjs --json --no-pos 生成；已去掉全部坐标字段，只看结构'
        : '由 scripts/cst-tree.mjs --json 生成；cst 就是 parseCst 的原样输出（含全部坐标字段）',
      cases,
    };
    const target = path.join(ROOT, 'out', 'cst-parser.json');
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`已写入 ${path.relative(ROOT, target)}（${list.length} 段代码${noPos ? '，不含坐标' : ''}）`);
    return;
  }

  for (const code of list) {
    console.log(`\n════════ 输入：${code}`);
    const tokens = tokenize(code, true);
    const program = parseCst(tokens, (a, b) => !code.slice(a, b).includes('\n'));
    show(program, 0, showPos);
  }
}

await main();
