/**
 * 跨模块共享的纯类型（零 import，编译后消失，不会把依赖带进任何模块）。
 *
 * 纪律（新增之前先对照这三条，否则这个文件会变成"杂物间"）：
 *   ① 只放**被 ≥2 个模块消费**的类型；只服务一个模块的，跟那个模块的实现放一起。
 *   ② 只放纯类型：不放函数、不放常量（有运行时就不是纯类型了）。
 *   ③ 跟着"生产者"的类型留在原文件（R6ClassDef 在 r6-parser、DefinitionSite 在 definitions、
 *      Binding 在 bindings、R6Container 在 members）。
 */

/** 值类型：一个表达式 / 变量"是什么"的统一表示（求值器产出，成员查找 / 补全 / 跳转消费） */
// 20261026 zyh: 还缺少new.env(), 模块，第三方包，S3/S4的支持
export type ValueType =
  | { kind: 'r6-generator'; className: string } // 类生成器本身（Person / person$Person / P <- Person）
  | { kind: 'r6-instance'; className: string } // 实例（Person$new() / p <- Person$new()）
  | { kind: 'function' } // 指向函数
  | { kind: 'unknown' }; // 求不出（表达式 / 字面量 / 函数返回值…）
