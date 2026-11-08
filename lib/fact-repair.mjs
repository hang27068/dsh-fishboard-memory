// 证据修复 —— D3 后半段
//
// ⚠⚠ 为什么需要这一层（把当前用户的原话和踩过的坑都记在这）：
//
//   群聊里「一条事实被哪几条消息支撑」必须由模型指定，不能让程序猜。
//   但真实模型在 temperature=0 下也会**漏这个字段**：
//   2026-11-05 影子复验实测，12 个候选里 1 个漏了 evidenceMessageIds ——
//   JSON 完全合法、finish_reason=stop、别的字段都对，就是少了它。
//
//   原来的处理是「缺证据 → 拒这条候选」，本身没错；但当时**一批里所有候选都被拒
//   就等于整轮失败、水位不动**，于是这个漏字段的候选每轮都堵住整条流水线，
//   永远过不去。当前用户当场指出这是设计问题：
//
//     「不能接受这条事实」≠「无法确认这批事件已经处理过」
//
//   所以分两件事做：
//     1. 单条候选不合格 → 只拒那条，批次照常结束（terminal_rejected）
//     2. 缺证据这件事**值得再问一次模型** → 定向修复，最多一次
//
//   修复的红线（当前用户点名的）：
//     · 不接受原候选（原候选的空证据不许当通过）
//     · **不许在本地按 value 搜正文自动补证据** —— 那是程序替模型编证据
//     · 只能从**所引事件里的 inbound 消息**中选，不能生成新 ID
//     · 修复结果仍须走完整结构与主体校验（不是修复完就直接信）
//     · temperature=0，最多一次，不循环
//     · 修复调用本身失败（超时/坏 JSON）→ 整批系统失败，水位不动
//     · 修复明确 reject / 给空证据 / 给无关证据 → 只拒该候选，不堵批次

/** 证据修复的系统提示 */
export const 证据修复系统提示 = [
  '你在补齐一条记忆候选事实的证据。',
  '',
  '你会收到：',
  '· 若干条候选事实（每条有下标 candidateIndex、predicate、value、category）',
  '· 这些候选所引用的事件里，**对方（inbound）说过的消息**，每条带 id / speakerId / speakerName / 时间 / 原文',
  '',
  '你的任务：为每条候选挑出**真正支撑它**的消息 id。',
  '',
  '硬性要求：',
  '1. 只能从给你的消息里选 id，**不许编造 id**，不许改写 id。',
  '2. 证据必须是**候选所属那个人自己说的话**（speakerId 要和候选的 subjectId 一致）。',
  '3. 挑不出真正支撑的消息，就把 decision 写成 reject，不要硬凑。',
  '4. 一条候选可以有多条证据，但每条都必须真的支撑它。',
  '5. 不要根据 predicate / value 的字面去猜，要看消息原文的意思。',
  '',
  '只输出一个 JSON 对象，不要 Markdown、不要代码块、不要解释文字：',
  '{"repairs":[{"candidateIndex":0,"evidenceMessageIds":["..."],"decision":"repaired","reason":"..."}]}',
  '',
  'decision 只能是 "repaired" 或 "reject"。',
  'repaired 时 evidenceMessageIds 必须非空；reject 时 evidenceMessageIds 给空数组。',
].join('\n')

/**
 * 造修复请求的输入文本。
 *
 * ⚠ 只放**该事件里的 inbound 消息**：
 *   出站（助手自己说的）和 fish 角色的消息都不能当作用户事实的证据。
 *   这个过滤在请求阶段就做掉，不指望模型自己排除。
 *
 * @param {Array} 候选们 [{index, subject, subjectId, predicate, value, category, eventIds}]
 * @param {Map} 消息证据 eventId → [消息]
 * @param {Array} 事件们 本批事件
 * @returns {string}
 */
export function 造证据修复输入(候选们, 消息证据, 事件们) {
  const 允事件 = new Set((事件们 || []).map((e) => String((e && e.eventId) || '')))
  const 候选段 = []
  for (const c of 候选们) {
    候选段.push([
      '[候选 ' + c.index + ']',
      'subject: ' + String(c.subject || ''),
      'subjectId: ' + String(c.subjectId || ''),
      'predicate: ' + String(c.predicate || ''),
      'value: ' + String(c.value || ''),
      'category: ' + String(c.category || ''),
      '引用事件: ' + (c.eventIds || []).join(', '),
    ].join('\n'))
  }

  // 收集候选所引事件里的 inbound 消息（去重、保序）
  const 见过 = new Set()
  const 消息段 = []
  for (const c of 候选们) {
    for (const evId of (c.eventIds || [])) {
      if (!允事件.has(String(evId))) continue
      const 组 = 消息证据 instanceof Map ? (消息证据.get(String(evId)) || []) : []
      for (const m of (Array.isArray(组) ? 组 : [])) {
        const id = String((m && m.id) || '')
        if (!id || 见过.has(id)) continue
        // 只要 inbound（别人说的）。出站/助手自己的话不能当用户事实的证据。
        if (String((m && m.direction) || '') !== 'inbound') continue
        见过.add(id)
        消息段.push([
          '[消息 ' + id + ']',
          'speakerId: ' + String((m && m.speakerId) || ''),
          'speakerName: ' + String((m && m.speakerName) || ''),
          '时间: ' + String((m && m.at) || ''),
          '原文: ' + String((m && m.text) || ''),
        ].join('\n'))
      }
    }
  }

  return ['# 候选事实', '', 候选段.join('\n\n'), '', '# 可选消息（只能从这些里面挑 id）', '',
    消息段.join('\n\n')].join('\n')
}

/**
 * 解析修复输出。
 *
 * @returns {{ ok: true, 修复们: Array } | { ok: false, 说: string, 类型: string }}
 */
export function 解析证据修复(原文, 候选们) {
  const 文 = String(原文 == null ? '' : 原文).trim()
  if (!文) return { ok: false, 说: '修复模型没输出内容', 类型: 'json_syntax' }

  let 净 = 文
  const 围 = 净.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (围) 净 = 围[1].trim()

  let 对 = null
  try {
    对 = JSON.parse(净)
  } catch (error) {
    const a = 净.indexOf('{')
    const b = 净.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try { 对 = JSON.parse(净.slice(a, b + 1)) } catch (e) { 对 = null }
    }
  }
  if (!对 || typeof 对 !== 'object' || Array.isArray(对)) {
    return { ok: false, 说: '修复输出不是合法 JSON 对象', 类型: 'json_syntax' }
  }
  if (!Array.isArray(对.repairs)) {
    return { ok: false, 说: '修复输出没有 repairs 数组', 类型: 'schema_invalid' }
  }

  const 合序 = new Set(候选们.map((c) => Number(c.index)))
  const 修复们 = []
  for (let i = 0; i < 对.repairs.length; i++) {
    const r = 对.repairs[i]
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const idx = Number(r.candidateIndex)
    if (!合序.has(idx)) continue          // 不认识的候选下标，忽略
    const 决 = String(r.decision || '').trim()
    if (决 !== 'repaired' && 决 !== 'reject') {
      // 非法 decision → 这条按 reject 处理（保守），但不让整批失败
      修复们.push({ candidateIndex: idx, decision: 'reject', evidenceMessageIds: [], reason: 'decision 非法：' + 决 })
      continue
    }
    const ids = Array.isArray(r.evidenceMessageIds)
      ? [...new Set(r.evidenceMessageIds.map((x) => String(x == null ? '' : x)).filter(Boolean))]
      : []
    if (决 === 'repaired' && !ids.length) {
      // 说 repaired 却没给证据 → 等同 reject，不能让空证据混过去
      修复们.push({ candidateIndex: idx, decision: 'reject', evidenceMessageIds: [], reason: '声称 repaired 但没给证据' })
      continue
    }
    修复们.push({
      candidateIndex: idx,
      decision: 决,
      evidenceMessageIds: 决 === 'reject' ? [] : ids,
      reason: String(r.reason || ''),
    })
  }
  return { ok: true, 修复们 }
}
