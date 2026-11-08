// 事件层存储（event store）—— 五层记忆的**第二层**
//
// ⭐ 2026-11-02 当前用户定的第二阶段：把连续的真实 QQ 消息整理成「发生过的一件事」，
//   形成可追溯的事件卡。本阶段**只影子运行**：
//     · 生成卡，但不注入模型上下文
//     · 不参与召回
//     · 不改旧记忆库、不改原始归档、不改 QQ 桥
//
// 位置：
//   事件卡   ~/.dsh/fish-memory-v2/events/<会话ID>/YYYY-MM.jsonl
//   运行状态 ~/.dsh/fish-memory-v2/event-state/<会话ID>.json
//
// ⚠ 硬约束（写在这里，免得以后有人图省事绕过）：
//   1. **只读** raw 目录。绝不从会话事件 / assistant-message / 模型上下文 / 诊断日志取内容。
//   2. 写失败只记账，绝不往上抛 —— 事件层坏了不能连累 QQ 收发和聊天。
//   3. 状态文件一律「临时文件 + rename」原子替换，不能直接覆盖写一半。
//
// ⭐ 2026-11-02 边界修复（当前用户提的六条）：
//   · 写卡返回结构改成 {ok, written, duplicate, error}，不再用含义不清的 boolean
//     —— 调用方靠这个决定「能不能推进状态」，boolean 分不清「重复」和「失败」
//   · 游标从单个 {文件,行} 改成**每个日文件独立水位** {文件水位:{文件名:行号}}
//     —— 单一游标发现不了「已经处理到 11-02 之后，又往 11-01 追加了迟到消息」
//   · 状态写失败也要能报出来（返回 {ok,error}），调用方据此重试

import {
  mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const 事件根 = join(CFG_DIR, 'fish-memory-v2', 'events')
const 状态根 = join(CFG_DIR, 'fish-memory-v2', 'event-state')

/** 会话 id 消毒 —— 挡掉路径穿越，别让脏 id 写出目录外 */
function 干净会话(session) {
  return String(session || '').replace(/[^A-Za-z0-9_-]/g, '')
}

function 会话事件目录(session) {
  const 干净 = 干净会话(session)
  if (!干净) return ''
  return join(事件根, 干净)
}

function 月键(ms) {
  const d = new Date(ms == null ? Date.now() : ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

/**
 * 原子写一个文件：先写 `<路径>.tmp-<随机>`，再 rename 顶上去。
 * rename 在同一分区上是原子的 —— 中途掉电只会剩一个没人用的临时文件，
 * 不会出现「状态文件写了一半」这种事。
 *
 * @returns {{ok:boolean, error:string}}
 */
export function 原子写(路径, 文本) {
  const 临时 = 路径 + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    mkdirSync(join(路径, '..'), { recursive: true })
  } catch (error) { /* 目录可能已存在 */ }
  try {
    writeFileSync(临时, 文本, 'utf8')
    renameSync(临时, 路径)
    return { ok: true, error: '' }
  } catch (error) {
    try { unlinkSync(临时) } catch (e) { /* 清不掉就算了，别盖住原错误 */ }
    return { ok: false, error: String((error && error.message) || error) }
  }
}

// ── 状态 ──────────────────────────────────────────────────────────

/**
 * 一个会话的初始状态。字段固定，别随手加 —— 恢复逻辑按这些字段读。
 *
 * ⭐ 2026-11-02 边界修复：`游标` 换成 `文件水位`。
 *   · `文件水位` 是 { 文件名: 已处理到的物理行号 }
 *   · 每个日文件**分别**记水位，才能发现「老日期文件被追加了迟到消息」
 *   · 只留 `游标` 的话，处理到 11-02 之后，11-01 里补进来的消息永远读不到
 */
export function 空状态(session) {
  return {
    schemaVersion: 2,
    session: String(session || ''),
    // 每个 raw 日文件独立水位：{ '2026-11-01.jsonl': 12, '2026-11-02.jsonl': 8 }
    文件水位: {},
    // ⚠ 只有从旧 {游标} 迁移过来时才非空。留着等 `跑一轮` 结合真实 raw 文件再迁，
    //   迁完（并且状态成功落盘）才删掉这一项。
    待迁移旧游标: null,
    // 当前还没关闭的事件（原始消息原文，重启后从这里续上）
    open: null,
    // 已关闭的最后一个事件的结束时间和 id（迟到消息诊断用）
    最后关闭: { at: '', eventId: '' },
    // 连续模型失败次数（连败太多次就退避，不无限打模型）
    连败: 0,
    最后成功: '',
    最后尝试: '',
    最后诊断: '',
  }
}

function 状态路径(session) {
  const 干净 = 干净会话(session)
  if (!干净) return ''
  return join(状态根, 干净 + '.json')
}

/**
 * 把旧格式 `{游标:{文件,行}}` 转成「待迁移旧游标」元数据。
 *
 * ⚠⚠ 2026-11-02 第二次修正（当前用户指出的）：
 *   这里**只记元数据，不假装迁移完成**。
 *
 *   以前的错法：在这一步就写 `文件水位 = {游标文件: 行}`，然后删掉游标。
 *   问题是**这一步拿不到文件系统** —— 不知道迁移那一刻真实存在哪些日文件。
 *   结果 `2026-11-01.jsonl` 这种更早的历史文件没有水位，
 *   下一轮 `取新的` 会把它整份重新读、重新问模型。历史重跑。
 *
 *   正确做法：
 *     1. 这里只留下 `待迁移旧游标:{文件,行}`，水位保持空
 *     2. `跑一轮()` 读完 raw、拿到真实文件名单和行数后，再做「结合文件系统的迁移」
 *     3. 迁移后的状态**只有在新状态成功持久化后**才算正式完成
 *     4. 持久化失败 → 磁盘上还是旧的 schemaVersion=1 + 游标，下轮重新迁移
 *
 *   这样同时满足两件事：
 *     · 迁移时**已经存在**的更早历史文件不重跑（按当前行数设成已处理）
 *     · 迁移完成**之后新创建**的更早日期文件仍能被发现（没有水位 → 从头读）
 */
export function 迁移旧游标(o) {
  const 出 = { ...(o || {}) }
  const 旧 = o && o.游标
  const 已迁移 = o && o.文件水位 && Object.keys(o.文件水位).length
  if (旧 && (旧.文件 || Number(旧.行) > 0) && !已迁移 && !o.待迁移旧游标) {
    出.待迁移旧游标 = {
      文件: String(旧.文件 || ''),
      行: Math.max(0, Math.floor(Number(旧.行) || 0)),
    }
  }
  delete 出.游标
  return 出
}

/**
 * 读状态。没有 / 坏了都返回空状态 —— **不能因为状态坏了就不干活**。
 * 坏文件留着不动（人肉还能看一眼），但会记一条诊断。
 */
export function 读状态(session) {
  const 空 = 空状态(session)
  const p = 状态路径(session)
  if (!p || !existsSync(p)) return 空
  let o = null
  try {
    o = JSON.parse(readFileSync(p, 'utf8'))
  } catch (error) {
    return { ...空, 最后诊断: '状态文件读不出来，按空状态继续：' + ((error && error.message) || error) }
  }
  if (!o || typeof o !== 'object') return 空
  const 迁 = 迁移旧游标(o)
  const 水位 = {}
  for (const [k, v] of Object.entries(迁.文件水位 || {})) {
    if (k === '__迁移标记') continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) 水位[k] = Math.floor(n)
  }
  let 待迁 = null
  if (迁.待迁移旧游标 && typeof 迁.待迁移旧游标 === 'object') {
    待迁 = {
      文件: String(迁.待迁移旧游标.文件 || ''),
      行: Math.max(0, Math.floor(Number(迁.待迁移旧游标.行) || 0)),
    }
  }
  return {
    ...空,
    ...迁,
    文件水位: 水位,
    待迁移旧游标: 待迁,
    最后关闭: { ...空.最后关闭, ...(迁.最后关闭 || {}) },
    session: 空.session,
    schemaVersion: 2,
  }
}

/**
 * 写状态（原子）。
 * @returns {{ok:boolean, error:string}} —— 调用方要能知道「没写进去」
 */
export function 写状态(session, 状态) {
  const p = 状态路径(session)
  if (!p) return { ok: false, error: '会话 id 不合法' }
  let 文本 = ''
  try {
    const 净 = { ...空状态(session), ...状态, session: String(session || '') }
    delete 净.游标
    净.schemaVersion = 2
    // 待迁移元数据为 null / 空对象时不写进文件（保持状态干净）
    const 待迁 = 净.待迁移旧游标
    if (!待迁 || typeof 待迁 !== 'object' || (!待迁.文件 && !Number(待迁.行))) {
      净.待迁移旧游标 = null
    } else {
      净.待迁移旧游标 = {
        文件: String(待迁.文件 || ''),
        行: Math.max(0, Math.floor(Number(待迁.行) || 0)),
      }
    }
    文本 = JSON.stringify(净, null, 2)
  } catch (error) {
    return { ok: false, error: '状态序列化失败：' + ((error && error.message) || error) }
  }
  return 原子写(p, 文本 + '\n')
}

// ── 事件卡 ────────────────────────────────────────────────────────

function 会话事件文件(session, ms) {
  const 目录 = 会话事件目录(session)
  if (!目录) return ''
  return join(目录, 月键(ms) + '.jsonl')
}

/** 读某个会话的全部事件卡。坏行跳过。 */
export function 读事件(session) {
  const 目录 = 会话事件目录(session)
  if (!目录 || !existsSync(目录)) return []
  const 出 = []
  let 文件们 = []
  try {
    文件们 = readdirSync(目录).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()
  } catch (error) {
    return []
  }
  for (const f of 文件们) {
    let 行们 = []
    try {
      行们 = readFileSync(join(目录, f), 'utf8').split('\n')
    } catch (error) {
      continue
    }
    for (const 原 of 行们) {
      const s = 原.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && typeof o === 'object' && o.eventId) 出.push(o)
      } catch (error) { /* 坏行跳过 */ }
    }
  }
  return 出
}

/** 这个会话里已经有哪些 eventId（幂等用） */
export function 已有事件id(session) {
  return new Set(读事件(session).map((x) => String(x.eventId || '')))
}

/**
 * 写一张事件卡。
 *
 * ⭐ 2026-11-02 边界修复：返回值从 boolean 改成结构化结果。
 *   调用方要靠它区分三种情况，boolean 分不清：
 *     · 真的写进去了        → {ok:true, written:true,  duplicate:false}
 *     · 同 eventId 已存在   → {ok:true, written:false, duplicate:true}   ← 也算**已持久化**
 *     · 真的写失败了        → {ok:false, written:false, duplicate:false, error:'...'}
 *   只有前两种可以推进状态；第三种绝对不能推进游标，否则这张卡就永久丢了。
 *
 * @returns {{ok:boolean, written:boolean, duplicate:boolean, error:string}}
 */
export function 写事件卡(卡) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  const o = 卡 || {}
  const session = String(o.session || '')
  const eventId = String(o.eventId || '')
  if (!session) return 失败('卡片没有 session')
  if (!eventId) return 失败('卡片没有 eventId')

  // 幂等第一道：内存里查同 eventId
  let 已有 = new Set()
  try {
    已有 = 已有事件id(session)
  } catch (error) {
    return 失败('读已有事件卡失败：' + ((error && error.message) || error))
  }
  if (已有.has(eventId)) {
    // 已经存在 = 已经持久化成功，**不是**失败
    return { ok: true, written: false, duplicate: true, error: '' }
  }

  const 时间 = Date.parse(o.endAt) || Date.now()
  const p = 会话事件文件(session, 时间)
  if (!p) return 失败('算不出事件卡文件路径')

  let 旧 = ''
  try {
    mkdirSync(join(p, '..'), { recursive: true })
    旧 = existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch (error) {
    return 失败('准备事件卡目录失败：' + ((error && error.message) || error))
  }

  const 分隔 = 旧 && !旧.endsWith('\n') ? '\n' : ''
  const r = 原子写(p, 旧 + 分隔 + JSON.stringify(o) + '\n')
  if (!r.ok) return 失败('写事件卡文件失败：' + r.error)
  return { ok: true, written: true, duplicate: false, error: '' }
}

/** 最近 N 张卡，按 endAt 从新到旧 */
export function 最近事件(session, n = 20) {
  const 限 = Math.max(1, Math.min(Number(n) || 20, 500))
  return 读事件(session)
    .map((x) => ({ x, t: Date.parse(x.endAt) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : 0
      const bt = Number.isFinite(b.t) ? b.t : 0
      return bt - at
    })
    .slice(0, 限)
    .map((v) => v.x)
}

/** 事件层概况 —— 给诊断接口用 */
export function 事件概况(session) {
  const 目录 = 会话事件目录(session)
  const 卡们 = 读事件(session)
  const 状态 = 读状态(session)
  return {
    session,
    scope: 卡们.length ? 卡们[卡们.length - 1].scope : '',
    目录,
    事件数: 卡们.length,
    文件水位: 状态.文件水位,
    open: 状态.open ? {
      消息数: (状态.open.消息 || []).length,
      起: 状态.open.起 || '',
      止: 状态.open.止 || '',
    } : null,
    连败: 状态.连败,
    最后成功: 状态.最后成功,
    最后诊断: 状态.最后诊断,
  }
}

export const 事件根目录 = 事件根
export const 状态根目录 = 状态根
