// 事实模块共用的文本小工具 + predicate 基数定义。
//
// ⚠ 单独一个文件是为了**打破循环依赖**：
//   fact-builder.mjs ↔ fact-relation.mjs 互相要用这几个东西，
//   放谁那边都会绕回来。抽出来双方都只依赖它。

/**
 * predicate 的**基数类型** —— 决定「同键不同值」该怎么处理。
 *
 * ⚠ 这是 D3 修正的核心之一：以前把「同 predicate 不同 value」一律当冲突，
 *   所以「他玩明日方舟」和「他玩卫戍协议」会互相杀。
 *   事实上 predicate 的语义本来就不一样：
 *
 *   single     同一时刻只能有一个值（居住城市、学校、称呼）
 *              → 不同值 = 真的换掉了 / 真冲突，需要关系裁判确认
 *   set        允许多个值同时成立（玩的游戏、喜欢的食物）
 *              → 不同值 = 各自成立，**不得判冲突**
 *   composite  可能是同一概念的不同说法（沟通风格）
 *              → 必须问关系裁判 same / distinct
 *   temporal   随时间变化（临时状态），按时间与明确纠正处理
 *
 * ⚠ 未登记的 predicate 默认 single（最保守：宁可进未决冲突，不可静默并存）。
 */
export const predicate基数表 = Object.freeze({
  'user.preference.communication_style': 'composite',
  'user.game.plays': 'set',
  'user.preference.food': 'set',
  'user.preference.drink': 'set',
  'user.preference.hobby': 'set',
  'user.preference.music': 'set',
  // ⭐ 2026-11-09 B3B：负向偏好独立成键，set（一个人可以讨厌多件事）
  'user.preference.dislike': 'set',
  'user.identity.city': 'single',
  'user.identity.school': 'single',
  'user.identity.name': 'single',
  'user.identity.occupation': 'single',
  'relationship.callname': 'single',
})

/**
 * 取 predicate 的基数类型。
 *
 * 支持前缀通配：`user.temporary_state.*` → temporal，
 * 这样新出现的临时状态 predicate 不用一个个登记。
 */
export function 取基数(predicate) {
  const p = String(predicate || '')
  if (predicate基数表[p]) return predicate基数表[p]
  if (p.startsWith('user.temporary_state.')) return 'temporal'
  return 'single'
}

/** 事实的值取成字符串（兼容 value / 值 / 值文本 三种历史写法） */
export function 事实值文本(f) {
  if (!f) return ''
  if (typeof f === 'string') return f
  if (f.value != null) return typeof f.value === 'string' ? f.value : JSON.stringify(f.value)
  if (f.值 != null) return String(f.值)
  if (f.值文本 != null) return String(f.值文本)
  return ''
}

/** 归一文本：去掉标点与空白，小写。用于「完全相等」这种确定性判断。 */
export function 归一文本(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()【】\[\]…—\-~～]/g, '')
    .toLowerCase()
}
