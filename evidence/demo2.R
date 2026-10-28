# =============================================================================
# 20261028 zyh
#
# demo2 —— R 的表达式长什么样（自己写语法树之前，先看 R 自己怎么拆）
#
# 疑问（作者想要知道的信息）：
#   1. 一段 R 代码，R 内部把它拆成什么形状？
#   2. 自己写解析器要覆盖哪些元素？有几个容易搞错的？
#
# 结论（执行脚本后得到的信息）：
#   1. R 把代码拆成"头 + 参数"的嵌套结构（call）：`x$y` 的头是 `$`，参数是 x 和 y
#   2. 优先级在树里是天然的：`1 + 2 * 3` 的 `*` 是 `+` 的子节点，不用记表格
#   3. TRUE / FALSE / NA / Inf 都是"数字常量"（不是名字）
#   4. x$y 的 y 是普通名字；只有 x@y 的 y 是"槽"（S4）
#   5. f(a, ) 合法（空实参）；(a) 只是 a，括号不产生节点
#   6. x |> f() 的管道是独立符号（与 %>% 不同）
#
# 对代码的含义：
#   要写的节点类型 = 下面出现的"头"的种类，可控（约 20 种）。
# =============================================================================

# 把 R 的表达式树按缩进打印出来。
# 每行前面标出"它在父节点里是第几个位置"[[k]]：R 的树里【没有 else / in 这类节点】，
# 它们只是位置 —— 例如 if 的 [[3]] 是 then 分支、[[4]] 是 else 分支。
showTree <- function(e, depth = 0) {
  pad <- strrep("  ", depth)
  if (!is.call(e)) {
    cat(pad, paste(deparse(e), collapse = " "), "\n", sep = "")
    return(invisible(NULL))
  }
  cat(pad, paste(deparse(e[[1]]), collapse = " "), "\n", sep = "")
  items <- as.list(e)[-1]
  nms <- names(items)
  for (k in seq_along(items)) {
    where <- paste0("[[", k + 1, "]] ")
    if (is.call(items[[k]])) {
      cat(pad, "  ", where, sep = "")
      showTree(items[[k]], depth + 1)
    } else {
      label <- if (!is.null(nms) && nzchar(nms[k])) paste0(nms[k], " = ") else ""
      cat(pad, "  ", where, label, paste(deparse(items[[k]]), collapse = " "), "\n", sep = "")
    }
  }
}

cat("R:", R.version.string, "\n")

cat("\n===== 一、成员与取子集：头就是那个符号 =====\n")
for (code in c("x$y", "x@y", "x[[1]]", "x[1, 2]", "a$b$c")) {
  cat("\n# ", code, "\n", sep = "")
  showTree(parse(text = code)[[1]])
}

cat("\n===== 二、运算符：优先级是树形自带的 =====\n")
for (code in c("1 + 2 * 3", "1 + 2 * 3 ^ 4", "-x + y", "a %in% b", "x |> f()", "pkg::fn")) {
  cat("\n# ", code, "\n", sep = "")
  showTree(parse(text = code)[[1]])
}

cat("\n===== 三、调用与控制流 =====\n")
# if 的四个位置：[[2]] 条件、[[3]] then 分支、[[4]] else 分支 —— 树里【没有 else 节点】
# for 的四个位置：[[2]] 循环变量、[[3]] 序列表达式、[[4]] 循环体 —— 树里【没有 in 节点】
for (code in c("f(a, b = 2)", "f(a, )", "if (a) b else c", "for (i in 1:3) print(i)", "{ a; b }", "(a)")) {
  cat("\n# ", code, "\n", sep = "")
  showTree(parse(text = code)[[1]])
}

cat("\n===== 四、function 的体（R 存在 [[3]]，不是 [[2]]）=====\n")
fn <- parse(text = "function(x, y = 1) x + y")[[1]]
cat("# function(x, y = 1) x + y\n")
cat("  形参：", paste(deparse(fn[[2]]), collapse = " "), "\n", sep = "")
cat("  体：\n")
showTree(fn[[3]], 1)

cat("\n===== 五、@ 是什么：S4 对象的槽，和 $ 互不通用 =====\n")
setClass("P", representation(name = "character"))
p <- new("P", name = "zyh")
cat("S4 对象：p@name  -> ", p@name, "\n")
cat("S4 对象：p$name  -> ")
tryCatch(print(p$name), error = function(e) cat("报错:", conditionMessage(e), "\n"))

suppressMessages(library(R6))
A <- R6Class("A", public = list(name = "zyh"))
a <- A$new()
cat("R6 对象：a$name  -> ", a$name, "\n")
cat("R6 对象：a@name  -> ")
tryCatch(print(a@name), error = function(e) cat("报错:", conditionMessage(e), "\n"))

cat("\n===== 六、TRUE 是名字还是常量（让 R 自己判断）=====\n")
cat("is.name(quote(TRUE))  -> ", is.name(quote(TRUE)), "  （FALSE：不是名字，是常量）\n")
cat("is.name(quote(x$y)[[3]]) -> ", is.name(quote(x$y)[[3]]), "  （TRUE：$ 右边是普通名字）\n")
cat("is.name(quote(x@y)[[3]]) -> ", is.name(quote(x@y)[[3]]), "  （TRUE：@ 右边【也】是普通名字）\n")
cat("is.call(quote(x |> f())) -> ", is.call(quote(x |> f())), "  （TRUE：管道在树里就是普通调用）\n")
