// 私聊严格事实「正式写入」双阶段入口（B3B production）
//
// 目的：给私聊严格路径一个**独立的手动正式入口**，
//       和现有 /facts/run（legacy）彻底分开，避免误操作旧接口。
//
// ══════════════════════════════════════════════════════════════
// 当前用户定的硬边界（本模块逐条落实）
// ══════════════════════════════════════════════════════════════
//
//   1. 不调用现有正式 /facts/run —— 旧入口行为一个字节不改
//   2. 配置缺段 = 关闭；enabled 只认字面 true
//   3. sessions 必须**原始字符串精确匹配**
//   4. 模型必须显式用本段的 model，绝不走 llmModel / agent 默认 / 会话路由
//   5. 两阶段：preview 只跑模型不落盘；commit 只落盘不再跑模型
//   6. preview 缓存在进程内存，DSH 重启即消失（这是正确行为）
//   7. commit 前必须核对四个基线 SHA，变了就 409，不自动合并
//   8. previewId 一次性，成功或失败都失效
//   9. 没有自动触发、没有定时器、没有消息钩子 —— 唯一入口是 HTTP
//
// ⚠⚠ 本模块**不含任何事实提取算法**。
//   「准备」阶段复用 fact-builder 的 跑一轮（纯计算，不写盘），
//   「提交」阶段复用 fact-builder 的 落盘一轮（只写盘，不调模型）。
//   把算法抄一份到这儿 = 两套实现将来必然漂移，这一层只做接线与边界。

import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const V2 = join(CFG_DIR, 'fish-memory-v2')

// ── 正式数据路径（只读基线用） ─────────────────────
const 事实根 = join(V2, 'facts')
const 事实状态根 = join(V2, 'fact-state')
const 事件根 = join(V2, 'events')
const 事件状态根 = join(V2, 'event-state')

/** confirm 口令：**必须逐字相等**，不做 trim、不忽略大小写 */
export const 确认口令 = 'WRITE_PRIVATE_STRICT_FACTS'

/** preview 有效期上限（当前用户指定：最多 10 分钟） */
export const PREVIEW_TTL_MS = 10 * 60 * 1000

// ── 进程内存里的 preview 缓存 ───────────────────────
//
// ⚠ 故意用模块级 Map：DSH 重启后自然清空，不需要任何持久化。
//   写进磁盘反而错 —— 那样重启后还能拿旧 preview 提交，
//   而它对应的基线早已过期。
const 预览们 = new Map()

/** previewId 空间：128 bit 随机，不可预测 */
function 造预览id() {
  return randomBytes(16).toString('hex')
}

/** 现在有几个活动 preview（state 用） */
export function 活动预览数() {
  const 现在 = Date.now()
  let n = 0
  for (const [id, p] of 预览们) {
    if (p.过期时刻 <= 现在) { 预览们.delete(id); continue }
    n += 1
  }
  return n
}

/** 正在跑 preview/commit 的会话（供 state 显示 + 单飞判断） */
export function 生产正在跑的会话() {
  return [...生产正在跑]
}
const 生产正在跑 = new Set()

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

const 默认配置 = Object.freeze({
  enabled: false,
  sessions: [],
  model: null,
})

/**
 * 读 `privateStrictProduction` 段。
 *
 * ⚠ fail closed：配置坏了 / 段缺失 / 读不出来 → 一律当作**关闭**。
 *   绝不能因为文件坏了就「按默认打开」。
 *
 * ⚠ enabled 只认 `段.enabled === true`。
 *   字符串 "true"、数字 1、对象 {} 全部当关闭。
 */
export function 读生产配置(配置路径 = null) {
  const p = 配置路径 || join(CFG_DIR, 'fish-memory-config.json')
  if (!existsSync(p)) return { ...默认配置, 配置来源: p, 配置状态: '配置文件不存在' }
  let raw = null
  try {
    raw = JSON.parse(读配置文本(p))
  } catch (error) {
    return { ...默认配置, 配置来源: p, 配置状态: '配置文件读不了：' + String((error && error.message) || error) }
  }
  const 段 = raw && typeof raw === 'object' ? raw.privateStrictProduction : null
  if (!段 || typeof 段 !== 'object') {
    return { ...默认配置, 配置来源: p, 配置状态: '没有 privateStrictProduction 段（视为关闭）' }
  }

  const enabled = 段.enabled === true

  // ⚠⚠ 白名单：**原始字符串原样收**，一个字符都不删、不 trim。
  //   上一代 shadow 模块踩过「消毒后撞车」的坑，这里不重犯。
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
      if (!s) { 拒收名单.push({ 值: '', 原因: '空字符串' }); continue }
      if (s.includes('/') || s.includes('\\') || s.includes('\0') || s === '.' || s === '..') {
        拒收名单.push({ 值: s, 原因: '含路径分隔符或上跳' })
        continue
      }
      if (!名单.includes(s)) 名单.push(s)
    }
  }

  // ⚠ 模型必须显式给全。缺 provider 或 model 任一个 → model = null
  //   → 该跑判定直接拒绝。绝不回退到 llmModel / agent 默认 / 全局默认。
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

/**
 * 判定这个会话能不能走正式入口。
 *
 * ⚠ 三层，缺一不可：
 *   ① enabled 严格 true
 *   ② session 与白名单项**逐字节**相等
 *   ③ model 显式配置齐全
 */
export function 该跑生产(配置, session) {
  const cfg = 配置 || 默认配置
  if (!cfg.enabled) {
    return { 可: false, 原因: '私聊严格正式入口没开（privateStrictProduction.enabled 必须严格为 true）' }
  }
  if (!cfg.model) {
    return { 可: false, 原因: '没有配置专用模型（privateStrictProduction.model 需要 provider 与 model）' }
  }
  const 会 = String(session == null ? '' : session)
  if (!会) return { 可: false, 原因: '没有 session' }
  // ⚠ 精确比较，不做任何规范化
  const 中 = (cfg.sessions || []).some((s) => s === 会)
  if (!中) {
    return {
      可: false,
      原因: '这个会话不在 privateStrictProduction.sessions 白名单里',
      白名单条数: (cfg.sessions || []).length,
    }
  }
  return { 可: true, 原因: '', 模型: cfg.model }
}

// ── 基线：四个 SHA + 两个计数 ────────────────────────

function sha文件(路径) {
  try {
    if (!existsSync(路径)) return { 存在: false, sha256: '' }
    return { 存在: true, sha256: createHash('sha256').update(readFileSync(路径)).digest('hex') }
  } catch (error) {
    return { 存在: false, sha256: '', 错: String((error && error.message) || error) }
  }
}

/** 数一个目录下 `<session>.jsonl` 的行数（不存在算 0） */
function 数行(路径) {
  try {
    if (!existsSync(路径)) return 0
    const 文 = readFileSync(路径, 'utf8')
    let n = 0
    for (const 行 of 文.split('\n')) if (行.trim()) n += 1
    return n
  } catch (error) {
    return 0
  }
}

/**
 * 拍一次基线快照。
 *
 * ⚠ 这就是 commit 时要比对的那份。四项 SHA 缺一不可 ——
 *   少了任何一项，就可能出现「事件没变但事实被别的进程改了」
 *   仍然提交成功的情况，那等于带病写入。
 */
export function 拍基线(session) {
  const 会 = String(session || '')
  const 事 = sha文件(join(事件根, 会, '2026-11.jsonl'))
  // ⚠ 事件可能跨月：取该会话事件目录下所有 jsonl 的合并哈希，
  //   否则跨月时基线只覆盖一个月，另一月被改也发现不了。
  let 事件合并 = ''
  try {
    const 目录 = join(事件根, 会)
    if (existsSync(目录)) {
      const 文们 = readdirSync(目录).filter((f) => f.endsWith('.jsonl')).sort()
      const 合 = createHash('sha256')
      for (const f of 文们) {
        合.update(f)
        合.update(readFileSync(join(目录, f)))
      }
      事件合并 = 合.digest('hex')
    }
  } catch (error) { /* 读不了就当空 */ }

  return {
    events: 事.sha256,
    eventsAll: 事件合并,
    eventState: sha文件(join(事件状态根, 会 + '.json')).sha256,
    facts: sha文件(join(事实根, 会 + '.jsonl')).sha256,
    factState: sha文件(join(事实状态根, 会 + '.json')).sha256,
    eventsCount: 数行(join(事件根, 会, '2026-11.jsonl')),
    factsCount: 数行(join(事实根, 会 + '.jsonl')),
  }
}

/** 基线的可比较部分（用于判定是否变化） */
export function 基线一致吗(a, b) {
  if (!a || !b) return false
  for (const k of ['events', 'eventsAll', 'eventState', 'facts', 'factState']) {
    if (String(a[k] || '') !== String(b[k] || '')) return { 一致: false, 变了: k }
  }
  return { 一致: true, 变了: '' }
}

// ── 候选清洗 ─────────────────────────────────────────

/** 候选 value 展示上限。候选事实本身要能审核，所以留，但要截断。 */
const 拒绝值上限 = 300
/** 拒绝原因展示上限。只放受控截断后的 reason，绝不放裁判原文全文。 */
const 拒绝原因上限 = 200

/** 单行化 + 硬截断。控制字符转义，避免把换行带进响应。 */
function 压一行(值, 上限) {
  const t = String(值 == null ? '' : 值)
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  return t.length > 上限 ? t.slice(0, 上限) : t
}

/**
 * 「仅事件」的拒绝码集合。
 *
 * ⚠ 这些码在 fact-builder 里都进 拒绝审计们，但语义是 event_only 不是 reject。
 *   来源（fact-builder 现行）：
 *     event_only                          → 语义裁判判 event_only（L5093）
 *     strict_episodic_answer_event_only   → 单次情境闸门（L338）
 *     strict_event_only_predicate         → 严格边界 predicate（L2213）
 *     strict_category_event_only          → 严格边界 category（L4756）
 *     strict_temporary_event_only         → 临时状态（L4766）
 */
const 仅事件码们 = new Set([
  'event_only',
  'strict_episodic_answer_event_only',
  'strict_event_only_predicate',
  'strict_category_event_only',
  'strict_temporary_event_only',
])

/**
 * 把一轮结果清洗成可返回的候选摘要。
 *
 * ⚠⚠ 白名单式构造，不是黑名单式过滤。
 *   只挑明确列出的字段，模型原始输出 / 原句 / 提示词
 *   自然就不会漏出去 —— 黑名单永远会漏。
 *
 * ⭐⭐ 2026-11-08 B3B（第六次 preview 后）：修可观测性。
 *
 *   病根：旧版「拒绝」读的是 轮结果.候选审计们 ——
 *     那是**语义准入通过后**的候选快照，不是拒绝集合。
 *     于是结构校验拒的、语义裁判拒的、边界判 event_only 的
 *     三类候选**两头都不在**（既不在 事实们，也不在 候选审计们），
 *     响应就成了「接受 0 / 拒绝 0」，无法解释。
 *
 *   修法：只**读**fact-builder 已经算好的结果，不重算任何判定：
 *     · 接受      ← 轮结果.事实们（不变）
 *     · 拒绝      ← 轮结果.拒绝审计们，滤掉 event_only 码
 *     · 仅事件    ← 轮结果.拒绝审计们，只留 event_only 码
 *     · 候选审计  ← 轮结果.候选审计们（带关系裁定，标注 resultType）
 *     · 流水线统计 ← 轮结果.批次统计（原样透传，不重算）
 *
 *   ⚠ 不改任何候选判定 / 归并 / 水位 / 写入。只换「读哪个字段」。
 */
export function 清洗候选(轮结果) {
  const 接受 = []
  const 拒绝 = []
  const 仅事件 = []

  const 事实们 = (轮结果 && Array.isArray(轮结果.事实们)) ? 轮结果.事实们 : []
  for (const f of 事实们) {
    接受.push({
      factId: String(f.factId || ''),
      subject: String(f.subject || ''),
      subjectId: String(f.subjectId || ''),
      predicate: String(f.predicate || ''),
      value: String(f.value == null ? '' : f.value),
      category: String(f.category || ''),
      confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null,
      durability: String(f.durability || ''),
      // ⚠ 落盘事实的字段名是 sourceEventIds（fact-builder L2886），
      //   不是 eventIds —— 候对象上才叫 eventIds。两个都收，别只认一个。
      sourceEventIds: [...(f.sourceEventIds || f.eventIds || [])].map(String),
      sourceMessageIds: [...(f.sourceMessageIds || f.messageIds || [])].map(String),
      evidenceMessageIds: [...(f.evidenceMessageIds || [])].map(String),
      结果: 'accept',
    })
  }
  const 已接受id = new Set(接受.map((x) => x.factId).filter(Boolean))

  // ── 拒绝 / 仅事件：读 拒绝审计们（这才是完整拒绝集合） ────────────
  //
  // ⚠ 拒绝审计们的形状（fact-builder 四处 push）：
  //     { 批序, 事件ids, 候选序号, 码, 说, 候选摘要, 来源? }
  //   候选摘要 可能是 null（非对象候选），也可能缺 subjectId（边界仅事件）。
  //   来源 只有语义准入 / 严格边界两处会给；结构校验那条没有这个字段 ——
  //   按当前用户的规矩「没有就返回空值」，这里不做推断。
  const 拒绝审计们 = (轮结果 && Array.isArray(轮结果.拒绝审计们)) ? 轮结果.拒绝审计们 : []
  for (const r of 拒绝审计们) {
    const 码 = String((r && r.码) || '')
    const 摘 = (r && r.候选摘要 && typeof r.候选摘要 === 'object') ? r.候选摘要 : {}
    const 条 = {
      batchNumber: Number.isFinite(Number(r && r.批序)) ? Number(r.批序) : 0,
      source: String((r && r.来源) || ''),
      rejectionCode: 码,
      predicate: String(摘.predicate || ''),
      value: 压一行(摘.value, 拒绝值上限),
      subjectId: String(摘.subjectId || ''),
      eventIds: [...((r && r.事件ids) || [])].map(String),
      candidateIndex: Number.isFinite(Number(r && r.候选序号)) ? Number(r.候选序号) : 0,
      // 受控截断的说明。⚠ 只放 说（已经是一句话的人话），不放裁判原文全文。
      reason: 压一行(r && r.说, 拒绝原因上限),
    }
    if (仅事件码们.has(码)) 仅事件.push({ ...条, 结果: 'event_only' })
    else 拒绝.push({ ...条, 结果: 'reject' })
  }

  // ── 候选审计：语义准入通过但最终没写进去的，单独展示 ──────────────
  //
  // ⚠ 这些**不再**计进 拒绝 —— 它们不是被拒，是「过了裁判但没落成事实」。
  //   典型是关系裁判判 uncertain（fact-builder L3884-3896 把它从语义候选里拆掉）。
  //   第六次 preview 那种「静默消失」就是这里漏出来的。
  const 审计源 = (轮结果 && Array.isArray(轮结果.候选审计们)) ? 轮结果.候选审计们 : []
  const 候选审计 = []
  for (const c of 审计源) {
    const id = String((c && c.拟factId) || '')
    const 关 = c && c.关系 && typeof c.关系 === 'object' ? c.关系 : null
    const 判定 = String((关 && 关.decision) || '')
    // resultType 全部直接读自既有数据，不猜：
    //   有 factId 且已接受        → accepted
    //   关系裁定是 uncertain      → uncertain
    //   其余（过了准入但没写入）  → not_written
    let resultType = 'not_written'
    if (id && 已接受id.has(id)) resultType = 'accepted'
    else if (判定 === 'uncertain') resultType = 'uncertain'
    候选审计.push({
      factId: id,
      predicate: String((c && c.predicate) || ''),
      value: 压一行(c && c.value, 拒绝值上限),
      subjectId: String((c && c.subjectId) || ''),
      category: String((c && c.category) || ''),
      eventIds: [...((c && c.证据事件ids) || [])].map(String),
      evidenceMessageIds: [...((c && c.证据消息ids) || [])].map(String),
      relationDecision: 判定,
      existingFactId: String((关 && 关.existingFactId) || ''),
      relationReason: 压一行(关 && 关.reason, 拒绝原因上限),
      resultType,
    })
  }

  // ── 流水线统计：原样透传 批次统计，一个数都不重算 ────────────────
  //
  // ⚠⚠ 口径提醒（这是 fact-builder 现行行为，本层不改）：
  //   批次统计.rejectedCandidates = 拒绝审计们.length（fact-builder L3937），
  //   而 拒绝审计们 里**包含 event_only 条目**。
  //   所以 流水线统计.rejectedCandidates ≠ 拒绝.length。
  //   两个数都给出来，别让下游猜。
  const 批 = (轮结果 && 轮结果.批次统计 && typeof 轮结果.批次统计 === 'object')
    ? 轮结果.批次统计 : {}
  const 取数 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const 终态明细 = Array.isArray(批.批终态明细) ? 批.批终态明细 : []
  const 流水线统计 = {
    rawCandidates: 取数(批.rawCandidates),
    acceptedCandidates: 取数(批.acceptedCandidates),
    repairedCandidates: 取数(批.repairedCandidates),
    rejectedCandidates: 取数(批.rejectedCandidates),
    eventOnlyCandidates: 取数(批.eventOnlyCandidates),
    emptyBatches: 取数(批.emptyBatches),
    terminalRejectedBatches: 取数(批.terminalRejectedBatches),
    failedBatches: 取数(批.failedBatches),
    rejectionCodes: (批.rejectionCodes && typeof 批.rejectionCodes === 'object')
      ? Object.fromEntries(Object.entries(批.rejectionCodes).map(([k, v]) => [String(k), 取数(v)]))
      : {},
    batchStates: 终态明细.map((x) => ({
      batchNumber: 取数(x && x.批序),
      terminalState: String((x && x.终态) || ''),
      candidateCount: 取数(x && x.候选数),
      rejectionCount: 取数(x && x.拒绝数),
      eventIds: [...((x && x.事件ids) || [])].map(String),
    })),
  }

  return {
    接受们: 接受,
    拒绝们: 拒绝,
    仅事件们: 仅事件,
    候选审计,
    流水线统计,
    // 本层清洗后的条数（供响应体做自洽对账，与上面数组严格对应）
    计数: {
      接受: 接受.length,
      拒绝: 拒绝.length,
      仅事件: 仅事件.length,
      候选审计: 候选审计.length,
      拒绝审计原始条数: 拒绝审计们.length,
    },
  }
}

// ── A 阶段：准备（跑模型，不落盘） ───────────────────

/**
 * 准备一轮严格结果。**绝不写盘**。
 *
 * ⚠ 复用 fact-builder 的 跑一轮 —— 不复制算法。
 *   跑一轮 的契约本身就是「纯计算，返回 事实们/冲突们/状态」，
 *   落盘是另一个函数（落盘一轮）。所以这里天然不需要动它。
 *
 * @param {object} 参
 *   { session, 配置, 模型回调, 四个裁判回调, 读消息, 跑一轮实现, 现在 }
 */
export async function 准备严格结果(参) {
  const {
    session, 模型回调, 读消息 = null, 跑一轮实现, 现在 = Date.now(),
    语义裁判回调 = null, 关系裁判回调 = null, 映射裁判回调 = null, 证据修复回调 = null,
    状态 = null, 读事实 = null,
  } = 参

  if (typeof 跑一轮实现 !== 'function') {
    return { ok: false, 说: '缺少 跑一轮 实现', 一层结果: null }
  }
  if (typeof 模型回调 !== 'function') {
    return { ok: false, 说: '缺少模型回调', 一层结果: null }
  }

  const 会 = String(session || '')

  let 轮结果 = null
  let 崩了 = ''
  try {
    轮结果 = await 跑一轮实现({
      事件根,
      session: 会,
      状态: 状态 || undefined,
      现在,
      读消息,
      模型回调,
      // ⚠ 四个裁判必须接齐 —— 严格路径下缺任何一个都会 fail closed，
      //   那样「跑得通但一条也不接受」，看起来像没数据，其实是没接线。
      语义裁判回调: 语义裁判回调 || 模型回调,
      关系裁判回调: 关系裁判回调 || 模型回调,
      映射裁判回调: 映射裁判回调 || 模型回调,
      证据修复回调: 证据修复回调 || 模型回调,
      // ⚠⚠ 严格开关：这一行决定走 B3B 严格路径
      privateStrict: true,
      // ⭐⭐ 2026-11-08：主提炼失败时留模型原始输出的结构快照。
      //   只在这里开 —— 这是唯一「失败诊断只回到这次 HTTP 响应、不被写盘」
      //   的调用路径。shadow 的同名调用不开（它的 诊断 会落 shadow audit），
      //   主链路 / legacy / 群聊也不开（诊断会落 fact-state 的 最后诊断）。
      主提炼失败详情: true,
      // ⭐⭐ 2026-11-08 B3B（第三次真实 preview 后）：语义裁判格式失败时
      //   同样留裁判原始输出的结构快照。
      //   ⚠ 与上一行是**两个独立开关**，各管一层：
      //     主提炼失败详情 → 主提炼输出校验失败
      //     语义裁判失败详情 → 语义裁判 semantic_judge_format
      //   ⚠ 只在这里开。shadow 的同名调用不开（它的 诊断 会落 shadow audit），
      //     legacy / 群聊 / 旧 /facts/run 也不开（诊断会落 fact-state 的最后诊断）。
      语义裁判失败详情: true,
      // ⚠ 读的是**正式**现有事实（这里就是要写正式库，不是 shadow）
      ...(读事实 ? { 读事实 } : {}),
    })
  } catch (error) {
    崩了 = String((error && error.message) || error)
  }

  if (崩了) {
    return { ok: false, 说: '跑一轮 抛错：' + 崩了, 一层结果: null }
  }
  if (!轮结果 || !轮结果.ok) {
    return {
      ok: false,
      说: '跑一轮 未完成：' + String((轮结果 && 轮结果.说) || '未知'),
      一层结果: null,
      诊断: (轮结果 && 轮结果.诊断) || [],
    }
  }

  return { ok: true, 说: '', 一层结果: 轮结果 }
}

// ── preview ──────────────────────────────────────────

/**
 * 跑一次 preview。
 *
 * ⚠ 全程不写正式数据：拍基线 → 跑模型 → 再拍基线 → 比对。
 *   两次基线不一致说明预览期间别的进程动了数据 → 直接失败，
 *   不把这份结果存进缓存（存了就是拿旧数据当基线）。
 */
export async function 跑预览(参) {
  const {
    session, 配置, 模型回调, 读消息 = null, 跑一轮实现, 现在 = Date.now(),
    语义裁判回调 = null, 关系裁判回调 = null, 映射裁判回调 = null, 证据修复回调 = null,
    读状态 = null, 读事实 = null,
  } = 参

  const 会 = String(session == null ? '' : session)
  const 判定 = 该跑生产(配置, 会)
  if (!判定.可) return { ok: false, 码: 403, 说: 判定.原因 }

  // ⚠ 单飞：和 legacy 共用同一套语义（同一 session 同时只能一个任务）
  if (生产正在跑.has(会)) {
    return { ok: false, 码: 409, 正在运行: true, 说: '这个会话已经有严格任务在跑' }
  }
  生产正在跑.add(会)
  try {
    const 前 = 拍基线(会)
    const 旧状态 = typeof 读状态 === 'function' ? 读状态(会) : undefined

    const 备 = await 准备严格结果({
      session: 会, 模型回调, 读消息, 跑一轮实现, 现在,
      语义裁判回调, 关系裁判回调, 映射裁判回调, 证据修复回调,
      状态: 旧状态, 读事实,
    })
    if (!备.ok) return { ok: false, 码: 500, 说: 备.说, 诊断: 备.诊断 || [] }

    const 后 = 拍基线(会)
    const 比 = 基线一致吗(前, 后)
    if (!比.一致) {
      return {
        ok: false, 码: 409,
        说: '预览期间正式数据发生了变化（' + 比.变了 + '），这次结果不采用，请重试',
      }
    }

    // ⚠ 基线再拍一次作为缓存基线（和 后 等价，但语义清楚）
    const previewId = 造预览id()
    const 过期时刻 = 现在 + PREVIEW_TTL_MS
    预览们.set(previewId, {
      session: 会,
      过期时刻,
      基线: 后,
      一轮结果: 备.一层结果,
      旧状态,
      模型: { provider: 判定.模型.provider, model: 判定.模型.model },
      创建时刻: 现在,
    })

    const 清洗 = 清洗候选(备.一层结果)

    return {
      ok: true, 码: 200,
      previewId,
      过期时刻: new Date(过期时刻).toISOString(),
      ttlMs: PREVIEW_TTL_MS,
      session: 会,
      模型: { provider: 判定.模型.provider, model: 判定.模型.model },
      基线: 后,
      候选: 清洗.接受们,
      拒绝: 清洗.拒绝们,
      // ⭐⭐ 2026-11-08 B3B：只增不改。原有 候选/拒绝/汇总 三个字段语义不动，
      //   下面四项是把「已经算出来但没往外传」的信息补上。
      //   ⚠ 拒绝 的含义变了：原来读 候选审计们（语义准入通过后的快照），
      //     现在读 拒绝审计们（真正的拒绝集合）并滤掉 event_only。
      //     这是修复，不是兼容 —— 第六次 preview 的「接受 0 / 拒绝 0」就是旧口径造成的。
      仅事件: 清洗.仅事件们,
      候选审计: 清洗.候选审计,
      流水线统计: 清洗.流水线统计,
      汇总: {
        接受数: 清洗.接受们.length,
        拒绝数: 清洗.拒绝们.length,
        // ⭐ 新增，避免下游再把「拒绝数」当成「全部被拒候选」：
        仅事件数: 清洗.仅事件们.length,
        候选审计数: 清洗.候选审计.length,
        事件数: Number((备.一层结果 && 备.一层结果.事件数) || 0),
        冲突数: Array.isArray(备.一层结果 && 备.一层结果.冲突们)
          ? 备.一层结果.冲突们.length : 0,
        // ⚠ 自洽对账：仅事件 + 拒绝 必须等于 拒绝审计原始条数。
        //   不等就说明本层的分类漏了码，能一眼看出来。
        拒绝审计原始条数: 清洗.计数.拒绝审计原始条数,
        分类自洽: (清洗.计数.拒绝 + 清洗.计数.仅事件) === 清洗.计数.拒绝审计原始条数,
      },
      正式写入: false,   // ⚠ preview 永远不写
    }
  } finally {
    生产正在跑.delete(会)
  }
}

// ── commit ───────────────────────────────────────────

/**
 * 提交一次 preview。
 *
 * ⚠⚠ 十条前置条件全过才允许落盘。任何一条不满足都直接退，
 *   不做「尽力而为」的合并 —— 宁可让用户重来。
 *
 * ⚠ previewId **无论成败都失效**（在 finally 里删）：
 *   写入失败但实际写了一半的情况下，如果 previewId 还能用，
 *   重试会把同一批候选再写一遍，而基线校验看的还是旧快照。
 */
export function 提交预览(参) {
  const {
    session, previewId, confirm, 配置,
    写事实, 写冲突, 写状态, 写拒绝 = null,
    落盘一轮实现, 现在 = Date.now(), 读状态 = null,
  } = 参

  const 会 = String(session == null ? '' : session)

  // ① 配置仍开
  const 判定 = 该跑生产(配置, 会)
  if (!判定.可) return { ok: false, 码: 403, 说: 判定.原因 }

  // ② confirm 严格相等
  if (String(confirm == null ? '' : confirm) !== 确认口令) {
    return {
      ok: false, 码: 400,
      说: 'confirm 必须严格等于 ' + 确认口令,
      正式写入: false,
    }
  }

  // ③ previewId 存在
  const id = String(previewId == null ? '' : previewId)
  const 条 = id ? 预览们.get(id) : null
  if (!条) {
    return { ok: false, 码: 404, 说: 'previewId 不存在或已被使用（previewId 一次性）', 正式写入: false }
  }

  // ④ 未过期 + 与 session 绑定
  // ⚠ 先在内存里判，再决定是否删 —— 过期/错 session 也要删，
  //   否则一个绑定错的 previewId 可以一直被拿来做探测。
  const 现在时刻 = Date.now()
  let 早退 = null
  if (条.过期时刻 <= 现在时刻) {
    早退 = { ok: false, 码: 410, 说: 'previewId 已过期（有效期 ' + PREVIEW_TTL_MS + 'ms）', 正式写入: false }
  } else if (条.session !== 会) {
    早退 = { ok: false, 码: 403, 说: 'previewId 与这个 session 不匹配', 正式写入: false }
  }

  if (早退) {
    预览们.delete(id)
    return 早退
  }

  // ⑤ 基线四项 SHA 必须与 preview 完全一致
  const 当前 = 拍基线(会)
  const 比 = 基线一致吗(条.基线, 当前)
  if (!比.一致) {
    预览们.delete(id)
    return {
      ok: false, 码: 409,
      说: '正式数据在 preview 之后发生了变化（' + 比.变了 + '），拒绝提交。请重新 preview',
      正式写入: false,
      基线: { preview: 条.基线, 当前 },
    }
  }

  // ⑥ 单飞：不能和别的任务并发
  if (生产正在跑.has(会)) {
    return { ok: false, 码: 409, 正在运行: true, 说: '这个会话已经有严格任务在跑', 正式写入: false }
  }
  生产正在跑.add(会)

  try {
    // ⑦ 只落 preview 里缓存的那一份，**绝不重新跑模型**
    if (typeof 落盘一轮实现 !== 'function') {
      预览们.delete(id)
      return { ok: false, 码: 500, 说: '缺少 落盘一轮 实现', 正式写入: false }
    }

    const 旧状态 = typeof 读状态 === 'function' ? 读状态(会) : 条.旧状态

    let 落 = null
    let 崩了 = ''
    try {
      落 = 落盘一轮实现({
        session: 会,
        一轮结果: 条.一轮结果,
        旧状态,
        写事实, 写冲突, 写状态, 写拒绝,
        // ⚠ 拒绝根必须给：不给的话只要有候选被拒，落盘一轮 就会因
        //   「拒绝审计写失败」整轮失败、水位不动。这里让它写正式拒绝目录，
        //   和 legacy 行为一致。
        拒绝根: V2,
        现在,
      })
    } catch (error) {
      崩了 = String((error && error.message) || error)
    }

    if (崩了) {
      return { ok: false, 码: 500, 说: '落盘抛错：' + 崩了, 正式写入: false, 可能部分写入: true }
    }
    if (!落 || !落.ok) {
      return {
        ok: false, 码: 500,
        说: '落盘未完成：' + String((落 && 落.说) || '未知'),
        正式写入: false,
        可能部分写入: true,
        明细: (落 && 落.明细) || [],
      }
    }

    return {
      ok: true, 码: 200,
      session: 会,
      正式写入: true,
      写事实: 落.写事实,
      重复事实: 落.重复事实,
      写冲突: 落.写冲突,
      写拒绝: 落.写拒绝,
      状态写了: 落.状态写了,
      说: 落.说,
      明细: 落.明细,
    }
  } finally {
    // ⚠ 无论成功失败，previewId 立即失效
    预览们.delete(id)
    生产正在跑.delete(会)
  }
}

// ── state ────────────────────────────────────────────

/**
 * 状态（只读）。
 *
 * ⚠ 绝不返回 preview 里的事实内容或聊天内容 ——
 *   这里只给计数和配置态。
 */
export function 生产状态(参 = {}) {
  const 配置 = 参.配置 || 读生产配置(参.配置路径 || null)
  return {
    enabled: 配置.enabled === true,
    sessions: [...(配置.sessions || [])],
    拒收名单: [...(配置.拒收名单 || [])],
    model: 配置.model ? { provider: 配置.model.provider, model: 配置.model.model } : null,
    配置状态: 配置.配置状态 || '',
    配置来源: 配置.配置来源,
    自动触发: false,              // ⚠ 恒 false —— 没有任何自动触发点
    正式写入入口存在: true,
    活动预览数: 活动预览数(),
    previewTTL: PREVIEW_TTL_MS,
    正在运行: 生产正在跑的会话(),
    // ⚠ 明确写出来：legacy /facts/run 不会自动进入 strict=true
    legacy进入strict: false,
    确认口令: 确认口令,
  }
}

/** 测试用：清空内存 preview（生产代码不调用） */
export function 清空预览() {
  预览们.clear()
}
