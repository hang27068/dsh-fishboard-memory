// 私聊严格路径「只观察模式」（B3B shadow）
//
// 目的：让 B3B 私聊严格路径能在一小撮白名单会话上**先跑一遍看看**，
//       但**绝不碰**正式记忆。为将来真实灰度拿数据。
//
// ══════════════════════════════════════════════════════════════
// 当前用户定的硬边界（本模块逐条落实，别改）
// ══════════════════════════════════════════════════════════════
//
//   1. 默认关闭，只认明确的 enabled === true（字符串 "true" 不算）
//   2. 必须有私聊 session 白名单；不在名单里的会话不跑
//   3. legacy 私聊事件 / 事实写入 / 召回行为**逐字节不变**
//   4. 观察失败 / 截断 / 中断 → 只记观察失败，不影响 legacy、
//      不碰正式水位、不影响用户聊天
//   5. 不写正式 facts / fact-state / rejections / conflicts —— 
//      观察数据走独立的 shadow facts / shadow state / audit 目录
//
// ⚠⚠ 本模块**不是**生产跑法。跑一轮 只读事件卡（只读，不写），
//    全程不发生任何正式写入。启不启用由配置决定，默认 false。

import { mkdirSync, readFileSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')

/** shadow 全部数据的根 —— 与正式 fish-memory-v2 完全分离 */
const SHADOW_ROOT = join(CFG_DIR, 'fish-memory-v2', 'shadow', 'private-strict')

const SHADOW_FACTS = join(SHADOW_ROOT, 'facts')
const SHADOW_STATE = join(SHADOW_ROOT, 'state')
const SHADOW_AUDIT = join(SHADOW_ROOT, 'audit')
/**
 * 拒绝审计根。
 *
 * ⚠⚠ 2026-11-07 修复：`落盘一轮` 的契约是「拒绝审计写不成 → 整轮失败、水位不动」，
 *   目的是「避免坏候选无痕消失」。但跑观察一次一开始**没传 拒绝根/写拒绝**，
 *   于是任何被语义裁判拒掉的候选都会让 落盘一轮 返回 状态写了:false，
 *   水位永远是 {}，下一轮把同一批事件重新处理一遍 —— 观察模式基本跑不动。
 *
 *   这里给 shadow 一个自己的拒绝根，接在 SHADOW_ROOT/rejections 下，
 *   和正式 fact-rejections 完全隔离。
 */
const SHADOW_REJECT_ROOT = SHADOW_ROOT

/**
 * 专用模型配置（**故意不读 fish-memory-config.json 的 llmModel**）。
 *
 * 理由（当前用户的二·1）：llmModel 同时控制插件内九个功能，
 * 拿它来跑观察等于把观察行为和聊天行为绑在一根绳上 ——
 * 哪天有人为了别的功能调它，观察数据就跟着漂了。
 *
 * 配置文件：<DSH_HOME>/fish-memory-config.json 里的
 *   privateStrictShadow: { enabled, sessions, model: { provider, model } }
 *
 * ⚠ 缺失 / 模型未注册 / 不可用时**只报告状态**，绝不回退到
 *   聊天模型、全局模型或当前的 -1017（当前用户的二·3）。
 */
/**
 * ⚠⚠ 同一 session 同时只许跑一次（当前用户的三·3）。
 *
 * 不锁的后果很具体：两次跑并发跑完，后写的把先写的 shadow facts / state
 * 整个盖掉 —— 审计里看着像「只跑了一次」，另一次的模型调用钱白花了，
 * 而且两条结果的差异永远消失。
 *
 * 锁在**模块级**，不是闭包级：index.js 只有一个实例，但测试也会并发调，
 * 模块级能一视同仁地挡住。
 */
const 正在跑 = new Set()

/** 现在有哪些 session 在跑（状态接口 / 测试用） */
export function 正在跑的会话() {
  return [...正在跑]
}

const 默认配置 = Object.freeze({
  enabled: false,          // ⚠ 默认关闭，只认 === true
  sessions: [],            // 私聊白名单
  model: null,             // { provider, model } —— 必须显式给
})

/**
 * ⚠⚠ 会话身份 = **原始字符串，逐字节精确比较**。
 *
 * 上一版这里犯过一个身份碰撞的错：先 `replace(/[^A-Za-z0-9_-]/g,'')` 消毒
 * 再拿去比对白名单，于是
 *
 *     'sess-1'          → 'sess-1'
 *     'sess 1'          → 'sess1'     ← 空格被删
 *     'sess/1'          → 'sess1'     ← 斜杠被删，与上一行撞成同一个
 *
 * 两个不同的原始 session 拿到同一套 shadow 文件，还能互相授权。
 * 消毒只该用来生成**文件名**，绝不能参与**授权判断**。
 *
 * 现在的分工：
 *   · 授权 → 原始 session 与白名单做 `===` 精确比较（见 该跑观察）
 *   · 路径 → 原始 session 走 SHA-256 稳定哈希，绝不做「删字符」式消毒
 */
function 原始会话(session) {
  return String(session == null ? '' : session)
}

/**
 * 生成 shadow 文件用的目录名。
 *
 * ⚠ 用**稳定哈希**而不是消毒：哈希对所有不同输入都不同（碰撞概率可忽略），
 *   所以两个不同的原始 session 一定落到不同文件，不存在「删字符后撞车」。
 *   取 SHA-256 前 32 个 hex，够用且短。
 *
 * 空字符串返回空 —— 调用方据此判「算不出路径」。
 */
function 会话路径键(session) {
  const 原 = 原始会话(session)
  if (!原) return ''
  return createHash('sha256').update(原, 'utf8').digest('hex').slice(0, 32)
}

// ── 配置 ─────────────────────────────────────────────

function 读配置文本(路径) {
  const 字节 = readFileSync(路径)
  if (字节.length >= 2 && 字节[0] === 0xFF && 字节[1] === 0xFE) return 字节.subarray(2).toString('utf16le')
  if (字节.length >= 2 && 字节[0] === 0xFE && 字节[1] === 0xFF) {
    const 换 = Buffer.from(字节.subarray(2))
    for (let i = 0; i + 1 < 换.length; i += 2) { const t = 换[i]; 换[i] = 换[i + 1]; 换[i + 1] = t }
    return 换.toString('utf16le')
  }
  let 文 = 字节.toString('utf8')
  if (文.charCodeAt(0) === 0xFEFF) 文 = 文.slice(1)
  return 文
}

/**
 * 读观察模式配置。只取 `privateStrictShadow` 这一段。
 *
 * ⚠ 配置坏了 → 当作**关闭**，不是当作开启。fail closed。
 */
export function 读观察配置(配置路径 = null) {
  const p = 配置路径 || join(CFG_DIR, 'fish-memory-config.json')
  if (!existsSync(p)) return { ...默认配置, 配置来源: p, 配置状态: '配置文件不存在' }
  let raw = null
  try {
    raw = JSON.parse(读配置文本(p))
  } catch (error) {
    return { ...默认配置, 配置来源: p, 配置状态: '配置文件读不了：' + String((error && error.message) || error) }
  }
  const 段 = raw && typeof raw === 'object' ? raw.privateStrictShadow : null
  if (!段 || typeof 段 !== 'object') {
    return { ...默认配置, 配置来源: p, 配置状态: '没有 privateStrictShadow 段' }
  }

  // ⚠⚠ 只认严格布尔 true。字符串 "true" / 1 一律当关闭 ——
  //   这个开关一旦误开就会产生模型调用，宁可开不起来也不能悄悄开。
  const enabled = 段.enabled === true

  // ⚠⚠ 白名单：**原始字符串原样收**，一个字符都不删。
  //   非法项直接拒绝并记下来，绝不「消毒后意外授权另一个会话」。
  const 名单 = []
  const 拒收名单 = []
  if (段.sessions !== undefined && !Array.isArray(段.sessions)) {
    拒收名单.push({ 值: String(段.sessions), 原因: 'sessions 不是数组' })
  }
  if (Array.isArray(段.sessions)) {
    for (const s of 段.sessions) {
      if (typeof s !== 'string') {
        拒收名单.push({ 值: String(s), 原因: '不是字符串（' + (typeof s) + '）' })
        continue
      }
      const 原 = 原始会话(s)
      if (!原) {
        拒收名单.push({ 值: '', 原因: '空字符串' })
        continue
      }
      // ⚠ 只挡真正的路径分隔与上跳，不做「删字符」式消毒 ——
      //   删字符会改变身份，正是上一版碰撞的根源。
      if (原.includes('/') || 原.includes('\\') || 原.includes('\0') || 原 === '.' || 原 === '..') {
        拒收名单.push({ 值: 原, 原因: '含路径分隔符或上跳，可能路径穿越' })
        continue
      }
      if (!名单.includes(原)) 名单.push(原)
    }
  }

  let model = null
  if (段.model && typeof 段.model === 'object') {
    const provider = String(段.model.provider || '').trim()
    const m = String(段.model.model || '').trim()
    if (provider && m) model = { provider, model: m }
  }

  return {
    enabled,
    sessions: 名单,
    拒收名单,
    白名单原样: Array.isArray(段.sessions) ? 段.sessions.map((x) => String(x)) : [],
    model,
    配置来源: p,
    配置状态: 'ok',
  }
}

// ── shadow 状态 ───────────────────────────────────────

function shadow状态路径(session) {
  const 键 = 会话路径键(session)
  return 键 ? join(SHADOW_STATE, 键 + '.json') : ''
}

function shadow事实路径(session) {
  const 键 = 会话路径键(session)
  return 键 ? join(SHADOW_FACTS, 键 + '.jsonl') : ''
}

function shadow审计路径(session) {
  const 键 = 会话路径键(session)
  return 键 ? join(SHADOW_AUDIT, 键 + '.jsonl') : ''
}

function 原子写(路径, 文本) {
  const 临时 = 路径 + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try { mkdirSync(join(路径, '..'), { recursive: true }) } catch (error) { /* 已存在 */ }
  try {
    writeFileSync(临时, 文本, 'utf8')
    renameSync(临时, 路径)
    return { ok: true, error: '' }
  } catch (error) {
    try { writeFileSync(临时, '') } catch (e) { /* 算了 */ }
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** shadow 的会话状态（**独立于正式 fact-state**） */
export function 读shadow状态(session) {
  const 空 = { schemaVersion: 1, session: String(session || ''), 文件水位: {}, 连败: 0, 最后成功: '', 最后尝试: '', 最后诊断: '' }
  const p = shadow状态路径(session)
  if (!p || !existsSync(p)) return 空
  try {
    const o = JSON.parse(readFileSync(p, 'utf8'))
    if (!o || typeof o !== 'object') return 空
    const 水位 = {}
    const 源 = o.文件水位 && typeof o.文件水位 === 'object' ? o.文件水位 : {}
    for (const [k, v] of Object.entries(源)) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) 水位[k] = Math.floor(n)
    }
    return { ...空, ...o, 文件水位: 水位, session: 空.session }
  } catch (error) {
    return { ...空, 最后诊断: 'shadow 状态读不了：' + String((error && error.message) || error) }
  }
}

/** 写 shadow 状态 */
export function 写shadow状态(session, 状态) {
  const p = shadow状态路径(session)
  if (!p) return { ok: false, error: '会话 id 不合法' }
  const 净 = { ...读shadow状态(session), ...(状态 || {}), schemaVersion: 1, session: String(session || '') }
  return 原子写(p, JSON.stringify(净, null, 2) + '\n')
}

/** 读 shadow 事实（独立于正式 facts） */
export function 读shadow事实(session) {
  const p = shadow事实路径(session)
  if (!p || !existsSync(p)) return []
  let 原 = ''
  try { 原 = readFileSync(p, 'utf8') } catch (error) { return [] }
  const 顺序 = []
  const 表 = new Map()
  for (const 行 of 原.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    let o = null
    try { o = JSON.parse(s) } catch (error) { continue }
    if (!o || typeof o !== 'object' || !o.factId) continue
    const id = String(o.factId)
    if (!表.has(id)) 顺序.push(id)
    表.set(id, o)
  }
  return 顺序.map((id) => 表.get(id))
}

/** 写 shadow 事实（幂等：内容一样不重复追加） */
export function 写shadow事实(session, 事实) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  if (!事实 || typeof 事实 !== 'object') return 失败('事实不是对象')
  if (!事实.factId) return 失败('事实没有 factId')
  const p = shadow事实路径(session)
  if (!p) return 失败('算不出 shadow 事实路径')

  let 现有 = ''
  try { 现有 = existsSync(p) ? readFileSync(p, 'utf8') : '' } catch (error) { return 失败('读 shadow 失败：' + error.message) }

  const 当前 = (() => {
    const 表 = new Map()
    for (const 行 of 现有.split('\n')) {
      const s = 行.trim()
      if (!s) continue
      try { const o = JSON.parse(s); if (o && o.factId) 表.set(String(o.factId), o) } catch (error) { /* 坏行 */ }
    }
    return 表.get(String(事实.factId)) || null
  })()

  let 新文本 = ''
  try { 新文本 = JSON.stringify(事实) } catch (error) { return 失败('序列化失败：' + error.message) }

  if (当前) {
    let 旧文本 = ''
    try { 旧文本 = JSON.stringify(当前) } catch (error) { 旧文本 = '' }
    if (旧文本 && 旧文本 === 新文本) return { ok: true, written: false, duplicate: true, error: '' }
  }

  try { mkdirSync(join(p, '..'), { recursive: true }) } catch (error) { /* 已存在 */ }
  const 分隔 = 现有 && !现有.endsWith('\n') ? '\n' : ''
  const r = 原子写(p, 现有 + 分隔 + 新文本 + '\n')
  if (!r.ok) return 失败('写 shadow 事实失败：' + r.error)
  return { ok: true, written: true, duplicate: false, error: '' }
}

/** 写 shadow 冲突（正式路径的 conflicts 也一律不碰） */
export function 写shadow冲突(session, 冲突) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  if (!冲突 || typeof 冲突 !== 'object' || !冲突.conflictId) return 失败('冲突记录不合格')
  const p = shadow事实路径(session).replace(/\.jsonl$/, '.conflicts.jsonl')
  if (!p) return 失败('算不出 shadow 冲突路径')
  let 旧 = ''
  try { 旧 = existsSync(p) ? readFileSync(p, 'utf8') : '' } catch (error) { return 失败('读 shadow 冲突失败：' + error.message) }
  // 幂等
  for (const 行 of 旧.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && String(o.conflictId) === String(冲突.conflictId)) return { ok: true, written: false, duplicate: true, error: '' } } catch (error) { /* 坏行 */ }
  }
  let 文本 = ''
  try { 文本 = JSON.stringify(冲突) } catch (error) { return 失败('序列化失败：' + error.message) }
  const 分隔 = 旧 && !旧.endsWith('\n') ? '\n' : ''
  const r = 原子写(p, 旧 + 分隔 + 文本 + '\n')
  if (!r.ok) return 失败('写 shadow 冲突失败：' + r.error)
  return { ok: true, written: true, duplicate: false, error: '' }
}

/** 读 shadow 审计 —— 给状态接口和测试用 */
export function 读shadow审计(session) {
  const p = shadow审计路径(session)
  if (!p || !existsSync(p)) return []
  let 原 = ''
  try { 原 = readFileSync(p, 'utf8') } catch (error) { return [] }
  const 出 = []
  for (const 行 of 原.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && typeof o === 'object') 出.push(o) } catch (error) { /* 坏行 */ }
  }
  return 出
}

/**
 * 落一条审计。
 *
 * ⚠⚠⚠ 这里是**真正的 append-only**（当前用户的最终要求）。
 *
 * 演进了三版，前两版都不对：
 *
 *   第 1 版：按 轮次键 覆盖      → 先失败后成功只留成功那次，过程全丢
 *   第 2 版：按 结果签名 去重     → 连续两次相同的失败/成功会被吞成一条
 *   第 3 版（现在）：**每次都追加**，签名只做标记，不做门禁
 *
 * 规则：
 *   · **每次手动触发都追加一行**，无论 轮次键 和结果是否相同
 *   · `结果指纹` 只用来标记 `duplicateResult`（这轮结果和上一轮一样），
 *     **绝不阻止记录**
 *   · 每条有唯一 `attemptId`（时间戳+序号+随机）和**全局递增** `attemptNumber`
 *   · `轮次键` 只用来把同一水位的多次尝试分组
 *   · shadow facts 的事实级幂等**不在这里**，由 写shadow事实 按 factId 保证
 */
export function 写shadow审计(会话, 记录) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  if (!记录 || typeof 记录 !== 'object') return 失败('审计记录不是对象')
  const p = shadow审计路径(会话)
  if (!p) return 失败('算不出审计路径')
  const 键 = String(记录.轮次键 || '')
  if (!键) return 失败('审计记录没有 轮次键（分组靠它）')

  const 现有 = 读shadow审计(会话)

  // attemptNumber：整份审计里单调递增，跨轮次也不重置
  const 上号 = 现有.reduce((a, x) => Math.max(a, Number(x.attemptNumber) || 0), 0)
  const attemptNumber = 上号 + 1

  // 同轮次内序号（第几次尝试这个水位）
  const 轮内数 = 现有.filter((x) => String(x.轮次键 || '') === 键).length + 1

  // attemptId：唯一。时间 + 全局序号 + 随机，够区分且可排序
  const attemptId = 'att-' + Date.now().toString(36) + '-' + attemptNumber
    + '-' + Math.random().toString(36).slice(2, 8)

  // 结果指纹只做标记：和**本会话上一次**结果一样 → duplicateResult=true
  const 上一条 = 现有.length ? 现有[现有.length - 1] : null
  const duplicateResult = !!(
    上一条
    && String(上一条.轮次键 || '') === 键
    && String(上一条.尝试签名 || '') === String(记录.尝试签名 || '')
    && String(记录.尝试签名 || '') !== ''
  )

  const 归一 = {
    ...记录,
    attemptId,
    attemptNumber,
    轮内序号: 轮内数,
    duplicateResult,
    // 兼容老字段名（早先的测试和报告用 尝试序号）
    尝试序号: attemptNumber,
  }

  let 追加 = ''
  try { 追加 = JSON.stringify(归一) } catch (error) { return 失败('序列化失败：' + error.message) }
  const 原文 = 现有.map((x) => JSON.stringify(x)).join('\n')
  const 文本 = (原文 ? 原文 + '\n' : '') + 追加 + '\n'
  const r = 原子写(p, 文本)
  if (!r.ok) return 失败('写审计失败：' + r.error)
  return {
    ok: true,
    written: true,
    // ⚠ duplicate 只表示「结果和上次一样」，**记录仍然写了**
    duplicate: duplicateResult,
    attemptId,
    attemptNumber,
    error: '',
  }
}

/**
 * 数一下「结果重复」的尝试有多少条（状态接口用）。
 *
 * ⚠ 只统计，不删记录 —— 重复的尝试照样是真实发生过的触发。
 */
export function 统计重复结果(会话) {
  const 全部 = 读shadow审计(会话)
  const 组 = new Map()
  let 重复 = 0
  for (const x of 全部) {
    const k = String(x.轮次键 || '') + '\u0000' + String(x.尝试签名 || '')
    if (组.has(k)) 重复++
    else 组.set(k, true)
  }
  return 重复
}

// ── 模型解析（不回退！）────────────────────────────────

/**
 * 解析观察专用模型。
 *
 * ⚠⚠ 这是硬要求（当前用户的二·3）：配置缺失 / 模型没给 / 不可用，
 *    **只报告状态，绝不回退**到聊天模型、全局模型或 -1017。
 *
 * 所以这里**不读 llmModel**，也不接受任何「默认值」。
 * 调用方拿到 ok:false 就必须停，不许自己找个模型顶上。
 */
export function 解析观察模型(配置) {
  if (!配置 || !配置.model) {
    return {
      ok: false,
      说: '观察专用模型未配置（privateStrictShadow.model 缺失）—— 不回退，本次不跑',
      模型: null,
    }
  }
  const { provider, model } = 配置.model
  if (!provider || !model) {
    return { ok: false, 说: '观察专用模型配置不完整（provider / model 必填）—— 不回退，本次不跑', 模型: null }
  }
  // ⚠ 显式挡住 -1017：当前用户说本轮不要用它（那个返回 Markdown 散文，不适合判定）
  if (String(model).includes('-1017')) {
    return {
      ok: false,
      说: '观察专用模型被配成了 -1017，这与「单独设计、不跟着全局漂」的意图冲突'
        + '（且 -1017 返回散文式输出）—— 不回退，本次不跑',
      模型: { provider, model },
    }
  }
  return { ok: true, 说: '', 模型: { provider, model } }
}

/**
 * ⭐⭐ 用 DSH 真实注册表做**精确**校验（当前用户的二·1）。
 *
 * ⚠ 刻意写成工厂 + 异步：注册表查询本身是 async 的，
 *   而 解析观察模型 / 该跑观察 是同步纯函数 —— 两者不能混。
 *   index.js 接线时先 await 这个工厂拿到一个同步的 `查注册表`，
 *   再传给 该跑观察 / 观察状态 / 跑观察一次。
 *
 * 校验规则（精确匹配，不做前缀/别名/模糊）：
 *   · provider.id === 配置的 provider        —— 全等
 *   · model.id    === 配置的 model           —— 全等
 *   · 任何一步抛错 → { ok:false }
 *
 * ⚠⚠ 绝不用「试调一次看通不通」替代注册表校验 —— 那是拿钱和副作用
 *   去证明一件静态的事，还会把「模型不存在」和「网络抖动」混成一类。
 *
 * @param {object} ctx  DSH 插件 context（要 ctx.llm）
 * @returns {Promise<function>} 同步的 (provider, model) => {ok, 说}
 */
export async function 造注册表校验(ctx) {
  if (!ctx || !ctx.llm || typeof ctx.llm.listProviders !== 'function') {
    // 没有注册表能力 → 这个校验函数永远说「查不了」，调用方据此停在 configured
    return () => ({ ok: false, 说: '当前宿主没有 llm.listProviders，无法查注册表' })
  }

  let 提供商们 = null
  let 读表错 = ''
  try {
    提供商们 = ctx.llm.listProviders() || []
  } catch (error) {
    读表错 = String((error && error.message) || error)
  }

  // 预取每个 provider 的 model 列表（一次查完，之后同步比对）
  const 表 = new Map()
  if (!读表错) {
    for (const p of 提供商们) {
      const id = String((p && p.id) || '')
      if (!id) continue
      try {
        const ms = await ctx.llm.listModels(id)
        表.set(id, new Set((ms || []).map((m) => String((m && m.id) || '')).filter(Boolean)))
      } catch (error) {
        // 某个 provider 查不了 → 记成不可用，绝不当成「有」
        表.set(id, null)
      }
    }
  }

  return (provider, model) => {
    if (读表错) return { ok: false, 说: '注册表查询失败：' + 读表错 }
    const p = String(provider || '')
    const m = String(model || '')
    if (!p || !m) return { ok: false, 说: 'provider / model 为空' }
    if (!表.has(p)) return { ok: false, 说: '注册表里没有 provider「' + p + '」' }
    const 模型集 = 表.get(p)
    if (!模型集) return { ok: false, 说: 'provider「' + p + '」的模型列表查不了' }
    if (!模型集.has(m)) {
      return {
        ok: false,
        说: 'provider「' + p + '」下没有 model「' + m + '」（已注册：'
          + [...模型集].slice(0, 12).join(', ') + (模型集.size > 12 ? ' …' : '') + '）',
      }
    }
    return { ok: true, 说: '' }
  }
}

/**
 * ⭐ 模型可用性分级（当前用户的二·2）。
 *
 * 上一版把「配置字符串写对了」就叫 `可用` —— 那是**假的**。
 * 字符串完整只证明配置没拼错，不证明 provider / model 在宿主里真的注册过。
 *
 * 三级，语义必须分清：
 *
 *   'unconfigured'  配置缺失或不完整        → 不调用
 *   'configured'    **已配置、未验证**      → 不调用（还不知道能不能用）
 *   'unavailable'   查过了，注册表里没有    → 不调用
 *   'available'     查过了，注册表里有      → 才允许调用
 *
 * ⚠ 「已验证」必须由外部注入的 `查注册表(provider, model)` 实际确认，
 *   不能靠配置字符串推断。查注册表函数没给 = 无法验证 = 停在 configured。
 *
 * @param {object} 配置          读观察配置() 的结果
 * @param {object} 选
 * @param {function} 选.查注册表  (provider, model) => {ok:boolean, 说:string}
 *                                由 index.js 接线时注入真实注册表查询
 */
export function 观察模型状态(配置, 选 = {}) {
  const 基础 = 解析观察模型(配置)
  if (!基础.ok) {
    // 分辨「压根没配」和「配了但不合规（如 -1017）」
    const 有配置 = !!(配置 && 配置.model && 配置.model.provider && 配置.model.model)
    return {
      状态: 有配置 ? 'unavailable' : 'unconfigured',
      ok: false,
      可调用: false,
      模型: 基础.模型,
      说: 基础.说,
    }
  }

  const { provider, model } = 基础.模型
  const 查 = 选 && typeof 选.查注册表 === 'function' ? 选.查注册表 : null

  // ⚠ 没给注册表查询 → 只能到「已配置、未验证」，不许自称可用
  if (!查) {
    return {
      状态: 'configured',
      ok: false,
      可调用: false,
      模型: { provider, model },
      说: '已配置、未验证 —— 配置字符串完整，但没查过 provider/model 是否真的注册过，'
        + '所以不允许产生模型调用（需接线时注入注册表查询）',
    }
  }

  let 结果 = null
  try {
    结果 = 查(provider, model)
  } catch (error) {
    return {
      状态: 'unavailable',
      ok: false,
      可调用: false,
      模型: { provider, model },
      说: '注册表查询抛错：' + String((error && error.message) || error) + ' —— 不回退，不调用',
    }
  }

  if (!结果 || !结果.ok) {
    return {
      状态: 'unavailable',
      ok: false,
      可调用: false,
      模型: { provider, model },
      说: '模型未注册或不可用（' + provider + ' / ' + model + '）：'
        + String((结果 && 结果.说) || '注册表里没有') + ' —— 不回退，不调用',
    }
  }

  return {
    状态: 'available',
    ok: true,
    可调用: true,
    模型: { provider, model },
    说: '',
  }
}

/** 建造观察用模型回调的工厂 —— 由调用方注入真正的调用实现 */
export function 造观察模型回调(模型, 调用实现, 选 = {}) {
  let 调用次数 = 0
  let 失败次数 = 0
  let 截断次数 = 0
  let 中断次数 = 0
  let 缺失finish = 0
  let 重试次数 = 0
  const 调用明细 = []
  let 序号 = 0
  // ⚠ 观察期要留真实原文（当前用户的三）：模型到底给没给某个字段，
  //   只有原文能证明 —— 校验之后字段会被归一，分辨不出「没给」和「给了 false」。
  //   默认存全文，只落在 shadow 审计目录里。
  const 存原文 = 选.存原文 !== false
  const 原文上限 = Number.isFinite(选.原文上限) ? 选.原文上限 : 20000

  const 回调 = async (参) => {
    调用次数++
    序号++
    const 当前 = 序号
    // ⭐ 重试统计：调用方传 是重试 === true 才算。
    //   现在的来源：
    //     · 主提炼第 2 次（fact-builder 格式重试）
    //     · 关系裁判截断后重试（fact-relation 显式带 是重试:true）
    //   语义裁判 / 映射裁判 / 证据修复**没有重试通道**（截断即失败），
    //   所以它们永远不带这个标记 —— 统计数应与实际重试次数一致。
    const 本次是重试 = 参 && 参.是重试 === true
    if (本次是重试) 重试次数++
    let 出
    try {
      出 = await 调用实现({ ...参, provider: 模型.provider, model: 模型.model })
    } catch (error) {
      失败次数++
      调用明细.push({ 序: 当前, 是重试: 本次是重试, 结果: '抛错', 错: String((error && error.message) || error) })
      return { ok: false, message: '观察模型调用抛错：' + String((error && error.message) || error) }
    }
    const 态 = 出 && 出.finishKind
    if (态 === 'max-tokens') 截断次数++
    else if (态 === 'aborted') 中断次数++
    else if (态 === null || 态 === undefined) 缺失finish++
    if (!出 || !出.ok) 失败次数++
    const 正文 = String((出 && 出.text) || '')
    const 明 = {
      序: 当前,
      是重试: 本次是重试,
      最多: 参 && 参.最多,
      json模式: !!(参 && (参.json模式 || 参.jsonMode)),
      ok: !!(出 && 出.ok),
      finishKind: 态 === undefined ? null : 态,
      finishSeen: 态 !== undefined && 态 !== null,
      正文长度: 正文.length,
      结果: 出 && 出.ok ? 'ok' : '失败',
      说: String((出 && (出.message || 出.说)) || '').slice(0, 200),
    }
    if (存原文) 明.正文 = 正文.slice(0, 原文上限)
    调用明细.push(明)
    return 出
  }

  回调.统计 = () => ({ 调用次数, 失败次数, 截断次数, 中断次数, 缺失finish, 重试次数, 调用明细: [...调用明细] })
  回调.记重试 = () => { 重试次数++ }
  return 回调
}

// ── 判断该不该跑 ──────────────────────────────────────

/**
 * 这个会话该不该跑观察。
 *
 * ⚠ 四道门，缺一不可：
 *   1. enabled === true（严格布尔）
 *   2. session 在白名单里（原始精确比较）
 *   3. 观察专用模型配置完整
 *   4. **模型已由注册表确认可用** —— 未验证 / 未注册一律不调用
 *
 * ⚠ 第 4 门是这一轮加的。上一版只要字符串拼对就放行，
 *   真接生产时会在「模型没注册」上白跑一堆失败调用。
 */
export function 该跑观察(配置, session, 选 = {}) {
  if (!配置 || 配置.enabled !== true) {
    return { 跑: false, 原因: '观察模式未启用（enabled 必须严格是 true）' }
  }
  // ⚠⚠ 授权：原始 session 与白名单**逐字节精确比较**。
  //   这里绝不许先消毒再比 —— 那会让 'sess 1' 和 'sess/1' 都变成 'sess1'，
  //   一个被授权就等于另一个也被授权。
  const 原 = 原始会话(session)
  if (!原) return { 跑: false, 原因: '会话 id 不合法' }
  if (!配置.sessions.includes(原)) {
    return { 跑: false, 原因: '会话不在私聊白名单里' }
  }
  const 模型状态 = 观察模型状态(配置, 选)
  if (!模型状态.可调用) {
    return { 跑: false, 原因: 模型状态.说, 模型状态: 模型状态.状态 }
  }
  return { 跑: true, 原因: '', 模型: 模型状态.模型, 模型状态: 'available' }
}

// ── 跑一次观察 ────────────────────────────────────────

/**
 * 跑一次观察（手动、受控触发；**不开自动扫描**）。
 *
 * 全程：
 *   · 只读事件卡（跑一轮 内部不写任何文件）
 *   · 事实读写走 shadow 注入（读事实 / 写事实 / 写状态 / 写冲突）
 *   · 不碰正式 facts / fact-state / fact-rejections / conflicts
 *   · 失败只记审计，**不抛给调用方**（不能影响 legacy 聊天）
 *
 * @returns {object} 观察结果（含 audit 记录）
 */
export async function 跑观察一次(参) {
  const {
    session, 事件根, 配置, 调用实现, 现在 = Date.now(),
    读消息 = null, 跑一轮实现, 落盘一轮实现,
    maxTokens每批 = 2000,
    // ⚠ index.js 接线时注入真实注册表查询；不给 = 无法验证 = 不调用
    查注册表 = null,
  } = 参

  // ⚠ 身份一律用原始 session（授权、轮次键、审计里的 session 字段都靠它）
  const 会 = 原始会话(session)
  const 判定 = 该跑观察(配置, 会, { 查注册表 })

  if (!判定.跑) {
    return {
      ok: false, 跑了: false, 说: 判定.原因, session: 会,
      正式写入: false, 观察写入: false,
    }
  }
  if (typeof 跑一轮实现 !== 'function') {
    return { ok: false, 跑了: false, 说: '缺少 跑一轮 实现', session: 会, 正式写入: false, 观察写入: false }
  }

  // ⚠⚠ 单飞：同一 session 并发进来，第二个直接挡回去。
  //   必须在**任何写盘动作之前**抢锁。
  if (正在跑.has(会)) {
    return {
      ok: false, 跑了: false, 正在运行: true,
      说: '这个会话的观察正在运行中，请等它跑完再触发（防止 shadow 数据被并发覆盖）',
      session: 会, 正式写入: false, 观察写入: false,
    }
  }
  正在跑.add(会)
  try {

  const 旧状态 = 读shadow状态(会)
  const 模型回调 = 造观察模型回调(判定.模型, 调用实现)
  const 开始 = Date.now()
  let 轮结果 = null
  let 崩了 = ''
  let 落结果 = null

  try {
    轮结果 = await 跑一轮实现({
      事件根, session: 会, 状态: 旧状态, 现在,
      读消息,
      模型回调,
      语义裁判回调: 模型回调,
      关系裁判回调: 模型回调,
      映射裁判回调: 模型回调,
      // ⚠⚠ 证据修复裁判也必须接上。
      //   fact-builder 里 `启用证据修复: Boolean(参.证据修复回调)` ——
      //   不传这个，证据修复整条通路是关的，B3B 真正上线后会因为
      //   「候选缺 evidenceMessageIds」白白丢掉本来能救回来的事实。
      //   观察模式就是要**和正式跑法一致**，所以这里必须补。
      证据修复回调: 模型回调,
      privateStrict: true,
      // ⚠⚠ 关键隔离点：现有事实读 shadow，不读正式库
      读事实: (s) => 读shadow事实(s),
    })
  } catch (error) {
    崩了 = String((error && error.message) || error)
  }

  const 统计 = 模型回调.统计()

  // ⭐ 主提炼原文里的 explicitCorrection 存在性快照。
  //
  // ⚠ 为什么需要它：校验候选会把缺失的字段归一成 `false`
  //   （fact-builder: `f.explicitCorrection === true || category === 'correction'`），
  //   所以到了候选审计那一层，「模型没给」和「模型给了 false」长得一模一样。
  //   观察期必须能分辨 —— 只有原文能证明。
  const 原文快照 = []
  for (const 明 of 统计.调用明细) {
    // 主提炼：json 模式 + 预算最大那条
    if (!明.json模式) continue
    if (Number(明.最多) < 1000) continue
    let o = null
    try {
      o = JSON.parse(String(明.正文 || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    } catch (error) { continue }
    for (const f of (o && Array.isArray(o.facts) ? o.facts : [])) {
      原文快照.push({
        调用序: 明.序,
        predicate: String(f.predicate || ''),
        value: String(f.value || ''),
        category: String(f.category || ''),
        有explicitCorrection字段: Object.prototype.hasOwnProperty.call(f, 'explicitCorrection'),
        explicitCorrection原文值: f.explicitCorrection === undefined ? null : f.explicitCorrection,
        原文类型: typeof f.explicitCorrection,
      })
    }
  }

  // ⚠ 无论成功失败，都**不**影响正式路径。这里只把结果落进 shadow。
  if (轮结果 && typeof 落盘一轮实现 === 'function') {
    try {
      落结果 = 落盘一轮实现({
        session: 会, 一轮结果: 轮结果, 旧状态,
        写事实: 写shadow事实, 写冲突: 写shadow冲突, 写状态: 写shadow状态,
        // ⚠⚠ 必须传 拒绝根 —— 不传的话，只要有候选被拒，
        //   落盘一轮 会因「拒绝审计写失败」整轮失败、水位不动。
        拒绝根: SHADOW_REJECT_ROOT,
        现在,
      })
    } catch (error) {
      落结果 = { ok: false, 说: 'shadow 落盘抛错：' + String((error && error.message) || error) }
    }
  }

  const 新状态 = 读shadow状态(会)
  const 事实们 = 读shadow事实(会)
  const 批次统计 = (轮结果 && 轮结果.批次统计) || {}

  // 轮次键：只用来**分组**同一水位的多次尝试，不再用于覆盖去重。
  const 水位签名 = JSON.stringify(旧状态.文件水位 || {})
  const 轮次键 = 会 + '@' + 水位签名

  // 尝试签名：同一轮、同样的结果，就没必要重复记一条（幂等靠它，不靠覆盖）。
  // ⚠ 只要结果不同（比如先失败后成功），签名就不同 → 两条都留下。
  const 结果指纹 = [
    轮次键,
    (轮结果 && 轮结果.ok) ? 'ok' : 'fail',
    String(崩了 || (轮结果 && 轮结果.说) || ''),
    JSON.stringify(批次统计.rejectionCodes || {}),
    String(批次统计.rawCandidates || 0),
    String((轮结果 && 轮结果.事件数) || 0),
    String((落结果 && 落结果.写事实) || 0),
  ].join('|')

  const 记录 = {
    轮次键,
    尝试签名: 结果指纹,
    session: 会,
    时间: new Date(现在).toISOString(),
    耗时毫秒: Date.now() - 开始,
    模型: { provider: 判定.模型.provider, model: 判定.模型.model },
    // ⚠ 正式写入永远 false —— 状态接口要显示这个
    正式写入: false,
    事件范围: {
      事件根,
      处理前水位: 旧状态.文件水位 || {},
      处理后水位: 新状态.文件水位 || {},
      本批事件数: (轮结果 && 轮结果.事件数) || 0,
    },
    // 主提炼原始候选数
    原始候选数: 批次统计.rawCandidates || 0,
    接受数: 批次统计.acceptedCandidates || 0,
    拒绝数: (批次统计.rejectedCandidates || 0),
    仅事件数: 批次统计.eventOnlyCandidates || 0,
    修复数: 批次统计.repairedCandidates || 0,
    拒绝码分布: 批次统计.rejectionCodes || {},
    // 候选明细（predicate / value / 证据 / explicitCorrection / 关系裁定）
    候选们: (轮结果 && 轮结果.候选审计们) || [],
    // ⭐ 主提炼原文的字段存在性快照 —— 分辨「模型没给」还是「给了 false」
    主提炼原文快照: 原文快照,
    关系判定们: (轮结果 && 轮结果.关系判定们) || [],
    拒绝审计们: (轮结果 && 轮结果.拒绝审计们) || [],
    // 调用与状态
    模型调用: {
      调用次数: 统计.调用次数,
      失败次数: 统计.失败次数,
      截断次数maxTokens: 统计.截断次数,
      中断次数aborted: 统计.中断次数,
      缺失finish次数: 统计.缺失finish,
      重试次数: 统计.重试次数,
      明细: 统计.调用明细,
    },
    // 如果按正式逻辑落盘，会发生什么
    落盘结果: {
      会写事实: (落结果 && 落结果.写事实) || 0,
      重复事实: (落结果 && 落结果.重复事实) || 0,
      失败事实: (落结果 && 落结果.失败事实) || 0,
      会写冲突: (落结果 && 落结果.写冲突) || 0,
      状态会写: !!(落结果 && 落结果.状态写了),
      说: String((落结果 && 落结果.说) || ''),
    },
    阴影事实: 事实们.map((f) => ({
      factId: String(f.factId || ''),
      predicate: String(f.predicate || ''),
      value: String(f.value || ''),
      status: String(f.status || ''),
      category: String(f.category || ''),
      supersedes: [...(f.supersedes || [])].map(String),
      contradicts: [...(f.contradicts || [])].map(String),
    })),
    诊断: (轮结果 && 轮结果.诊断) || [],
    ok: !!(轮结果 && 轮结果.ok),
    说: 崩了 || String((轮结果 && 轮结果.说) || ''),
    崩溃: 崩了,
  }

  let 审计写入 = { ok: false, written: false, duplicate: false, error: '' }
  // ⚠⚠ 每次都写，**不查重、不吞记录**。
  //   重复的结果只在记录上标 duplicateResult，记录本身照留 ——
  //   因为每次手动触发都是真实发生的一次观察尝试。
  try {
    审计写入 = 写shadow审计(会, 记录)
  } catch (error) {
    审计写入 = { ok: false, written: false, duplicate: false, error: String((error && error.message) || error) }
  }

  return {
    ok: 记录.ok,
    跑了: true,
    说: 记录.说,
    session: 会,
    正式写入: false,          // ⚠ 恒为 false
    观察写入: !!审计写入.ok,
    观察写入重复: !!审计写入.duplicate,
    attemptId: 审计写入.attemptId || null,
    attemptNumber: 审计写入.attemptNumber || null,
    尝试序号: 审计写入.attemptNumber || null,
    记录,
  }
  } finally {
    // ⚠ 无论成功、失败、抛错，都必须释放锁 —— 否则这个会话就再也跑不了了
    正在跑.delete(会)
  }
}

// ── 状态接口 ──────────────────────────────────────────

/**
 * 观察模式状态（给接口 / 诊断用）。
 *
 * 当前用户要求必须能显示：是否启用 / 白名单会话 / 指定模型 /
 * shadow 水位 / 最近一次结果和错误 / 正式写入始终为 false。
 */
export function 观察状态(参 = {}) {
  const 配置 = 参.配置 || 读观察配置(参.配置路径 || null)
  const 模型状态 = 观察模型状态(配置, { 查注册表: 参.查注册表 || null })

  const 各会话 = []
  const 名单 = 配置.sessions || []
  let 审计目录存在 = existsSync(SHADOW_AUDIT)

  for (const s of 名单) {
    const 状态 = 读shadow状态(s)
    const 审计 = 读shadow审计(s)
    const 最近 = 审计.length ? 审计[审计.length - 1] : null

    // ⚠ 按轮次键分组统计尝试：状态接口只显示最近一次，
    //   但**全部尝试**留在审计文件里（当前用户的四）。
    const 轮次组 = new Map()
    for (const x of 审计) {
      const k = String(x.轮次键 || '')
      if (!轮次组.has(k)) 轮次组.set(k, [])
      轮次组.get(k).push(x)
    }
    const 轮次摘要 = [...轮次组].map(([k, 组]) => ({
      轮次键: k,
      尝试次数: 组.length,
      成功次数: 组.filter((x) => x.ok).length,
      失败次数: 组.filter((x) => !x.ok).length,
      attemptNumber们: 组.map((x) => x.attemptNumber),
      尝试序号们: 组.map((x) => x.尝试序号),
    }))

    各会话.push({
      session: s,
      shadow水位: 状态.文件水位,
      连败: 状态.连败,
      审计条数: 审计.length,
      // ⚠ 总触发次数 = 真实保存的 attempt 数。不扣掉重复结果 ——
      //   每次手动触发都真实跑过一遍模型，那就是一次触发。
      总触发次数: 审计.length,
      总尝试次数: 审计.length,
      // 额外显示：结果和上一次相同的次数（只是统计，记录没删）
      重复结果次数: 统计重复结果(s),
      distinct结果数: new Set(审计.map((x) => String(x.轮次键 || '') + '\u0000' + String(x.尝试签名 || ''))).size,
      轮次数: 轮次组.size,
      首次attemptNumber: 审计.length ? (审计[0].attemptNumber || null) : null,
      末次attemptNumber: 审计.length ? (审计[审计.length - 1].attemptNumber || null) : null,
      轮次摘要,
      最近一次: 最近 ? {
        // ⚠ 最近一次永远对应最后一次真实触发（数组末条），不做任何挑选
        attemptId: 最近.attemptId || '',
        attemptNumber: 最近.attemptNumber || null,
        尝试序号: 最近.尝试序号,
        duplicateResult: !!最近.duplicateResult,
        轮次键: 最近.轮次键,
        时间: 最近.时间,
        ok: 最近.ok,
        原始候选数: 最近.原始候选数,
        接受数: 最近.接受数,
        拒绝数: 最近.拒绝数,
        仅事件数: 最近.仅事件数,
        模型调用: 最近.模型调用 ? {
          调用次数: 最近.模型调用.调用次数,
          失败次数: 最近.模型调用.失败次数,
          截断次数maxTokens: 最近.模型调用.截断次数maxTokens,
          中断次数aborted: 最近.模型调用.中断次数aborted,
          缺失finish次数: 最近.模型调用.缺失finish次数,
          重试次数: 最近.模型调用.重试次数,
        } : null,
        错误: 最近.ok ? '' : String(最近.说 || 最近.崩溃 || '').slice(0, 300),
      } : null,
    })
  }

  return {
    enabled: 配置.enabled === true,
    白名单会话: 名单,
    白名单原样: 配置.白名单原样 || [],
    拒收名单: 配置.拒收名单 || [],
    指定模型: 模型状态.模型 || (配置.model || null),
    // ⚠ 只有注册表真的确认过才叫 'available'。
    //   配置字符串完整只到 'configured'（已配置、未验证）。
    模型状态: 模型状态.状态,
    模型可调用: 模型状态.可调用,
    模型说明: 模型状态.说 || '注册表已确认可用',
    配置状态: 配置.配置状态 || 'ok',
    shadow目录: {
      facts: SHADOW_FACTS,
      state: SHADOW_STATE,
      audit: SHADOW_AUDIT,
      审计目录存在,
    },
    // ⚠ 恒 false —— 观察模式在任何情况下都不写正式库
    正式写入: false,
    会话: 各会话,
  }
}

export { SHADOW_ROOT, SHADOW_FACTS, SHADOW_STATE, SHADOW_AUDIT }
