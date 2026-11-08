// 拒绝审计 —— D3
//
// ⚠⚠ 这一层存在的唯一理由：`terminal_rejected` 不能是「悄悄吞掉」。
//
//   当前用户的原话：
//     「terminal_rejected 不是悄悄吞掉，必须写入独立审计记录」
//     「若拒绝审计写入失败，也视为整轮失败，水位不动，避免坏候选无痕消失」
//
//   所以这个模块有两个职责：
//     1. 造一条**稳定**的 rejectionId（同样的坏候选重跑不能刷出一串重复记录）
//     2. 幂等地追加到 fact-rejections/<session>.jsonl
//
//   rejectionId 怎么算才稳定：
//     把「这条拒绝是关于什么的」拼起来再哈希 ——
//     session + eventIds + batchIndex + candidateIndex + predicate + value 摘要
//     ⚠ 不含时间、不含模型 provider/model（换模型重跑同一个坏候选，仍是同一条记录）
//     ⚠ 不含 reason 措辞（改个说法不该产生新记录）

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** 拒绝审计的目录名（和 events / facts / fact-conflicts 平级） */
export const 拒绝审计目录 = 'fact-rejections'

/**
 * 造稳定的 rejectionId。
 *
 * @param {{session, eventIds: string[], batchIndex: number, candidateIndex: number,
 *          predicate: string, valueDigest: string}} 参
 */
export function 造拒绝ID(参) {
  const 组 = [
    String(参.session || ''),
    [...(参.eventIds || [])].map(String).sort().join(','),
    String(参.batchIndex == null ? '' : 参.batchIndex),
    String(参.candidateIndex == null ? '' : 参.candidateIndex),
    String(参.predicate || ''),
    String(参.valueDigest || ''),
  ]
  return 'rej-' + createHash('sha256').update(组.join('\u0000')).digest('hex').slice(0, 32)
}

/** 值摘要：只取前 120 字符再哈希，避免整段正文进 id */
export function 值摘要(value) {
  return createHash('sha256')
    .update(String(value == null ? '' : value).slice(0, 120))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 把一批拒绝记录幂等地落盘。
 *
 * ⚠ 幂等靠 rejectionId：文件里已有的 id 不再写第二遍。
 *   这样「同一个毒候选重跑多轮」只在审计里留一条，
 *   但 occurrenceCount 式的重复计数不在这里做 —— 审计只关心「被拒过什么」。
 *
 * @param {{根: string, session: string, 拒绝们: Array, 写?: Function}} 参
 *   写 可以注入（测试用）；不给就用 appendFileSync
 * @returns {{ ok: boolean, 新增: number, 已存在: number, 说: string }}
 */
export function 落拒绝审计(参) {
  const { session, 拒绝们 } = 参
  const 根 = 参.根
  const 写 = typeof 参.写 === 'function' ? 参.写 : null
  const 记们 = Array.isArray(拒绝们) ? 拒绝们 : []

  if (!记们.length) return { ok: true, 新增: 0, 已存在: 0, 说: '' }
  if (!根) return { ok: false, 新增: 0, 已存在: 0, 说: '拒绝审计缺目录' }

  const 目录 = join(根, 拒绝审计目录)
  const 路 = join(目录, String(session || 'unknown') + '.jsonl')

  // 读已有 id，做幂等
  const 已有 = new Set()
  try {
    if (existsSync(路)) {
      for (const 行 of readFileSync(路, 'utf8').split('\n')) {
        if (!行.trim()) continue
        try {
          const o = JSON.parse(行)
          if (o && o.rejectionId) 已有.add(String(o.rejectionId))
        } catch (e) { /* 坏行忽略，不阻断 */ }
      }
    }
  } catch (error) {
    // 读不出来就当空的处理 —— 但下面写失败会让整轮失败，不会无痕
  }

  let 新增 = 0
  let 重复 = 0
  const 待写 = []
  for (const r of 记们) {
    const id = String(r.rejectionId || '')
    if (!id) continue
    if (已有.has(id)) { 重复++; continue }
    已有.add(id)
    待写.push(r)
    新增++
  }
  if (!待写.length) return { ok: true, 新增: 0, 已存在: 重复, 说: '' }

  const 文 = 待写.map((r) => JSON.stringify(r)).join('\n') + '\n'
  try {
    if (写) {
      写(路, 文)
    } else {
      mkdirSync(目录, { recursive: true })
      appendFileSync(路, 文, 'utf8')
    }
  } catch (error) {
    return {
      ok: false, 新增: 0, 已存在: 重复,
      说: '拒绝审计写失败：' + String((error && error.message) || error),
    }
  }
  return { ok: true, 新增, 已存在: 重复, 说: '' }
}

/**
 * 把 跑一轮 里攒的「拒绝审计素材」补全成完整审计记录。
 *
 * @param {Array} 素材们 跑一轮 返回的 拒绝审计们
 * @param {{session, 现在, provider, model, promptHash}} 上下
 */
export function 补全拒绝记录(素材们, 上下) {
  const 出 = []
  for (const m of Array.isArray(素材们) ? 素材们 : []) {
    const 摘 = m.候选摘要 || {}
    const valueDigest = 值摘要(摘.value)
    const id = 造拒绝ID({
      session: 上下.session,
      eventIds: m.事件ids || [],
      batchIndex: m.批序,
      candidateIndex: m.候选序号,
      predicate: 摘.predicate,
      valueDigest,
    })
    出.push({
      rejectionId: id,
      session: String(上下.session || ''),
      事件ids: (m.事件ids || []).map(String),
      批序: m.批序,
      候选序号: m.候选序号,
      subject: String(摘.subject || ''),
      subjectId: String(摘.subjectId || ''),
      predicate: String(摘.predicate || ''),
      value摘要: String(摘.value || '').slice(0, 120),
      category: String(摘.category || ''),
      拒绝码: String(m.码 || ''),
      原因: String(m.说 || ''),
      原始证据ID: Array.isArray(摘.evidenceMessageIds) ? 摘.evidenceMessageIds.map(String) : [],
      尝试修复: Boolean(m.码 === 'evidence_missing_repairable' || m.尝试修复),
      修复结论: String(m.修复结论 || ''),
      provider: String(上下.provider || ''),
      model: String(上下.model || ''),
      promptHash: String(上下.promptHash || ''),
      createdAt: String(上下.现在 || ''),
    })
  }
  return 出
}
