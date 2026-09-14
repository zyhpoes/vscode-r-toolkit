# box 模块规则（本插件视角）

> 状态：设计约定，尚未实现（进度见 `DESIGN.md`）。改动本文件规则需经用户同意。

## 模块形态

| 形态 | 例子 | 导入写法 |
|---|---|---|
| 文件模块 | `R/schema/schema.R` | `box::use(R/schema/schema)` |
| 目录模块 | `R/bio/__init__.r`（目录的入口文件） | `box::use(R/bio)` |

试文件顺序（在候选根下）：`<模块路径>.r` / `.R` → `<模块路径>/__init__.r` / `.R`，第一个存在的胜出。

本地模块 vs 已安装包：**按文件存在性判定** —— 两种形态都不存在 → 视为已安装包，不跳转。
（不能按"路径里有没有 `/`"判断：`box.path = './R'` 时 `box::use(subject)` 不含 `/`，但它确是本地文件 `D:\workspace\demo\R\subject.R`）

## 导出什么（决定 `模块$` 补全列出哪些名字）

| 模块文件里的情况 | 导出的名字 |
|---|---|
| 有 `#' @export` 标记 | **只有被标记的名字** |
| **一个 `#' @export` 都没有** | **所有非隐藏名**（不以 `.` 开头） |
| 写了 `box::export()` | **零导出**（显式声明"我是 box 模块，不导出任何名字"） |
| `#' @export` 写在 `box::use(...)` 前 | 该导入声明的名字**再导出**（如 `bio$seq`） |

依据（box 官方 migration 指南原文）：

> "‘box’ makes exporting explicit. By default, *no* names are exported from a module, unless they are marked with the directive comment `#' @export`"
> "There's one exception to this: if a module contains *no* declared export, ‘box’ assumes that it is a plain R script, and treats it as a *legacy module*. This causes ‘box’ to revert to the export behaviour of ‘modules’"（即导出所有非隐藏名）

## 本插件 v1 的范围

| 能力 | v1 |
|---|---|
| 提取顶层符号 | 只提**顶层**赋值（函数 / 常量 / R6 类）；函数体内部的局部变量不算 |
| `#' @export` 标记 | 识别：有标记 → 只列标记的名字；无标记 → 列全部非隐藏名 |
| `box::export()` | 识别（零导出） |
| `#' @export box::use(./seq)` 的再导出 | **不做**（`bio$seq` 这类补不出来；点 `bio` 跳到 `__init__.r` 不受影响） |

## 待确认

- box 是否 `.r` / `.R` 两种扩展名都认（先按两种都试）
- `#' @export` 与赋值之间的注释 / 空行等细节，按实际项目用例再校准
