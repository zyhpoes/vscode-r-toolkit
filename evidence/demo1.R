# =============================================================================
# 20261026 zyh
#
# demo1 —— R6 的 active / public / private：定义规则、重名、跨继承、可见性
#
# 疑问（作者想要知道的信息）：
#   1. 如果在 active 中定义的不是函数，而是变量，会怎么样？
#   2. 如果在 active 和 public 中定义了相同的函数名，会怎么样？
#   3. 在当前类的 public 和父类的 active 定义了相同的函数名，会怎么样？
#   4. 在当前类的 active 和父类的 public 定义了相同的函数名，会怎么样？
#
# 结论（执行脚本后得到的信息）：
#   1. active 里的每一项必须是函数；放普通值 → 定义类时就报错
#        All items in active must be functions.
#   2. 同一个类里 public / private / active 名字必须全局唯一 → 定义类时报错
#        All items in public, private, and active must have unique names.
#      与书写顺序无关（public↔private、active↔private、同一 list 内重名，都是这一条）。
#   3. 子类 public 与父类 active 同名 → 两个类都定义成功，但 new() 实例化时崩
#        symbol already has a regular binding
#   4. 子类 active 与父类 public 同名 → 同上，实例化时崩（同一个错误）
#
# 附加结论（顺带测的）：
#   5. 同类性质同名（public↔public、active↔active）→ 合法：子类覆盖父类，
#      且父类方法里 self$dup() 也调到子类（动态派发），ls(实例) 里只出现一次。
#   6. active 在公共侧：ls(实例) 看得到，super$prop 读得到；差别只在读写会调函数。
#   7. active 的写是调 setter，不会像普通字段那样把值存下来（读回来仍是 getter 的结果）。
#
# 待定 / 不可靠（不要基于它写代码）：
#   - 父类 private 与子类 private 同名：同一格测了两次，一次 child:private、一次 NULL
#     → 行为不可靠，别这么写。
#
# 注意：脚本不含任何"找库 / 探测"逻辑 —— 默认这台机器已装好 R 与 R6；
#       缺了就让 R 自己报错，报错本身也是证据。
# =============================================================================

suppressMessages(library(R6))
cat("R:", R.version.string, "| R6:", as.character(packageVersion("R6")), "\n")

show <- function(label, expr) {
  val <- tryCatch(expr, error = function(e) paste("ERROR:", conditionMessage(e)))
  cat(label, "->", paste(format(val), collapse = " "), "\n")
}

# ---------- 情况 1：active 里放非函数 ----------
cat("\n=== 情况 1：active 里放非函数 ===\n")
tryCatch({
  R6Class("A", active = list(x = 1))
  cat("类定义：成功（预期不会到这里）\n")
}, error = function(e) cat("类定义报错:", conditionMessage(e), "\n"))

# ---------- 情况 2：同一个类里 public 与 active 同名 ----------
cat("\n=== 情况 2：同一个类里 public / active 同名 ===\n")
tryCatch({
  R6Class("B",
    public = list(dup = function() "public-fn"),
    active = list(dup = function(value) "active-fn"))
  cat("类定义：成功（预期不会到这里）\n")
}, error = function(e) cat("类定义报错:", conditionMessage(e), "\n"))

tryCatch({
  R6Class("B2",
    public = list(dup = function() "public"),
    private = list(dup = function() "private"))
  cat("public/private 同名：成功（预期不会到这里）\n")
}, error = function(e) cat("public/private 同名报错:", conditionMessage(e), "\n"))

# ---------- 情况 3：子类 public vs 父类 active ----------
cat("\n=== 情况 3：子类 public vs 父类 active ===\n")
Base3 <- R6Class("Base3", active = list(dup = function(value) "parent-active"))
Child3 <- R6Class("Child3", inherit = Base3, public = list(dup = function() "child-public"))
cat("定义 Base3 / Child3：都成功\n")
show("实例化 Child3$new()", Child3$new())

# ---------- 情况 4：子类 active vs 父类 public ----------
cat("\n=== 情况 4：子类 active vs 父类 public ===\n")
Base4 <- R6Class("Base4", public = list(dup = function() "parent-public"))
Child4 <- R6Class("Child4", inherit = Base4, active = list(dup = function(value) "child-active"))
cat("定义 Base4 / Child4：都成功\n")
show("实例化 Child4$new()", Child4$new())

# ---------- 附加 A：同类性质同名（合法）+ 动态派发 ----------
cat("\n=== 附加 A：父类 public / 子类 public 同名（合法）===\n")
BaseA <- R6Class("BaseA", public = list(dup = function() "parent-public"))
ChildA <- R6Class("ChildA", inherit = BaseA, public = list(dup = function() "child-public"))
show("ChildA$new()$dup()", ChildA$new()$dup())

BaseB <- R6Class("BaseB", public = list(dup = function() "parent-public", who = function() self$dup()))
ChildB <- R6Class("ChildB", inherit = BaseB, public = list(dup = function() "child-public"))
show("父类方法里 self$dup()（动态派发）", ChildB$new()$who())

# ---------- 附加 B：active 在公共侧 ----------
cat("\n=== 附加 B：active 在公共侧吗 ===\n")
E <- R6Class("E", active = list(prop = function(value) 42))
show("ls(E$new())", ls(E$new()))
Fcls <- R6Class("F", inherit = E, public = list(go = function() {
  paste("super$prop =", super$prop, "| ls(super) =", paste(ls(super), collapse = ","))
}))
show("子类方法里 super$prop / ls(super)", Fcls$new()$go())

# ---------- 附加 C：active 的读写会调函数 ----------
cat("\n=== 附加 C：active 的读写会调函数 ===\n")
J <- R6Class("J",
  public = list(plain = 1),
  active = list(act = function(value) {
    if (missing(value)) "read-active"
    else { cat("      [setter 被调用，收到]", value, "\n"); invisible(NULL) }
  }))
j <- J$new()
show("读 j$plain", j$plain)
show("读 j$act", j$act)
show("写 j$plain <- 99 之后读", { j$plain <- 99; j$plain })
show("写 j$act <- 99 之后读", { j$act <- 99; j$act })

# ---------- 附加 D：3×3 继承同名矩阵 ----------
cat("\n=== 附加 D：3×3 继承同名矩阵 ===\n")
# 定义也包一层：某格若在定义阶段就失败，也要打印出来（不能静默消失）
# 注意：不用 sprintf —— 参数长度为 0 时它会返回 character(0)，cat() 就一个字符都不打印
def <- function(expr) tryCatch(expr, error = function(e) e)
report <- function(label, cls) {
  out <- function(txt) cat(label, "->", paste(txt, collapse = "|"), "\n")
  if (inherits(cls, "error")) return(out(paste("定义报错:", conditionMessage(cls))))
  inst <- tryCatch(cls$new(), error = function(e) e)
  if (inherits(inst, "error")) return(out("实例化崩"))
  val <- tryCatch(inst$dup, error = function(e) e)
  if (inherits(val, "error")) val <- tryCatch(inst$.__enclos_env__$private$dup, error = function(e) e)
  if (inherits(val, "error")) return(out("读不到"))
  res <- if (is.function(val)) val() else val
  out(if (length(res) == 0) paste("空值（取到", paste(class(val), collapse = "/"), "）") else as.character(res))
}

pb <- R6Class("pb", public = list(dup = function() "parent:public"))
report("父 public / 子 public", def(R6Class("c1", inherit = pb, public = list(dup = function() "child:public"))))
report("父 public / 子 private", def(R6Class("c2", inherit = pb, private = list(dup = function() "child:private"))))
report("父 public / 子 active", def(R6Class("c3", inherit = pb, active = list(dup = function(value) "child:active"))))

pr <- R6Class("pr", private = list(dup = function() "parent:private"))
report("父 private / 子 public", def(R6Class("c4", inherit = pr, public = list(dup = function() "child:public"))))
report("父 private / 子 private", def(R6Class("c5", inherit = pr, private = list(dup = function() "child:private"))))
report("父 private / 子 active", def(R6Class("c6", inherit = pr, active = list(dup = function(value) "child:active"))))

pa <- R6Class("pa", active = list(dup = function(value) "parent:active"))
report("父 active / 子 public", def(R6Class("c7", inherit = pa, public = list(dup = function() "child:public"))))
report("父 active / 子 private", def(R6Class("c8", inherit = pa, private = list(dup = function() "child:private"))))
report("父 active / 子 active", def(R6Class("c9", inherit = pa, active = list(dup = function(value) "child:active"))))

cat("\n完成。\n")
