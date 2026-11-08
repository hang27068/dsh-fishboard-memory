// 纯合并逻辑：不访问磁盘、宿主或模型，便于复现后台旧快照与删除交错。
export function 合并库(盘, 写, 选项 = {}) {
  const 更新时间 = (m) => Math.max(
    Date.parse(m.editedAt || 0) || 0,
    Date.parse(m.relatedAt || 0) || 0,
    Date.parse(m.reinforcedAt || 0) || 0,
    Date.parse(m.deletedAt || 0) || 0,
    Date.parse(m.createdAt || 0) || 0,
    // ⭐ 2026-10-26 本地分叉：**约定「提过」也算一次更新** ✓
    //   「提过」是单调的（没提过 → 提过，不会倒回来），要是它不算时间，
    //   一个早先读出、还没标「提过」的旧快照被写回来，就会把标记抹掉 →
    //   同一条约定第二天又念一遍 ✗
    Date.parse((m.约定 && m.约定.提过) || 0) || 0,
  )
  const 写记 = new Map((写.memories || []).map((m) => [String(m.id), m]))
  const 合记 = new Map((盘.memories || []).map((m) => [String(m.id), m]))
  for (const [id, m] of 写记) {
    const 旧 = 合记.get(id)
    合记.set(id, !旧 || 更新时间(m) >= 更新时间(旧) ? m : 旧)
  }
  const 删们 = new Map((盘.deleted || []).map((m) => [String(m.id), m]))
  for (const m of 写.deleted || []) 删们.set(String(m.id), m)
  // 内存里仍有一条，不等于用户要求找回。只有同步找回入口显式列出的 id 能撤销删除。
  const 找回 = Array.isArray(选项?.restoreIds) ? 选项.restoreIds : []
  for (const value of 找回) {
    const id = String(value)
    if (写记.has(id)) 删们.delete(id)
  }
  const memories = [...合记.values()].filter((m) => !删们.has(String(m.id)))
  const 记录表 = new Map()
  const 键 = (t) => String(t && t.at) + '|' + String((t && t.query) || '').slice(0, 80)
  for (const t of 写.traces || []) 记录表.set(键(t), t)
  for (const t of 盘.traces || []) if (!记录表.has(键(t))) 记录表.set(键(t), t)
  const traces = [...记录表.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-100)
  return { version: 2, policy: 写.policy || 盘.policy, memories, traces, deleted: [...删们.values()] }
}
