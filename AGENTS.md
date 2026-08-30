# AGENTS.md — AI 开发规范

本文件是 **r-toolkit** 项目对 AI 协作代理（编码 Agent）的行为规范与项目决策记录。
任何 AI 代理在动手前必须先阅读本文件并遵守；修改本文件本身也必须先征得用户同意。

## 1. 协作铁律（最高优先级，违反即失职）

1. **先确认，再动手**：创建 / 修改 / 删除任何文件、安装依赖、运行命令之前，必须先向用户说明意图并等待明确确认。禁止自作主张提前执行。
2. **不批量生成文件**：一次只创建或讨论少量文件（逐个最好），保证用户能逐一看过来。禁止一次性批量生成脚手架或大段代码。
3. **有歧义先问，不猜测**：用户意图不明确时，先提问澄清，不要替用户做决定。
4. **尊重用户节奏**：用户表示"先忽略 / 不理解"的细节，不再反复解释或纠缠；每阶段结束停下来汇报，等用户确认再继续。
5. **诚实透明**：做错了、被拒绝了、命令失败了，如实说明原因和影响，不掩盖、不绕路。

## 2. 项目决策记录（已与用户确认，不得擅自更改；更改必须征得用户同意）

| 主题 | 决策 |
|---|---|
| 插件标识 | `name: r-toolkit`，`displayName: R Toolkit` —— 通用命名，定位 R 语言工具集，不只做 R6 |
| 版本号 | SemVer，当前 `0.1.0`（major=0 表示未稳定） |
| 许可证 | `PolyForm-Noncommercial-1.0.0`：源码公开、可学习可修改，**禁止商业用途**；使用标准许可，避免自造条款的法律风险 |
| VS Code 兼容 | `engines.vscode: ^1.135.0`（用户 VS Code 为 1.135.0），`@types/vscode: ~1.134.0`（官方 1.135.0 类型尚未发布，最新为 1.134.0；类型版本 ≤ 引擎版本保证安全，待官方发布后再同步升级） |
| 技术架构 | 纯 TypeScript 扩展，**零运行时依赖**；内置自研解析器（不依赖 tree-sitter 等原生模块） |
| 与 vscode-R 关系 | 独立扩展、共存：`onLanguage:r` 激活，不注册语言、不覆盖 vscode-R 已有能力 |
| 工具链 | TS strict + esbuild 打包 + vitest 测试 + ESLint (typescript-eslint) + @vscode/vsce 打包 |
| 分层原则 | 核心层（tokenizer / parser / analyzer）**不 import vscode API**，只输出纯数据（位置用 `{line, character}`）；vscode 类型只在 Provider 边界转换，保证核心逻辑可在纯 Node 中单测 |
| npm 权限方案 | A 方案：项目内 `.npmrc` 配置 `cache=.npm-cache`，避免写用户目录被沙箱拒绝 |

## 3. 功能范围

**v1（当前目标）**
- 定义跳转、代码补全、悬停信息、文档大纲
- 解析 `self$` / `private$` / `super$` / `ClassName$` 引用
- 支持 `inherit` 继承链解析与跨文件类索引

**v1 明确不做**（留待后续版本）
- `.Rmd` 代码块、重命名 / 引用高亮
- `lock_objects = FALSE` 动态成员
- R 运行时求值（不启动 R 进程）

## 4. 质量门禁

- 每个阶段结束必须全绿：`npm run build`、`npm run typecheck`、`npm test`、`npm run lint`
- 解析器 / 分析器等核心逻辑必须配套单元测试（vitest），测试夹具使用真实 R6 代码
- 写解析器之前先产出设计文档（DESIGN.md），明确 R6 语义模型与边界情况
- 代码风格：小函数、显式类型、禁止 `any`、错误处理明确
- 每阶段结束向用户汇报"做了什么 + 测试结果"，确认后才进入下一阶段

## 5. 开发里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 方案确认 | 技术路线与步骤表对齐 | ✅ 完成 |
| S1 脚手架 | 逐个创建配置文件、安装依赖、空壳扩展可 F5 | 🔄 进行中（`package.json` / `tsconfig.json` / `vitest.config.ts` / `.npmrc` / `.gitignore` 已创建，依赖已安装；待补 `esbuild.mjs`、`eslint.config.mjs`、`.vscode/`、`LICENSE`、`src/extension.ts` 等） |
| S2 设计文档 | `DESIGN.md`：架构分层、R6 语义模型、数据模型、边界情况 | ⏳ |
| S3 词法器 | R 词法（注释 / 字符串 / 反引号 / 嵌套）+ 单测 | ⏳ |
| S4 解析器 | `R6Class` 定义解析 + 单测 + 真实夹具 | ⏳ |
| S5 分析器 | 引用解析 + 工作区索引 + 继承链 + 跨文件 | ⏳ |
| S6 Providers | Definition / Completion / Hover / DocumentSymbols + 激活注册 | ⏳ |
| S7 收尾 | 集成测试、性能、vsce 打包、README / CHANGELOG | ⏳ |

## 6. 环境事实

- 工作目录：`D:\workspace\r-toolkit`（当前含 `.git`、`AGENTS.md`、`package.json`、`tsconfig.json`、`vitest.config.ts`、`.npmrc`、`.gitignore`、`node_modules/`、`.npm-cache/`）
- Node v22.19.0 / npm 10.9.3 / git 2.50.0
- 沙箱限制：文件操作仅允许在工作区内；npm 默认缓存目录（用户目录）会被拒绝 → 依赖安装必须走 `.npmrc` 的 A 方案
- 沟通语言：中文
