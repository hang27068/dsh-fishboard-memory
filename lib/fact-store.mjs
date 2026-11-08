// 长期事实层存储（fact store）—— 五层记忆的**第三层**
//
// ⭐ 2026-11-02 当前用户定的第三阶段：从「已经关闭的事件卡」里提取原子化、
//   可追溯、可更新的长期事实。本阶段**只影子运行**：
//     · 提取事实，但不注入模型上下文
//     · 不参与召回
//     · 不改人格包、不改旧记忆库、不改 raw、不改 events、不改 QQ 桥
//     · 不主动发起对话
//
// 位置：
//   长期事实 ~/.dsh/fish-memory-v2/facts/<会话ID>.jsonl
//   运行状态 ~/.dsh/fish-memory-v2/fact-state/<会话ID>.json
//   冲突记录 ~/.dsh/fish-memory-v2/fact-conflicts/<会话ID>.jsonl
//
// ⚠ 硬约束：
//   1. **只读** events 目录。绝不从 session 消息 / assistant-message / 模型上下文 /
//      压缩摘要 / 诊断日志 / 旧记忆库 / 当前 open 事件取任何内容。
//   2. 写失败只记账，绝不往上抛 —— 事实层坏了不能连累 QQ 收发和聊天。
//   3. 状态一律「临时文件 + rename」原子替换。
//   4. 事实文件是**追加式日志**，同一个 factId 可能出现多行（更新会产生新版本），
//      读的时候按 factId 折叠、**最后一行赢**。这样不用整份重写，也不会写坏。
//
// ⭐ 为什么事实文件用「追加 + 折叠」而不是整份重写：
//   整份重写要先读出全部再写回，中途失败会把历史事实弄丢。
//   追加一行是一次的、单向的操作；折叠规则让「同一事实的最新版本」永远明确。

import {
  mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const 事实根 = join(CFG_DIR, 'fish-memory-v2', 'facts')
const 状态根 = join(CFG_DIR, 'fish-memory-v2', 'fact-state')
const 冲突根 = join(CFG_DIR, 'fish-memory-v2', 'fact-conflicts')

/** 会话 id 消毒 —— 挡掉路径穿越，别让脏 id 写出目录外 */
function 干净会话(session) {
  return String(session || '').replace(/[^A-Za-z0-9_-]/g, '')
}

function 事实路径(session) {
  const 干净 = 干净会话(session)
  if (!干净) return ''
  return join(事实根, 干净 + '.jsonl')
}

function 状态路径(session) {
  const 干净 = 干净会话(session)
  if (!干净) return ''
  return join(状态根, 干净 + '.json')
}

function 冲突路径(session) {
  const 干净 = 干净会话(session)
  if (!干净) return ''
  return join(冲突根, 干净 + '.jsonl')
}

/**
 * 原子写一个文件：先写 `<路径>.tmp-<随机>`，再 rename 顶上去。
 * rename 在同一分区上是原子的 —— 中途掉电只会剩一个没人用的临时文件。
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
 * 一个会话的事实层初始状态。
 *
 * `文件水位` 沿用第二层的思路：**每个事件月文件独立记物理行号**。
 * 单一游标发现不了「已经处理到 2026-11 之后，又往 2026-10 追加了迟到事件」。
 */
export function 空状态(session) {
  return {
    schemaVersion: 1,
    session: String(session || ''),
    // { '2026-11.jsonl': 12, '2026-10.jsonl': 5 }
    文件水位: {},
    // 连续模型/校验失败次数
    连败: 0,
    最后成功: '',
    最后尝试: '',
    最后诊断: '',
  }
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
    return { ...空, 最后诊断: '事实层状态文件读不出来，按空状态继续：' + ((error && error.message) || error) }
  }
  if (!o || typeof o !== 'object') return 空
  const 水位 = {}
  const 源 = o.文件水位 && typeof o.文件水位 === 'object' ? o.文件水位 : {}
  for (const [k, v] of Object.entries(源)) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) 水位[k] = Math.floor(n)
  }
  return {
    ...空,
    ...o,
    文件水位: 水位,
    session: 空.session,
    schemaVersion: 1,
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
    const 净 = { ...空状态(session), ...(状态 || {}), session: String(session || '') }
    净.schemaVersion = 1
    文本 = JSON.stringify(净, null, 2)
  } catch (error) {
    return { ok: false, error: '状态序列化失败：' + ((error && error.message) || error) }
  }
  return 原子写(p, 文本 + '\n')
}

// ── 事实 ──────────────────────────────────────────────────────────

/**
 * 读某个会话的全部事实（已按 factId 折叠，保留最新版本）。
 *
 * 规则：同一个 factId 在文件里出现多次时，**后面的版本覆盖前面的**。
 * 坏行跳过，不影响后面的行。
 *
 * @returns {Array} 事实数组，按「文件中第一次出现」的顺序
 */
export function 读事实(session) {
  const p = 事实路径(session)
  if (!p || !existsSync(p)) return []
  let 原 = ''
  try {
    原 = readFileSync(p, 'utf8')
  } catch (error) {
    return []
  }
  const 顺序 = []
  const 表 = new Map()
  for (const 行 of 原.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    let o = null
    try {
      o = JSON.parse(s)
    } catch (error) {
      continue   // 坏行跳过
    }
    if (!o || typeof o !== 'object' || !o.factId) continue
    const id = String(o.factId)
    if (!表.has(id)) 顺序.push(id)
    表.set(id, o)     // 后出现的赢
  }
  return 顺序.map((id) => 表.get(id))
}

/** 这个会话里已经有哪些 factId */
export function 已有事实id(session) {
  return new Set(读事实(session).map((x) => String(x.factId || '')))
}

/**
 * 写一条事实（追加一个版本）。
 *
 * ⭐ 幂等：如果文件里该 factId 的最新版本和这次要写的**完全一样**，
 *   就当作「已存在」，不重复追加。这样重跑不会把事实文件撑爆。
 *
 * @returns {{ok:boolean, written:boolean, duplicate:boolean, error:string}}
 */
export function 写事实(session, 事实) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  if (!事实 || typeof 事实 !== 'object') return 失败('事实不是对象')
  if (!事实.factId) return 失败('事实没有 factId')

  const p = 事实路径(session)
  if (!p) return 失败('算不出事实文件路径')

  // 先看现有版本 —— 内容一模一样就不重复写
  let 现有 = ''
  try {
    现有 = existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch (error) {
    return 失败('读现有事实文件失败：' + ((error && error.message) || error))
  }
  const 当前版本 = (() => {
    const 表 = new Map()
    for (const 行 of 现有.split('\n')) {
      const s = 行.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && o.factId) 表.set(String(o.factId), o)
      } catch (error) { /* 坏行跳过 */ }
    }
    return 表.get(String(事实.factId)) || null
  })()

  let 新文本 = ''
  try {
    新文本 = JSON.stringify(事实)
  } catch (error) {
    return 失败('事实序列化失败：' + ((error && error.message) || error))
  }

  if (当前版本) {
    let 旧文本 = ''
    try {
      旧文本 = JSON.stringify(当前版本)
    } catch (error) { 旧文本 = '' }
    if (旧文本 && 旧文本 === 新文本) {
      return { ok: true, written: false, duplicate: true, error: '' }
    }
  }

  try {
    mkdirSync(join(p, '..'), { recursive: true })
  } catch (error) {
    /* 目录可能已存在 */
  }
  const 分隔 = 现有 && !现有.endsWith('\n') ? '\n' : ''
  const r = 原子写(p, 现有 + 分隔 + 新文本 + '\n')
  if (!r.ok) return 失败('写事实文件失败：' + r.error)
  return { ok: true, written: true, duplicate: false, error: '' }
}

// ── 冲突 ──────────────────────────────────────────────────────────

/** 读某个会话的全部冲突记录 */
export function 读冲突(session) {
  const p = 冲突路径(session)
  if (!p || !existsSync(p)) return []
  let 原 = ''
  try {
    原 = readFileSync(p, 'utf8')
  } catch (error) {
    return []
  }
  const 出 = []
  const 见 = new Set()
  for (const 行 of 原.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    let o = null
    try {
      o = JSON.parse(s)
    } catch (error) {
      continue
    }
    if (!o || typeof o !== 'object' || !o.conflictId) continue
    if (见.has(o.conflictId)) continue
    见.add(o.conflictId)
    出.push(o)
  }
  return 出
}

/**
 * 写一条冲突记录（追加）。
 *
 * ⭐ 同一个 conflictId 只写一次 —— 重跑不会把冲突文件刷成一堆重复行。
 *
 * @returns {{ok:boolean, written:boolean, duplicate:boolean, error:string}}
 */
export function 写冲突(session, 冲突) {
  const 失败 = (error) => ({ ok: false, written: false, duplicate: false, error: String(error || '') })
  if (!冲突 || typeof 冲突 !== 'object') return 失败('冲突记录不是对象')
  if (!冲突.conflictId) return 失败('冲突记录没有 conflictId')

  const p = 冲突路径(session)
  if (!p) return 失败('算不出冲突文件路径')

  if (读冲突(session).some((x) => x.conflictId === 冲突.conflictId)) {
    return { ok: true, written: false, duplicate: true, error: '' }
  }

  let 旧 = ''
  try {
    旧 = existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch (error) {
    return 失败('读现有冲突文件失败：' + ((error && error.message) || error))
  }
  let 文本 = ''
  try {
    文本 = JSON.stringify(冲突)
  } catch (error) {
    return 失败('冲突记录序列化失败：' + ((error && error.message) || error))
  }
  const 分隔 = 旧 && !旧.endsWith('\n') ? '\n' : ''
  const r = 原子写(p, 旧 + 分隔 + 文本 + '\n')
  if (!r.ok) return 失败('写冲突文件失败：' + r.error)
  return { ok: true, written: true, duplicate: false, error: '' }
}

// ── 概况 ──────────────────────────────────────────────────────────

/** 事实层概况 —— 给诊断接口用 */
export function 事实概况(session) {
  const 事实们 = 读事实(session)
  const 状态 = 读状态(session)
  const 按状态 = {}
  const 按类别 = {}
  for (const f of 事实们) {
    const s = String(f.status || '')
    const c = String(f.category || '')
    按状态[s] = (按状态[s] || 0) + 1
    按类别[c] = (按类别[c] || 0) + 1
  }
  return {
    session,
    目录: 事实路径(session),
    事实数: 事实们.length,
    按状态,
    按类别,
    冲突数: 读冲突(session).length,
    文件水位: 状态.文件水位,
    连败: 状态.连败,
    最后成功: 状态.最后成功,
    最后诊断: 状态.最后诊断,
  }
}

export { 事实根, 状态根, 冲突根 }

