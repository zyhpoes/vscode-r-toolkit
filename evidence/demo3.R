# =============================================================================
# 20261029 zyh
#
# demo3 —— R 的运算符优先级与结合性（写解析器前必须有的表）
#
# 疑问（作者想要知道的信息）：
#   1. 这些二元运算符分成几档？谁比谁紧？
#   2. 同档的时候是左结合还是右结合？
#
# 结论（执行脚本后得到的信息）：
#   见脚本末尾打印的「优先级组（从紧到松）」—— 同一行 = 同一档；行数越靠上越紧。
#   每档后面的括号是结合性。
#
# 方法（不查文档、不凭记忆）：
#   要判断 o1 / o2 谁更紧，让 R 解析 `a o1 b o2 c`，看两个运算符谁在【内层】。
#   内层 = 先算 = 更紧。但只看一次不够：内层也可能只是"写在前面"造成的。
#   所以要【反向再测一次】`a o2 b o1 c`：
#     - 两次都是同一个运算符在内层  → 它确实更紧
#     - 两次都是【写在前面那个】在内层 → 两者同级（左结合）
#   脚本第 0 节会把这个过程打印出来（用 * 和 + 当例子），后面的矩阵就是把这套
#   流程对每一对运算符跑一遍得到的。
#
# 对代码的含义：
#   这张表直接喂给 parser 的"算符优先"逻辑，不用手写 20×20 的格子。
# =============================================================================

# 求某个运算符在表达式树里的最小深度（根 0；深度大 = 在内层 = 更紧；找不到返回 Inf）
depthOfOp <- function(e, op) {
  if (!is.call(e)) return(Inf)
  here <- if (identical(as.character(e[[1]]), op)) 0 else Inf
  kids <- vapply(as.list(e)[-1], function(x) if (is.call(x)) depthOfOp(x, op) else Inf, numeric(1))
  min(here, if (length(kids)) min(kids) + 1 else Inf)
}

# 在 `a o1 b o2 c` 里谁更深：返回 "o1" / "o2" / "equal" / NA
comparePair <- function(o1, o2) {
  code <- sprintf("a %s b %s c", o1, o2)
  e <- tryCatch(parse(text = code)[[1]], error = function(err) NULL)
  if (is.null(e)) return(NA_character_)
  d1 <- depthOfOp(e, o1); d2 <- depthOfOp(e, o2)
  if (!is.finite(d1) || !is.finite(d2)) return(NA_character_)
  if (d1 > d2) "o1" else if (d2 > d1) "o2" else "equal"
}

# 规范化：把"在 a X b Y c 里谁更深"翻译成"X 相对 Y"
rel <- function(result, firstIs, secondIs) {
  if (is.na(result)) return(NA_character_)
  if (result == "o1") firstIs else if (result == "o2") secondIs else "equal"
}

# o1 相对 o2：'>' 表示 o1 更紧，'<' 表示 o2 更紧，'=' 同级，NA 测不出
# 关键：两次解析都在回答"o1 相对 o2 谁更紧"。两次答案一致 → 就信它；不一致 → 说明同级（结合性造成的假象）
relOf <- function(o1, o2) {
  fwd <- rel(comparePair(o1, o2), "first", "second")   # a o1 b o2 c
  rev <- rel(comparePair(o2, o1), "second", "first")   # a o2 b o1 c（注意 o1 在这里是第二个参数）
  if (is.na(fwd) || is.na(rev)) return(NA_character_)
  if (fwd == rev) return(if (fwd == "first") ">" else if (fwd == "second") "<" else "=")
  "="  # 两次答案相反：两者同级（左/右结合导致顺序不同）
}

bino <- c("^", "*", "/", "+", "-", ":", "%in%", "<", ">", "<=", ">=",
          "==", "!=", "&", "&&", "|", "||", "~")

cat("R:", R.version.string, "\n\n")

cat("=== 0) 先看一个具体例子：* 和 + 谁更紧 ===\n\n")
showTree <- function(e, depth = 0) {
  pad <- strrep("  ", depth)
  if (!is.call(e)) { cat(pad, paste(deparse(e), collapse = " "), "\n", sep = ""); return(invisible(NULL)) }
  cat(pad, paste(deparse(e[[1]]), collapse = " "), "   (深度 ", depth, ")\n", sep = "")
  for (x in as.list(e)[-1]) showTree(x, depth + 1)
}
for (code in c("a * b + c", "a + b * c")) {
  cat("# ", code, "\n", sep = "")
  showTree(parse(text = code)[[1]])
  cat("\n")
}
cat("上面两棵树里，* 都在内层（深度 1），+ 都在外层（深度 0）\n")
cat("→ 内层先算，所以 * 比 + 紧。两次反过来测都在内层，说明不是'写在前面'造成的。\n\n")

cat("再看同级的例子（* 和 /，左结合）：\n")
for (code in c("a * b / c", "a / b * c")) {
  cat("# ", code, "\n", sep = "")
  showTree(parse(text = code)[[1]])
  cat("\n")
}
cat("两次都是'写在前面那个'在内层 → 两者同级（左结合）。\n\n")

cat("=== 1) 两两关系矩阵 ===\n")
cat("row 表示行更紧，col 表示列更紧，= 表示同级，? 表示测不出，self 表示自己和自己比较\n\n")
# 把 relOf 的结果翻译成好读的标记
display <- function(r) {
  if (is.na(r)) "?" else if (identical(r, ">")) "row" else if (identical(r, "<")) "col" else "="
}
cat(sprintf("%-6s", ""), paste(sprintf("%-6s", bino), collapse = ""), "\n", sep = "")
for (o1 in bino) {
  row <- vapply(bino, function(o2) if (o1 == o2) "self" else display(relOf(o1, o2)), character(1))
  cat(sprintf("%-6s", o1), paste(sprintf("%-6s", row), collapse = ""), "\n", sep = "")
}

cat("\n=== 2) 优先级组（从紧到松：第 1 档最紧）===\n\n")
# 用"同级"合并成组
groups <- list()
for (op in bino) {
  placed <- FALSE
  for (g in seq_along(groups)) {
    if (identical(relOf(op, groups[[g]][1]), "=")) { groups[[g]] <- c(groups[[g]], op); placed <- TRUE; break }
  }
  if (!placed) groups[[length(groups) + 1]] <- op
}

# 组间：g 比 h 紧 → g 在前。用选择排序：每轮从未定的组里挑"没有别人比它更紧"的那个
isTighter <- function(g, h) identical(relOf(groups[[g]][1], groups[[h]][1]), ">")
orderIdx <- integer(0)
remaining <- seq_along(groups)
while (length(remaining) > 0) {
  pick <- remaining[1]
  for (i in remaining) {
    if (isTighter(i, pick)) pick <- i
  }
  orderIdx <- c(orderIdx, pick)
  remaining <- setdiff(remaining, pick)
}

assocOf <- function(op) {
  e <- tryCatch(parse(text = sprintf("a %s b %s c", op, op))[[1]], error = function(err) NULL)
  if (is.null(e)) return("不可连用")
  l <- is.call(e[[2]]) && identical(as.character(e[[2]][[1]]), op)
  r <- is.call(e[[3]]) && identical(as.character(e[[3]][[1]]), op)
  if (l && !r) "左结合" else if (r && !l) "右结合" else "?"
}

# 给"能看出结合性差异"的档举一个例子。只挑最常见的三档，其余一律说"无数值例子"：
#   - `^`：2^3^2 = 512（右结合才会是 512；左结合会得 64）
#   - `* /`：用除法 100/10/2 = 5（左结合；右结合会得 20）—— 乘法左右算一样，看不出差别
#   - `+ -`：用减法 10-3-2 = 5（左结合；右结合会得 9）—— 加法左右算一样
# 同一档里任一运算符优先级相同，所以 `* /` 档拿 / 举例、`+ -` 档拿 - 举例，都是这一档的规则。
examples <- c(
  "^" = "2 ^ 3 ^ 2",
  "*" = "100 / 10 / 2",
  "+" = "10 - 3 - 2"
)

assocExample <- function(op) {
  code <- unname(examples[op])
  if (length(code) == 0 || is.na(code)) {
    if (identical(assocOf(op), "不可连用")) return("例：（不可连用，写不出来）")
    return("例：（无数值例子 —— 连用没有实际含义，或左右算数值相同）")
  }
  # 例子实际用的运算符（去重后；可能是同档的另一个，如 * 档用 /）
  used <- paste(unique(strsplit(gsub("[0-9() ]", "", code), "")[[1]]), collapse = "")
  v <- tryCatch(paste(format(eval(parse(text = code))), collapse = " "), error = function(err) "?")
  prefix <- if (identical(used, op)) "例：" else sprintf("例（同档 %s）：", used)
  sprintf("%s%s = %s", prefix, code, v)
}

rank <- 0
for (k in orderIdx) {
  rank <- rank + 1
  g <- groups[[k]]
  cat(sprintf("第 %-2d 档   %-8s  %-8s  %s\n", rank, paste(g, collapse = " "), assocOf(g[1]), assocExample(g[1])))
}
cat("\n说明：档号越小越紧。\n")
cat("  - 不同档：不管怎么写，档号小的那个总先算（`a * b + c` 和 `a + b * c` 都是 * 先算）。\n")
cat("  - 同一档：谁先算由【结合性】决定（见第 3 节），而不是由档号决定。\n")
cat("  - parser 实际只需要\"每个运算符一个等级数字\"，不用存两两关系。\n")

cat("\n--- 2b) 完整档位表（把后缀 / 一元 / 赋值也插进去）---\n")
cat("上面那 14 档只含【二元】运算符。补上后缀、一元、赋值后的完整顺序如下：\n")
cat("（二元各档来自本节自动生成；后缀 / 一元 / 赋值来自第 5 节单独实测）\n\n")
cat("档   运算符                     形式    结合性      实测证据\n")
cat("1    $ @ [ [[                   后缀    -           -x$y  的树是 -(x$y)\n")
cat("2    ^                          二元    右结合      2^3^2 = 512\n")
cat("3    :                          二元    左结合      (无常用例子)\n")
cat("4    %op%  |>                   二元    左结合      x |> f() 等价 f(x)\n")
cat("5    一元 - +                   前缀    -           -a*b  的树是 (-a)*b\n")
cat("6    * /                        二元    左结合      100/10/2 = 5\n")
cat("7    + -（二元）                二元    左结合      10-3-2 = 5\n")
cat("8    < > <= >= != ==            二元    不可连用    a<b<c 是语法错误\n")
cat("9    一元 !                     前缀    -           !a & b 的树是 (!a)&b；!a + b 的树是 !(a+b)\n")
cat("10   & &&                       二元    左结合      -a & b 先算 -a\n")
cat("11   | ||                       二元    左结合      -a | b 先算 -a\n")
cat("12   一元 ~                     前缀    -           ~a + b 的树是 ~(a+b)（比 || 还松）\n")
cat("13   <- <<- = -> ->>            赋值    右结合      a <- b <- 5（两边都是 5）\n")
cat("\n关键三条（之前写错过，这里按实测为准）：\n")
cat("  1) ^ 比一元 - 紧：-2^2 = -(2^2) = -4，不是 (-2)^2 = 4。\n")
cat("  2) 一元 - 比 : 紧：-a : b 的树是 (-a):b，不是 -(a:b)。\n")
cat("  3) ^ 的右边可以是一元：2^-2 = 0.25（合法代码，parser 要支持）。\n")

cat("\n=== 3) 三个概念：左结合 / 右结合 / 不可连用 ===\n")
cat("（下面每条都直接跑 R 拿到真实数值，不是查文档）\n\n")

cat("左结合 = 同一个运算符连用时，先算【左边】\n")
cat("  10 - 3 - 2    = ", 10 - 3 - 2, "   （若右结合会得到 10-(3-2) = ", 10 - (3 - 2), "）\n", sep = "")
cat("  100 / 10 / 2  = ", 100 / 10 / 2, "   （若右结合会得到 100/(10/2) = ", 100 / (10 / 2), "）\n\n", sep = "")

cat("右结合 = 先算【右边】\n")
cat("  2 ^ 3 ^ 2     = ", 2^3^2, "  （若左结合会得到 (2^3)^2 = ", (2^3)^2, "）\n", sep = "")
a <- b <- 5
cat("  a <- b <- 5   → a = ", a, ", b = ", b, "  （等于 a <- (b <- 5)；反过来写不合法）\n\n", sep = "")

cat("不可连用 = 这种写法在 R 里【语法错误】，根本解析不出来\n")
cat("  a < b < c     → ")
tryCatch({ eval(parse(text = "a < b < c")); cat("居然能跑（意外）\n") },
         error = function(e) cat("报错：", strsplit(conditionMessage(e), "\n")[[1]][1], "\n", sep = ""))
cat("  原因：a < b 得到 TRUE/FALSE，再拿它去 < c 没意义，所以 R 直接禁止。\n")
cat("  注意：Python 允许 a < b < c（等价于 a < b and b < c），R 不是这样。\n\n")

cat("顺带：^ 比一元 - 更紧\n")
cat("  -2^2 = ", -2^2, "  （等价于 -(2^2)；若是 (-2)^2 会得到 ", (-2)^2, "）\n", sep = "")

cat("\n=== 4) 其它（native 管道）===\n")
cat("x |> f()：", {
  e <- parse(text = "a |> f()")[[1]]
  sprintf("头是 %s（等价于 f(a)）", paste(deparse(e[[1]]), collapse = ""))
}, "\n")

cat("\n=== 5) 一元运算符（- + !）和取子集（$ [ 等）的位置 ===\n")
cat("注意：第 1~2 节只测了【二元】运算符。一元运算符必须单独定位置，否则 -2^2 会算错。\n\n")

cat("方法：解析 `-a OP b`，看 - 是包住整个式子（说明 OP 更紧），还是只包住 a（说明 - 更紧）。\n\n")
for (op in c("^", ":", "%in%", "*", "+", "<", "&", "|", "~")) {
  code <- sprintf("-a %s b", op)
  e <- tryCatch(parse(text = code)[[1]], error = function(err) NULL)
  if (is.null(e)) { cat(sprintf("  %-12s 语法不通\n", code)); next }
  # 外层是 - 且它的孩子是 call → 二元运算被包在 - 里面 → 二元更紧
  binoTighter <- identical(as.character(e[[1]]), "-") && is.call(e[[2]])
  cat(sprintf("  %-12s → %s\n", code,
              if (binoTighter) sprintf("%s 比一元 - 紧（- 包住整个式子）", op) else "一元 - 更紧（先算 -a）"))
}

cat("\n后缀形式（$ @ [ [[）比一元更紧：\n")
for (code in c("-x$y", "-x[1]", "!a$b")) {
  e <- tryCatch(parse(text = code)[[1]], error = function(err) NULL)
  if (!is.null(e)) cat(sprintf("  %-8s → 外层是 %s，里层是 %s\n", code,
                               deparse(e[[1]]), deparse(e[[2]][[1]])))
}

cat("\n所以 -2^2 的树是：\n")
show2 <- function(e, depth = 0) {
  pad <- strrep("  ", depth)
  if (!is.call(e)) { cat(pad, paste(deparse(e), collapse = " "), "\n", sep = ""); return(invisible(NULL)) }
  cat(pad, paste(deparse(e[[1]]), collapse = " "), "\n", sep = "")
  for (x in as.list(e)[-1]) show2(x, depth + 1)
}
show2(parse(text = "-2^2")[[1]])
cat("  → 值 = ", -2^2, "（若是 (-2)^2 会得 ", (-2)^2, "）\n", sep = "")

cat("\n`^` 的右边也可以是一元（合法写法）：2^-2\n")
show2(parse(text = "2^-2")[[1]])
cat("  → 值 = ", 2^-2, "\n", sep = "")

cat("\n结论：优先级从紧到松（只列与一元相关的部分）\n")
cat("  $ @ [ [[   ＞   ^   ＞   : %op%   ＞   一元 - +   ＞   * /   ＞   + -   ＞   比较   ＞   一元 !   ＞   & &&   ＞   | ||   ＞   一元 ~\n")
cat("  注意一元 ! 的位置很怪：它比比较运算符松，但比 & && 紧（!a & b 是 (!a)&b，!a + b 却是 !(a+b)）。\n")

cat("\n=== 6) 三种判断方法各管什么（为什么有的档没有数值例子）===\n")
cat("档位（优先级）  → 看【深度】：更深的先算。\n")
cat("结合性          → 看【树形】：外层节点的左孩子是 call → 左结合；右孩子是 call → 右结合；都不是 → 不许连用。\n")
cat("数值            → 只是【辅助】，能区分就给人看；区分不了就不给（不影响结合性的判定）。\n\n")

cat("例一：第 2 档 `:` —— 数值能区分，但代码写法很怪（所以表里没给例子）\n")
showSmall <- function(code) {
  e <- parse(text = code)[[1]]
  txt <- if (is.call(e[[2]])) "左孩子是 call" else "左孩子不是 call"
  val <- paste(suppressWarnings(eval(parse(text = code))), collapse = " ")
  cat(sprintf("  %-14s → %-12s  值 = %s\n", code, txt, val))
}
showSmall("1:3:2")       # 左结合时等价于 (1:3):2
showSmall("(1:3):2")     # 手动写成左结合
showSmall("1:(3:2)")     # 手动写成右结合
cat("  `1:3:2` 的值和 `(1:3):2` 相同 → 说明它按左结合解析。\n")
cat("  （`(1:3)` 是序列 1 2 3，再 `: 2` 只取第一个元素 2 当终点，所以得 1 2；R 会给警告。）\n\n")

cat("例二：第 3 档 `%in%` —— 数值完全区分不了，只能看树形\n")
for (code in c("1 %in% 2 %in% 3", "(1 %in% 2) %in% 3", "1 %in% (2 %in% 3)")) {
  cat(sprintf("  %-20s → %s\n", code, paste(eval(parse(text = code)), collapse = " ")))
}
e <- parse(text = "1 %in% 2 %in% 3")[[1]]
cat(sprintf("  但树形：左孩子是 call = %s，右孩子是 call = %s → 先算左边 → 左结合\n",
            is.call(e[[2]]), is.call(e[[3]])))
