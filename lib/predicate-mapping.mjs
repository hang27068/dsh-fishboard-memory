// predicate 映射裁判 —— 第四阶段 D3
//
// ⚠⚠ 为什么需要这一层（当前用户的规格，别退回旧的「无限追加别名」）：
//
//   真实模型会吐出 `user.prefer.communication_style`、`user.communication.style`、
//   `reply_style`、`dislike.reply_style` 这些同义不同形的 predicate。
//   最省事的做法是「看到哪个就把它加进别名表」——但那样别名表会无限膨胀，
//   而且每次加完只是把这一次的输出认下来，下一次模型再换一个写法又得加。
//   归到底：**别名表不该由模型输出驱动增长。**
//
//   正确做法（当前用户定的）：
//     ① 结构归一：纯字符串处理，先把大小写/分隔符/驼峰理平
//     ② 受控词表：落地必须是注册表里的 canonical
//     ③ 认不出来 → 问一次**映射裁判**，让它从已有 canonical 里挑
//        · map      → 必须是注册表里真实存在的 canonical
//        · reject   → 这条候选不写长期事实
//        · propose  → 只写进 proposals 审计队列，**不自动扩表、不写事实**
//     ④ 决不允许模型自己发明一个 canonical 就写进去
//
//   禁止项（当前用户逐个点名）：
//     · `contains('dislike')` 就直接映射
//     · 靠 value 里的单个关键词猜
//     · 让模型发明 canonical 并落库
//     · 每轮验收后机械追加别名
//     · 把认不出的 predicate 原样持久化
//     · 让别名影响历史 factId

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { 归到注册表, canonical们, predicate注册表, 结构归一 } from './predicate-registry.mjs'

/** 映射裁判的最低可信度门槛（当前用户定的 0.85） */
export const 映射最低置信 = 0.85

/** proposals 审计目录 */
export const 提议目录 = 'predicate-proposals'

export const 映射裁判系统提示 = [
  '你是「事实谓词归一裁判」，负责把一个模型抽取出的谓词归到受控词表里。',
  '',
  '你只会看到一个谓词（predicate）、它的值（value）、类别（category），',
  '以及一句精确证据原句。你要判断这个谓词**在语义上**对应下面哪一个 canonical。',
  '',
  '规则：',
  '1. 只允许从下面的 canonical 列表里选，**不许发明新名字**。',
  '2. 判断依靠谓词的**含义**，不要只看字面像不像。',
  '   特别注意：`dislike.xxx` 这类写法，字面带 dislike，但整条事实讲的可能是',
  '   「说话方式的偏好」，也可能是「不喜欢某个游戏」——必须看 value 和证据原句判断。',
  '3. 拿不准就 reject，不要硬凑。宁可少记，不要记错。',
  '4. 如果它确实是一条稳定、有独立含义、且**不能等价归到任何已有 canonical** 的事实，',
  '   选 propose，并在 canonical 里写你建议的新名字（但这不会自动生效，只进人工审核队列）。',
  '',
  '只输出 JSON，不要任何解释文字：',
  '{"decision":"map|reject|propose","canonical":"...","confidence":0.0,"reason":"..."}',
  '',
  'decision 含义：',
  '  map      归到某个已有 canonical（必须在列表里，confidence 要 ≥ 0.85）',
  '  reject   这条事实不该作为长期事实记录',
  '  propose  语义独立、且不能归到已有 canonical，建议新增（进审核队列，不落事实）',
].join('\n')

/** 造裁判输入：把可用 canonical 连同定义一起摊开，让模型只能在这个集合里挑 */
export function 造映射输入(参) {
  const 行 = []
  行.push('【待归一的谓词】')
  行.push('predicate: ' + String(参.predicate || ''))
  行.push('category: ' + String(参.category || ''))
  行.push('value: ' + String(参.value == null ? '' : 参.value).slice(0, 300))
  行.push('')
  行.push('【精确证据原句】')
  const 句们 = Array.isArray(参.原句们) ? 参.原句们 : []
  if (!句们.length) 行.push('（没有可用原句）')
  else for (const s of 句们.slice(0, 5)) 行.push('- ' + String(s).slice(0, 200))
  行.push('')
  行.push('【允许选择的 canonical 列表】')
  for (const c of canonical们) {
    const 项 = predicate注册表[c]
    行.push('- ' + c)
    行.push('    类别: ' + 项.category + '；基数: ' + 项.cardinality + '；适用主体: ' + 项.subjectTypes.join('/'))
    行.push('    说明: ' + (项.note || ''))
  }
  行.push('')
  行.push('现在给出 JSON。')
  return 行.join('\n')
}

/**
 * 解析映射裁判输出。
 *
 * ⚠ 严格：decision 必须是三个之一；map 的 canonical 必须**已经在注册表里**。
 *   模型如果吐出一个注册表里没有的 canonical，直接判为不合法 ——
 *   这正是「不许模型发明 canonical」那条规则的执行点。
 */
export function 解析映射输出(原文) {
  let t = String(原文 == null ? '' : 原文).trim()
  if (!t) return { ok: false, 说: '输出为空', 类型: 'empty' }

  // 去掉 ```json 围栏
  if (t.startsWith('```')) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (m) t = m[1].trim()
  }

  let o
  try {
    o = JSON.parse(t)
  } catch (e) {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try { o = JSON.parse(t.slice(a, b + 1)) } catch (e2) {
        return { ok: false, 说: '不是合法 JSON', 类型: 'json_syntax' }
      }
    } else {
      return { ok: false, 说: '不是合法 JSON', 类型: 'json_syntax' }
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, 说: '顶层不是对象', 类型: 'schema_invalid' }
  }

  const 决 = String(o.decision || '').trim()
  if (!['map', 'reject', 'propose'].includes(决)) {
    return { ok: false, 说: 'decision 不合法：' + 决, 类型: 'schema_invalid' }
  }

  const confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0))
  const canonical = String(o.canonical || '').trim()
  const reason = String(o.reason || '').trim()

  if (决 === 'map') {
    if (!canonical) return { ok: false, 说: 'map 但没给 canonical', 类型: 'schema_invalid' }
    // ⚠⚠ 这一条是硬红线：模型给的 canonical 必须在注册表里
    if (!predicate注册表[canonical]) {
      return {
        ok: false,
        说: '模型给的 canonical 不在受控词表里：' + canonical + '（禁止模型发明 canonical）',
        类型: 'canonical_not_registered',
      }
    }
    if (confidence < 映射最低置信) {
      return {
        ok: false,
        说: '置信度不足（' + confidence + ' < ' + 映射最低置信 + '）：' + canonical,
        类型: 'low_confidence',
      }
    }
  }

  return { ok: true, 结论: { decision: 决, canonical, confidence, reason } }
}

/**
 * 把一个认不出的 predicate 交给裁判定夺。
 *
 * @param {{候选: object, 事件们: Array, 消息证据?: Map|Array, 模型回调: Function}} 参
 * @returns {Promise<{ok:boolean, 结论?:object, 说?:string, 类型?:string}>}
 */
export async function 判未知predicate(参) {
  const 候选 = 参.候选 || {}
  const 模型 = 参.模型回调
  if (typeof 模型 !== 'function') {
    return { ok: false, 说: '没有映射裁判回调（群聊下 fail closed）', 类型: 'no_judge' }
  }

  const 输入 = 造映射输入({
    predicate: 候选.predicate,
    category: 候选.category,
    value: 候选.value,
    原句们: 候选.原句们 || [],
  })

  let 出
  try {
    出 = await 模型({ system: 映射裁判系统提示, user: 输入, 最多: 400, json模式: true, 类: 'predicate_map' })
  } catch (error) {
    return { ok: false, 说: '映射裁判调用抛错：' + ((error && error.message) || error), 类型: 'call_failed' }
  }
  if (!出 || !出.ok) {
    return { ok: false, 说: '映射裁判调用失败：' + String((出 && (出.message || 出.说)) || '未知'), 类型: 'call_failed' }
  }
  // ⚠⚠ 截断 / 中断 → 按调用失败处理，不采纳输出（即使它是合法 JSON）。
  //
  //   映射输出形如 {"decision":"map",...}，很短，截断点容易落在对象闭合之后。
  //   照收会让一个没说完的映射被当成确定结论。
  //
  //   ⚠ 不重试（本路径原本就没有重试）。
  const 映态 = String((出 && 出.finishKind) || '')
  if (映态 === 'max-tokens' || 映态 === 'aborted') {
    return {
      ok: false,
      说: '映射裁判输出' + (映态 === 'aborted' ? '被中断（aborted）' : '被截断（max-tokens）')
        + '，不采纳（输出 ' + String(出.text || '').length + ' 字）',
      类型: 映态 === 'aborted' ? 'aborted' : 'max_tokens',
    }
  }

  const 解 = 解析映射输出(出.text)
  if (!解.ok) return { ok: false, 说: '映射输出不合格（' + 解.类型 + '）：' + 解.说, 类型: 解.类型 }
  return { ok: true, 结论: 解.结论 }
}

/**
 * 把一条 propose 写进审核队列（**不写事实、不自动扩表**）。
 *
 * 幂等：同一个 predicate 反复 propose 只留一条（用结构归一形做键）。
 *
 * @param {{根:string, session:string, predicate:string, 结构形:string, category:string,
 *          value:any, subject:string, subjectId:string, 原句们:string[], reason:string,
 *          confidence:number, provider?:string, model?:string, 现在?:string, 写?:Function}} 参
 */
export function 落提议(参) {
  const 结构形 = String(参.结构形 || 结构归一(参.predicate) || '').trim()
  if (!结构形) return { ok: true, 新增: 0, 已有: 0, 说: '没有可用的结构形，跳过' }

  const 目录 = join(参.根 || '', 提议目录)
  const 路 = join(目录, 'proposals.jsonl')

  let 已有 = new Set()
  try {
    if (existsSync(路)) {
      for (const 行 of readFileSync(路, 'utf8').split('\n')) {
        if (!行.trim()) continue
        try { const o = JSON.parse(行); if (o && o.结构形) 已有.add(String(o.结构形)) } catch (e) {}
      }
    }
  } catch (e) {}

  if (已有.has(结构形)) return { ok: true, 新增: 0, 已有: 1, 说: '' }

  const 记录 = {
    结构形,
    原始predicate: String(参.predicate || ''),
    category: String(参.category || ''),
    subject: String(参.subject || ''),
    subjectId: String(参.subjectId || ''),
    value摘要: String(参.value == null ? '' : 参.value).slice(0, 160),
    原句们: (参.原句们 || []).slice(0, 3).map((s) => String(s).slice(0, 200)),
    裁判理由: String(参.reason || ''),
    confidence: Number(参.confidence) || 0,
    session: String(参.session || ''),
    provider: String(参.provider || ''),
    model: String(参.model || ''),
    createdAt: String(参.现在 || ''),
  }

  try {
    if (typeof 参.写 === 'function') {
      参.写(路, JSON.stringify(记录) + '\n')
    } else {
      mkdirSync(目录, { recursive: true })
      appendFileSync(路, JSON.stringify(记录) + '\n', 'utf8')
    }
  } catch (error) {
    return { ok: false, 新增: 0, 已有: 0, 说: '提议写失败：' + String((error && error.message) || error) }
  }
  return { ok: true, 新增: 1, 已有: 0, 说: '' }
}

