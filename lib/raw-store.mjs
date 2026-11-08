// 原始聊天归档（raw store）—— 五层记忆的**第一层**
//
// ⭐ 2026-11-01 当前用户定的架构：只记**真实发生过的** QQ 消息。
//
// 为什么要有这一层：dsh-fish-memory 以前直接扫会话里的 assistant/message，
// 可那里的内容**不等于**她说过的话 —— 代理的后台分析（"Let me also check…"）、
// 工具过程、被门槛拦下的回复，全都在里面。这些东西一旦进入摘要层、事件卡，
// 会污染整个上层建筑。所以先把「真的收发到 QQ 的」单独钉成一份事实。
//
// 谁来写：**QQ 桥**。只有它知道「有没有真的发出去」。
// 谁来读：记忆插件。它只读文件，不碰桥的内部状态 —— 两边不 import 彼此。
//
// 目录：
//   ~/.dsh/fish-memory-v2/raw/<会话ID>/YYYY-MM-DD.jsonl
//
// 只追加、一行一条、UTF-8。同 id 不重复写（桥那边可能重复轮询）。
// 写失败只记账，**绝不往聊天主链路抛错**。

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const 根目录 = join(CFG_DIR, 'fish-memory-v2', 'raw')

/** 本地日期 → YYYY-MM-DD（按本地时区，不是 UTC —— 否则凌晨的消息会跑到前一天） */
export function 日期键(ms) {
  const d = new Date(ms == null ? Date.now() : ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 带时区的 ISO 时间 */
export function 时刻ISO(ms) {
  const d = new Date(ms == null ? Date.now() : ms)
  const 偏 = -d.getTimezoneOffset()
  const 号 = 偏 >= 0 ? '+' : '-'
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const 本 = new Date(d.getTime() + 偏 * 60000).toISOString().slice(0, 19)
  return 本 + 号 + p(偏 / 60) + ':' + p(偏 % 60)
}

/** 一条消息的规范形状。字段固定，别随手加 —— 上层按这九个字段读。 */
export function 造一条({
  id, session, scope, direction, role, speakerId, speakerName, text, images, at, source,
}) {
  return {
    id: String(id || ''),
    session: String(session || ''),
    scope: scope === 'group' ? 'group' : 'private',
    direction: direction === 'outbound' ? 'outbound' : 'inbound',
    role: role === 'assistant' ? 'assistant' : 'user',
    speakerId: String(speakerId || ''),
    speakerName: String(speakerName || ''),
    text: String(text == null ? '' : text),
    images: Array.isArray(images) ? images : [],
    at: String(at || 时刻ISO()),
    source: String(source || 'qq-bridge'),
  }
}

function 会话目录(session) {
  // ⚠ 会话 id 里有 `-`，但不会有 `/` `\` `..` —— 还是挡一道，别让脏 id 写出目录外
  const 干净 = String(session || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!干净) return ''
  return join(根目录, 干净)
}

/** 今天这份文件里已经有哪些 id（用来防重复）。只看当天那份，不全扫。 */
function 今天已有(目录, 日) {
  const p = join(目录, 日 + '.jsonl')
  const 集 = new Set()
  if (!existsSync(p)) return 集
  try {
    for (const 行 of readFileSync(p, 'utf8').split('\n')) {
      const s = 行.trim()
      if (!s) continue
      try {
        const 条 = JSON.parse(s)
        if (条 && 条.id) 集.add(String(条.id))
      } catch (error) { /* 坏行跳过，不影响别的 */ }
    }
  } catch (error) {}
  return 集
}

/**
 * 写一条。**永远不抛错** —— 归档失败不能连累聊天。
 * @returns {boolean} 真的写进去了没有（false = 重复 / 被挡 / 写失败）
 */
export function 写一条(记录, 就绪 = {}) {
  const r = 记录 || {}
  const id = String(r.id || '')
  const session = String(r.session || '')
  if (!id || !session) return false
  if (!String(r.text || '').trim() && !(Array.isArray(r.images) && r.images.length)) return false
  const 目录 = 会话目录(session)
  if (!目录) return false
  try {
    mkdirSync(目录, { recursive: true })
  } catch (error) {
    return false
  }
  const 日 = 日期键(Date.parse(r.at) || Date.now())
  // 防重复：同 id 只写一次（桥可能重复轮询同一条）
  if (今天已有(目录, 日).has(id)) return false
  try {
    appendFileSync(join(目录, 日 + '.jsonl'), JSON.stringify(造一条(r)) + '\n', 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ── 读 ────────────────────────────────────────────────────────────
// 记忆插件只用这几个函数。全部**只读**，不改文件。

/** 某会话的全部日文件，从旧到新 */
function 日文件们(session) {
  const 目录 = 会话目录(session)
  if (!目录 || !existsSync(目录)) return []
  try {
    return readdirSync(目录)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => join(目录, f))
  } catch (error) {
    return []
  }
}

/**
 * 把某个日文件读成「记录数组」，带原始顺序号。
 * 顺序号用来给 at 缺失/非法的记录做稳定兜底。
 */
function 读一日文件(路径, 序号起) {
  let 行们 = []
  try {
    行们 = readFileSync(路径, 'utf8').split('\n')
  } catch (error) {
    return { 条们: [], 下一号: 序号起 }
  }
  const 条们 = []
  let 序 = 序号起
  for (const 原 of 行们) {
    const s = 原.trim()
    if (!s) continue
    let 条 = null
    try { 条 = JSON.parse(s) } catch (error) { continue }  // 坏行跳过
    if (!条 || typeof 条 !== 'object') continue
    条们.push({ 条, 序 })
    序 += 1
  }
  return { 条们, 下一号: 序 }
}

/** 一条记录的排序时间戳；at 缺失或非法返回 null */
function 时间戳(条) {
  if (!条 || typeof 条.at !== 'string') return null
  const t = Date.parse(条.at)
  return Number.isFinite(t) ? t : null
}

/**
 * 读某会话最近的 N 条，**按 at 从新到旧**。
 *
 * ⚠ 2026-11-02 修：以前是「从最新的日文件、从最后一行往前取」——
 *    那个假设是「文件追加顺序 == 消息时间顺序」。补投、延迟处理、
 *    掉线恢复之后这个假设**不成立**：先写进去的一行可能 at 更晚。
 *    而且一旦在循环里就 `出.length < 限` 提前停，会漏掉更早写入但更新的那条。
 *    现在：把相关日文件全读出来、全排序、再截断。
 *    量很小（一天几十上百条），代价可以忽略。
 *
 * 排序规则：
 *   1) at 有效的按 at 降序
 *   2) at 缺失/非法的，用「文件内顺序号」兜底 —— 它同时也是跨文件的
 *      稳定次序（日文件按名字从旧到新串起来编号），所以乱序数据也不会翻来覆去
 *
 * @param {string} session
 * @param {object} 选 { direction, role, limit, 文件数 } 文件数 = 最多回看几个日文件
 */
export function 读最近(session, 选 = {}) {
  const 限 = Math.max(1, Math.min(Number(选.limit) || 20, 500))
  // 回看窗口：默认全都读（数据量小），给第二阶段流一个上限旋钮
  const 最多文 = Math.max(1, Number(选.文件数) || 400)
  const 文件 = 日文件们(session)
  const 用 = 文件.slice(-最多文)
  const 全 = []
  let 序 = 0
  for (const f of 用) {
    const r = 读一日文件(f, 序)
    序 = r.下一号
    for (const x of r.条们) 全.push(x)
  }
  // 先按 序 排一遍（保证兜底次序稳定），再用 at 盖上去
  全.sort((a, b) => a.序 - b.序)
  const 出 = 全.filter(({ 条 }) => {
    if (选.direction && 条.direction !== 选.direction) return false
    if (选.role && 条.role !== 选.role) return false
    return true
  }).map((x) => ({ ...x, 时: 时间戳(x.条) }))
  // at 有值的排前面（按时间降序）；at 没值的靠后，内部按序降序
  出.sort((a, b) => {
    const at = a.时
    const bt = b.时
    if (at != null && bt != null) return bt - at || b.序 - a.序
    if (at != null) return -1
    if (bt != null) return 1
    return b.序 - a.序
  })
  return 出.slice(0, 限).map((x) => x.条)
}

/**
 * 分页读（给第二阶段预留的接口，这次不做索引）。
 * 从最新往回翻，跳过 跳过条 再取 限条。
 */
export function 翻页(session, { 跳过 = 0, limit = 20, direction, role } = {}) {
  const 跳 = Math.max(0, Number(跳过) || 0)
  const 限 = Math.max(1, Math.min(Number(limit) || 20, 500))
  // 只多读「跳过 + 限」这么多，够用就停（不做全量排序，量大了才需要真索引）
  return 读最近(session, { direction, role, limit: 跳 + 限, 文件数: 60 }).slice(跳)
}

/**
 * ⭐ 2026-11-04：**按消息 ID 精确取**，不做「最近 N 条」截断。
 *
 * 为什么必须单独有这个函数：
 *   以前 index.js 用 `最近聊天(sid, 500)` 来找事件的来源消息。
 *   那是个**错误的正交性假设** —— 事件卡的 sourceMessageIds 可能指向
 *   500 条以前的旧消息，最近 500 条里根本找不到，于是证据被静默丢掉。
 *   检索的正确性边界必须是「这个 ID 存不存在」，不是「它够不够新」。
 *
 * 做法：扫这个会话的**全部**日文件，建一次 id 索引再查。
 *   数据量很小（一天几十上百条，一个会话几个月也就几千条），
 *   全扫的代价远小于「漏证据」的代价。
 *   ⚠ 只读，不改任何文件。
 *
 * @param {string} session
 * @param {string[]} ids 要找的消息 id
 * @returns {{找到: Map<string, object>, 缺: string[]}}
 *   找到：id → 原始记录；历史复合 id 会严格校验后合成一条逻辑记录
 *   缺  ：没找到的 id —— 调用方必须把它当**证据缺口**处理，不能当「没有意见」
 */
export function 按id取(session, ids) {
  const 找到 = new Map()
  const 要 = []
  for (const x of Array.isArray(ids) ? ids : []) {
    const k = String(x == null ? '' : x)
    if (k && !要.includes(k)) 要.push(k)
  }
  if (!要.length) return { 找到, 缺: [] }

  // 旧版事件层曾把分段回复写成 `物理id1+物理id2`。新卡已经保留物理 id，
  // 但历史卡不能改写，所以这里兼容读取。仍然先查复合串本身：raw 里若真有
  // 一个带 `+` 的精确 id，它必须优先，不能被拆分逻辑覆盖。
  const 组成表 = new Map()
  const 扫描id = new Set(要)
  for (const id of 要) {
    const 部件 = 拆复合id(id)
    if (!部件) continue
    组成表.set(id, 部件)
    for (const part of 部件) 扫描id.add(part)
  }

  const 原始 = new Map()
  const 文件 = 日文件们(session)
  let 序 = 0
  for (const f of 文件) {
    if (原始.size >= 扫描id.size) break     // 全齐了就不用再扫
    const r = 读一日文件(f, 序)
    序 = r.下一号
    for (const { 条 } of r.条们) {
      const id = String((条 && 条.id) || '')
      if (!id) continue
      if (!扫描id.has(id)) continue
      // ⚠ 同 id 多行时保留**第一条**（桥有去重，理论上不该重复；
      //   真重复了也以最早那条为准，别让后来的覆盖证据）
      if (!原始.has(id)) 原始.set(id, 条)
    }
  }

  for (const id of 要) {
    if (原始.has(id)) {
      找到.set(id, 原始.get(id))
      continue
    }
    const 部件 = 组成表.get(id)
    if (!部件) continue
    const 合成 = 合成复合证据(session, id, 部件, 原始)
    if (合成) 找到.set(id, 合成)
  }

  const 缺 = 要.filter((id) => !找到.has(id))
  return { 找到, 缺 }
}

/**
 * 历史复合 id 只接受 QQ 物理消息 id 的 `+` 连接。
 * 普通文本里带 `+`、空部件、重复部件都不算复合证据。
 */
function 拆复合id(id) {
  const s = String(id || '')
  if (!s.includes('+')) return null
  const 部件 = s.split('+')
  if (部件.length < 2 || 部件.some((x) => !/^qq--?\d+$/.test(x))) return null
  if (new Set(部件).size !== 部件.length) return null
  return 部件
}

/** 所有字段和分段拓扑都一致时，才把历史复合 id 合成逻辑证据。 */
function 合成复合证据(session, id, 部件, 原始) {
  const 条们 = 部件.map((part) => 原始.get(part))
  if (条们.some((x) => !x)) return null

  const 首 = 条们[0]
  const 会 = String(session || '')
  const 逻辑 = String(首.logicalReplyId || '')
  const 段数 = Number(首.segmentCount)
  if (!会 || !逻辑 || !Number.isInteger(段数) || 段数 !== 部件.length) return null

  const 一致字段 = ['session', 'scope', 'direction', 'role', 'speakerId', 'speakerName', 'logicalReplyId']
  for (const 条 of 条们) {
    for (const 字 of 一致字段) {
      if (String(条[字] == null ? '' : 条[字]) !== String(首[字] == null ? '' : 首[字])) return null
    }
    if (String(条.session || '') !== 会) return null
    if (Number(条.segmentCount) !== 段数) return null
  }

  // 复合串由事件层按 segmentIndex 排序生成；顺序不符也视为证据损坏。
  for (let i = 0; i < 条们.length; i += 1) {
    if (!Number.isInteger(Number(条们[i].segmentIndex)) || Number(条们[i].segmentIndex) !== i) return null
  }

  let 最早条 = 首
  let 最早时 = Date.parse(首.at)
  for (const 条 of 条们.slice(1)) {
    const t = Date.parse(条.at)
    if (Number.isFinite(t) && (!Number.isFinite(最早时) || t < 最早时)) {
      最早时 = t
      最早条 = 条
    }
  }
  const source = 条们.every((x) => String(x.source || '') === String(首.source || ''))
    ? String(首.source || '') : 'qq-bridge'

  return {
    ...首,
    id,
    session: 会,
    text: 条们.map((x) => String(x.text || '')).filter((x) => x.trim()).join('\n'),
    images: 条们.flatMap((x) => (Array.isArray(x.images) ? x.images : [])),
    // 保留 raw 原有时区表示，不因运行机器时区不同而改写证据时间。
    at: String(最早条.at || 首.at || ''),
    source,
    logicalReplyId: 逻辑,
    segmentIndex: 0,
    segmentCount: 段数,
    sourceMessageIds: 部件.slice(),
  }
}

/** 某会话最后一条**真实发送成功**的助手回复。没有就返回 null。 */
export function 最后一条她说(session) {
  return 读最近(session, { direction: 'outbound', role: 'assistant', limit: 1 })[0] || null
}

/** 某会话最后一条**真实入站**的用户消息。 */
export function 最后一条他说(session) {
  return 读最近(session, { direction: 'inbound', role: 'user', limit: 1 })[0] || null
}

/** 最近 N 条助手真实回复，从新到旧。 */
export function 最近她说(session, n = 5) {
  return 读最近(session, { direction: 'outbound', role: 'assistant', limit: n })
}

/** 最近 N 条真实聊天（双向），从新到旧。 */
export function 最近聊天(session, n = 20) {
  return 读最近(session, { limit: n })
}

/** 有没有归档数据（记忆插件用它决定「宁可不写状态行，也不回退到未经筛选的事件」） */
export function 有归档(session) {
  return 日文件们(session).length > 0
}

/** 某个会话归档了多少条、多大 —— 给诊断和验收用 */
export function 概况(session) {
  const 文件 = 日文件们(session)
  let 条数 = 0
  let 字节 = 0
  for (const f of 文件) {
    try { 字节 += statSync(f).size } catch (error) {}
    try {
      条数 += readFileSync(f, 'utf8').split('\n').filter((x) => x.trim()).length
    } catch (error) {}
  }
  return { session, 目录: 会话目录(session), 日文件: 文件.length, 条数, 字节 }
}

export const 存档根 = 根目录
