// 事实层专用模型隔离 + 水位解锁 —— 确定性测试
//
// ⚠⚠⚠ 这个文件要抓的是**正式入口的模型来源**，不是纯函数。
//
//   事故背景（实测，不是猜的）：
//     旧入口 POST /dsh-fishboard-memory/facts/run 的「主提炼 + 四个裁判」
//     原来全部走 问模型(ctx, agent, system, user, 最多) ——
//     第六个参数没传，于是掉进 `取模型(ctx, agent)`，
//     拿到这台机器上的 llmModel，而那个模型在长输入下会滑进
//     「会话归档摘要」schema，吐不出 facts 数组
//     → schema_invalid → fail closed → 水位不推进 → 下次同一批 → 卡死。
//     实测后果：事实水位死卡在 4/28 张事件卡。
//
//   所以要真的：
//     1. 造真实 events / raw 文件
//     2. 真的跑 apply(ctx)
//     3. 真的经 事实层内部挂钩.整理一个() 走完整运行链
//     4. 从假的 ctx.llm.stream 截获**每一次**模型调用，逐条查 provider/model
//
//   ⚠ 只测 fact-builder 的纯函数抓不到这个故障 —— 模型从哪来是**调用方**的事。
//
// ⚠ 本文件不含任何个人路径、真实会话 ID 或聊天内容（scripts/check.mjs 的公开约束）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠ 必须在 import 业务模块之前把 DSH_HOME 指到假家
const 假家 = mkdtempSync(join(tmpdir(), 'fish-factmodel-'))
process.env.DSH_HOME = 假家

const 仓根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const 插件入口 = join(仓根, 'lib', 'index.js')

const 群会 = 'session-fm-group'
const 甲 = 'speaker-a'
const 乙 = 'speaker-b'

const 事件根 = join(假家, 'fish-memory-v2', 'events')
const 事实根 = join(假家, 'fish-memory-v2', 'facts')
const 状态根 = join(假家, 'fish-memory-v2', 'fact-state')
const 拒根 = join(假家, 'fish-memory-v2', 'fact-rejections')
const 冲突根 = join(假家, 'fish-memory-v2', 'fact-conflicts')
const 提案根 = join(假家, 'fish-memory-v2', 'predicate-proposals')
const raw根 = join(假家, 'fish-memory-v2', 'raw')
const 配置路径 = join(假家, 'fish-memory-config.json')

// 这台机器上真实的双模型格局 —— 测试里必须**照抄**，否则测不出「不回退」
const 好模型 = 'deepseek-v4.1-flash'
const 坏模型 = 'deepseek-v4.1-flash-1017'

const 基 = Date.parse('2026-11-05T10:00:00+08:00')
const 早 = (分) => 基 + (分 || 0) * 60000
const 时刻 = (ms) => {
  const d = new Date(ms); const 偏 = -d.getTimezoneOffset()
  const 号 = 偏 >= 0 ? '+' : '-'
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return new Date(d.getTime() + 偏 * 60000).toISOString().slice(0, 19) + 号 + p(偏 / 60) + ':' + p(偏 % 60)
}

// ════════════════════════════════════════════════════════════════
// 模型替身：截获每一次调用
// ════════════════════════════════════════════════════════════════

let 调用们 = []
let 回复表 = {}

function 认用途(system) {
  const s = String(system || '')
  // ⚠ 用各裁判**独有开头**判断，不能靠关键词猜
  //   （提取提示词里也有 evidenceMessageIds 这种词）
  if (s.startsWith('你在补齐一条记忆候选事实的证据')) return '证据修复'
  if (s.startsWith('你是「事实谓词归一裁判」')) return '映射'
  if (s.startsWith('你是一个事实关系判定器')) return '关系'
  if (s.startsWith('你是一个记忆准入裁判')) return '语义'
  return '其它'
}

function 造llm(注册表 = {}) {
  const 有provider = 注册表.providers || ['zz', 'deepseek']
  const 有model = 注册表.models || { zz: [好模型], deepseek: [坏模型] }
  return {
    listProviders() {
      if (注册表.抛错) throw new Error('假的注册表故障')
      return 有provider.map((id) => ({ id }))
    },
    async listModels(provider) {
      if (注册表.抛错) throw new Error('假的注册表故障')
      return (有model[provider] || []).map((id) => ({ id }))
    },
    stream(参) {
      const 用途 = 认用途(参.system)
      调用们.push({ 用途, provider: 参.provider, model: 参.model, temperature: 参.temperature })
      const 内容 = 回复表[用途] != null ? 回复表[用途] : '{}'
      return (async function* () {
        const 半 = Math.ceil(内容.length / 2)
        yield { type: 'text-delta', text: 内容.slice(0, 半) }
        yield { type: 'text-delta', text: 内容.slice(半) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

// ════════════════════════════════════════════════════════════════
// ctx 替身
// ════════════════════════════════════════════════════════════════
function 造ctx(注册表) {
  const 监听 = new Map()
  const 路由 = new Map()
  const ctx = {
    监听, 路由, _effects: [], _agents: [],
    on(事件, 处理器) {
      if (!监听.has(事件)) 监听.set(事件, new Set())
      监听.get(事件).add(处理器)
      return function () { 监听.get(事件).delete(处理器) }
    },
    触发(事件, ...参数) {
      const 集 = 监听.get(事件); if (!集) return 0
      const 们 = [...集]; for (const h of 们) h(...参数); return 们.length
    },
    有效数(事件) { const 集 = 监听.get(事件); return 集 ? 集.size : 0 },
    effect(fn) { const r = fn(); if (typeof r === 'function') ctx._effects.push(r); return r },
    interval() { return () => {} },
    get() {},
    agents: { list: () => ctx._agents },
    sessions: { list: () => [] },
    sessionTitle: {},
    fiber: { assertActive() {}, effect() {} },
    llm: 造llm(注册表),
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: {
      上下文们: [], 段们: [],
      context(配置) { ctx.systemPrompt.上下文们.push(配置); return () => {} },
      section(配置) { ctx.systemPrompt.段们.push(配置); return () => {} },
    },
    tools: { 工具们: new Map(), register(t) { ctx.tools.工具们.set(t && t.name, t); return () => {} } },
    webServer: { register({ path, handler }) { 路由.set(path, handler); return () => {} } },
  }
  return ctx
}

// ════════════════════════════════════════════════════════════════
// 造数据
// ════════════════════════════════════════════════════════════════

function 清数据() {
  for (const d of [事件根, 事实根, 状态根, 拒根, 冲突根, 提案根, raw根]) {
    rmSync(d, { recursive: true, force: true })
  }
  调用们 = []
  回复表 = {}
}

function 写群事件() {
  const 目录 = join(事件根, 群会)
  mkdirSync(目录, { recursive: true })
  const 卡 = {
    schemaVersion: 1, eventId: 'ev-fm-g1', session: 群会, scope: 'group',
    startAt: 时刻(早(0)), endAt: 时刻(早(20)),
    participants: [
      { id: 甲, name: '甲', role: 'user' },
      { id: 乙, name: '乙', role: 'user' },
    ],
    title: '口味讨论', summary: '甲说他喜欢咖啡，乙说他讨厌咖啡。',
    highlights: ['甲喜欢咖啡', '乙讨厌咖啡'], openLoops: [], tags: ['咖啡'],
    importance: 70, importanceReasons: ['具体偏好'],
    sourceMessageIds: ['m-a1', 'm-b1'], sourceCount: 2,
  }
  writeFileSync(join(目录, '2026-11.jsonl'), JSON.stringify(卡) + '\n', 'utf8')
}

function 写raw() {
  const 目录 = join(raw根, 群会)
  mkdirSync(目录, { recursive: true })
  const 消息们 = [
    { id: 'm-a1', session: 群会, scope: 'group', direction: 'inbound', role: 'user',
      speakerId: 甲, speakerName: '甲', text: '我喜欢咖啡', at: 时刻(早(1)) },
    { id: 'm-b1', session: 群会, scope: 'group', direction: 'inbound', role: 'user',
      speakerId: 乙, speakerName: '乙', text: '我讨厌咖啡', at: 时刻(早(2)) },
  ]
  writeFileSync(join(目录, '2026-11-05.jsonl'),
    消息们.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
}

function 读状态(会) {
  const p = join(状态根, 会 + '.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function 读事实(会) {
  const p = join(事实根, 会 + '.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** agent 的模型**故意**是最坏的那个 —— 用来钉「不回退」 */
function 造agent(会) {
  return {
    session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 坏模型 } }) },
    options: { provider: 'deepseek', model: 坏模型 },
    sessionId: 会,
  }
}

/**
 * 写配置。
 * ⚠ 默认情况下 llmModel 和 eventsModel 都**满配**，
 *   这样「事实层没用它们」才是可证伪的 —— 不是靠它们缺失蒙过去的。
 */
function 写配置(覆盖 = {}) {
  const 配置 = {
    llmModel: { provider: 'deepseek', model: 坏模型 },
    eventsModel: { provider: 'zz', model: 好模型 },
    factsModel: { provider: 'zz', model: 好模型 },
    ...覆盖,
  }
  // 用 undefined 显式表示「这一段整个不写」
  for (const k of Object.keys(配置)) {
    if (配置[k] === undefined) delete 配置[k]
  }
  writeFileSync(配置路径, JSON.stringify(配置, null, 2) + '\n', 'utf8')
}

async function 起插件(注册表) {
  const 插件 = await import('file:///' + 插件入口.replace(/\\/g, '/'))
  const ctx = 造ctx(注册表)
  ctx._agents = [造agent(群会)]
  插件.apply(ctx)
  const 挂钩 = 插件.事实层内部挂钩
  assert.ok(挂钩, '必须拿到 事实层内部挂钩')
  return { 插件, ctx, 挂钩 }
}

/** 标准裁判回复：让一条「甲喜欢咖啡」的候选通过全部关卡 */
function 标准回复() {
  return {
    '语义': JSON.stringify({ decision: 'keep', category: 'preference', durability: 'stable', reason: '明确偏好' }),
    '映射': JSON.stringify({ decision: 'map', canonical: 'user.preference.drink', confidence: 0.9, reason: '饮品偏好' }),
    '关系': JSON.stringify({ decision: 'same', existingFactId: 'fact-old-1', reason: '同一偏好' }),
    '证据修复': JSON.stringify({ candidates: [] }),
    '其它': JSON.stringify({ facts: [{
      subject: 'user', subjectId: 甲, predicate: 'user.preference.drink',
      value: '喜欢咖啡', valueType: 'string', category: 'preference',
      durability: 'stable', confidence: 85, op: 'open',
      evidenceEventIds: ['ev-fm-g1'], evidenceMessageIds: ['m-a1'], reason: '明确说了',
    }] }),
  }
}

// ════════════════════════════════════════════════════════════════
// 一、模型来源：五个调用点全部只认 factsModel
// ════════════════════════════════════════════════════════════════

test('FM-1 factsModel 正确时，主提炼显式使用 deepseek-v4.1-flash', async () => {
  清数据(); 写配置(); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  const 主提炼 = 调用们.filter((c) => c.用途 === '其它')
  assert.ok(主提炼.length > 0, '主提炼必须被调用，实际：' + JSON.stringify(调用们.map((c) => c.用途)))
  assert.ok(
    主提炼.every((c) => c.provider === 'zz' && c.model === 好模型),
    '⚠ 主提炼必须用 factsModel（zz/' + 好模型 + '），实际：'
      + JSON.stringify(主提炼.map((c) => c.provider + '/' + c.model)),
  )
})

test('FM-2 主提炼 + 语义 + 映射 全部使用同一个 factsModel', async () => {
  清数据(); 写配置(); 写群事件(); 写raw()
  // ⚠ predicate 用**注册表里没有**的，才会真的走到映射裁判
  回复表 = {
    ...标准回复(),
    '其它': JSON.stringify({ facts: [{
      subject: 'user', subjectId: 甲, predicate: 'user.unknown.thing_xyz',
      value: '喜欢咖啡', valueType: 'string', category: 'preference',
      durability: 'stable', confidence: 85, op: 'open',
      evidenceEventIds: ['ev-fm-g1'], evidenceMessageIds: ['m-a1'], reason: '未知谓词',
    }] }),
  }
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  assert.ok(调用们.length > 0, '这一轮必须有模型调用')
  assert.ok(
    调用们.every((c) => c.provider === 'zz' && c.model === 好模型),
    '⚠ 全部调用必须同源 factsModel，实际：'
      + JSON.stringify([...new Set(调用们.map((c) => c.provider + '/' + c.model))]),
  )
  const 用途们 = new Set(调用们.map((c) => c.用途))
  for (const 要 of ['其它', '语义', '映射']) {
    assert.ok(用途们.has(要), '⚠ ' + 要 + ' 必须被调用过，实际：' + JSON.stringify([...用途们]))
  }
})

test('FM-2b 关系裁判被触发时也用同一个 factsModel', async () => {
  清数据(); 写配置(); 写群事件(); 写raw()
  // 先放一条同 predicate 的旧事实，才会真的问关系裁判
  mkdirSync(事实根, { recursive: true })
  writeFileSync(join(事实根, 群会 + '.jsonl'), JSON.stringify({
    schemaVersion: 1, factId: 'fact-old-1', session: 群会,
    subject: 'user', subjectId: 甲, predicate: 'user.preference.drink',
    value: '喜欢喝咖啡', valueType: 'string', category: 'preference',
    status: 'active', confidence: 85, durability: 'stable',
    firstSeenAt: 时刻(早(0)), lastSeenAt: 时刻(早(0)),
    occurrenceCount: 1, sourceEventIds: ['ev-fm-g1'], sourceMessageIds: ['m-a1'],
  }) + '\n', 'utf8')
  回复表 = 标准回复()

  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  const 关系 = 调用们.filter((c) => c.用途 === '关系')
  assert.ok(关系.length > 0, '⚠ 有同 predicate 旧事实必须触发关系裁判，实际：'
    + JSON.stringify(调用们.map((c) => c.用途)))
  assert.ok(
    关系.every((c) => c.provider === 'zz' && c.model === 好模型),
    '⚠ 关系裁判必须用 factsModel，实际：'
      + JSON.stringify(关系.map((c) => c.provider + '/' + c.model)),
  )
})

test('FM-3 四个裁判仍然 temperature=0', async () => {
  清数据(); 写配置(); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  const 裁判们 = 调用们.filter((c) => ['语义', '映射', '关系', '证据修复'].includes(c.用途))
  assert.ok(裁判们.length > 0, '裁判必须被调用')
  assert.ok(
    裁判们.every((c) => c.temperature === 0),
    '⚠ 裁判必须 temperature=0，实际：'
      + JSON.stringify(裁判们.map((c) => c.用途 + '=' + c.temperature)),
  )
})

test('FM-4 主提炼保留原来的 temperature 默认行为（0.1）', async () => {
  清数据(); 写配置(); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  const 主提炼 = 调用们.filter((c) => c.用途 === '其它')
  assert.ok(主提炼.length > 0, '主提炼必须被调用')
  assert.ok(
    主提炼.every((c) => c.temperature === 0.1),
    '⚠ 主提炼的 temperature 行为一个字都不该改，必须是 0.1，实际：'
      + JSON.stringify(主提炼.map((c) => c.temperature)),
  )
})

// ════════════════════════════════════════════════════════════════
// 二、fail closed：缺失 / 不全 / 注册表没有 —— 0 调用 0 写入
// ════════════════════════════════════════════════════════════════

/** 跑一次「必定 fail closed」的整理，并断言 0 模型调用 + 0 状态写入 */
async function 断言failClosed(选 = {}) {
  const 果 = await 选.挂钩.整理一个(群会)
  assert.equal(果.ok, false, '必须 ok=false')
  assert.equal(调用们.length, 0, '⚠ 必须 0 次模型调用，实际：'
    + JSON.stringify(调用们.map((c) => c.用途 + ':' + c.provider + '/' + c.model)))
  assert.equal(读状态(群会), null, '⚠ 必须不写 fact-state')
  assert.equal(读事实(群会).length, 0, '⚠ 必须不写 facts')
  assert.ok(果.模型, '失败返回必须带 模型 字段')
  assert.equal(果.模型.选模来源, 'factsModel', '选模来源必须是 factsModel')
  return 果
}

test('FM-5 factsModel 整段缺失 → fail closed', async () => {
  清数据(); 写配置({ factsModel: undefined }); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'unconfigured')
  assert.match(果.说, /factsModel/, '诊断要点名 factsModel')
})

test('FM-6 factsModel.provider 缺失 → fail closed', async () => {
  清数据(); 写配置({ factsModel: { model: 好模型 } }); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'configured')
  assert.equal(果.模型.指定模型.provider, null)
})

test('FM-7 factsModel.model 缺失 → fail closed', async () => {
  清数据(); 写配置({ factsModel: { provider: 'zz' } }); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'configured')
  assert.equal(果.模型.指定模型.model, null)
})

test('FM-8 factsModel.provider 在注册表里不存在 → fail closed', async () => {
  清数据(); 写配置({ factsModel: { provider: 'nope', model: 好模型 } }); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'unavailable')
})

test('FM-9 factsModel.model 在该 provider 下不存在 → fail closed', async () => {
  清数据(); 写配置({ factsModel: { provider: 'zz', model: 'no-such-model' } }); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'unavailable')
})

test('FM-10 注册表查询抛错 → fail closed（不因为查不动就放行）', async () => {
  清数据(); 写配置(); 写群事件(); 写raw(); 回复表 = 标准回复()
  // ⚠ 老内核 / 接口没了 → 查不动 → 必须算不可用，**不回退**
  const { 挂钩 } = await 起插件({ 抛错: true })
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'unavailable')
  assert.match(果.说, /注册表查询失败|不可用/, '诊断要说清查不动')
})

// ════════════════════════════════════════════════════════════════
// 三、绝不回退
// ════════════════════════════════════════════════════════════════

test('FM-11 绝不回退到 llmModel（配置满配时也不用它）', async () => {
  清数据()
  // llmModel 和 factsModel 同时存在且都合法、都注册过 ——
  // 这时「用了哪个」最能说明问题
  写配置({ llmModel: { provider: 'deepseek', model: 坏模型 }, factsModel: { provider: 'zz', model: 好模型 } })
  写群事件(); 写raw(); 回复表 = 标准回复()

  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  assert.ok(调用们.length > 0, '必须有调用')
  const 用过坏模型 = 调用们.filter((c) => c.model === 坏模型)
  assert.equal(用过坏模型.length, 0,
    '⚠⚠ 一次都不许用 llmModel=' + 坏模型 + '，实际：'
      + JSON.stringify(用过坏模型.map((c) => c.用途)))
})

test('FM-12 绝不调用 deepseek-v4.1-flash-1017（含裁判）', async () => {
  清数据(); 写配置(); 写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(群会)

  const 罪证 = 调用们.filter((c) => String(c.model || '').includes('1017'))
  assert.equal(罪证.length, 0, '⚠ 任何调用都不许出现 1017，实际：'
    + JSON.stringify(罪证.map((c) => c.用途 + ':' + c.model)))
})

test('FM-13 factsModel 不可用时不拿 eventsModel 当隐式兜底', async () => {
  清数据()
  // eventsModel 合法且可用，factsModel 坏掉 —— 这正是「隐式兜底」最容易钻的地方
  写配置({ eventsModel: { provider: 'zz', model: 好模型 }, factsModel: { provider: 'zz', model: 'no-such-model' } })
  写群事件(); 写raw(); 回复表 = 标准回复()

  const { 挂钩 } = await 起插件()
  await 断言failClosed({ 挂钩 })
  assert.equal(调用们.length, 0, '⚠ 不许借 eventsModel 来兜底')
})

test('FM-14 factsModel 不可用时不拿会话/agent 模型兜底', async () => {
  清数据()
  // agent 的 provider/model 完全合法且可解析，factsModel 坏掉 ——
  // 这正是「悄悄回退到会话模型」会钻的空子
  写配置({ factsModel: { provider: 'nope', model: 好模型 } })
  写群事件(); 写raw(); 回复表 = 标准回复()
  const { 挂钩 } = await 起插件()
  const 果 = await 断言failClosed({ 挂钩 })
  assert.equal(果.模型.模型状态, 'unavailable')
})

// ════════════════════════════════════════════════════════════════
// 四、别的层不许被这次改动带动
// ════════════════════════════════════════════════════════════════

test('FM-15 事件层仍然只认 eventsModel（不被 factsModel 影响）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('function 取事件层模型()'), '事件层选模函数必须还在')
  assert.ok(源.includes("选模来源: 'eventsModel'"), '事件层选模来源必须还是 eventsModel')
  assert.ok(源.includes('function 取事实层模型()'), '事实层选模函数必须存在')
  assert.ok(源.includes("选模来源: 'factsModel'"), '事实层选模来源必须是 factsModel')
})

test('FM-16 privateStrictProduction 没有被这次改动碰到', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('私聊生产'), '严格生产入口必须还在')
  assert.ok(!/factsModel[\s\S]{0,200}privateStrictProduction/.test(源),
    '⚠ factsModel 不许渗进 privateStrictProduction')
})

test('FM-17 五个调用点全部显式带 factsModel（源码级硬核查）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  // 主提炼：问模型(..., 指定模型)
  assert.ok(/问模型\(ctx, agent, system, user, 最多, 指定模型\)/.test(源),
    '主提炼必须显式传 指定模型')
  // 四个裁判：带上 provider/model/temperature
  assert.ok(/provider: 指定模型\.provider,\s*\n\s*model: 指定模型\.model,\s*\n\s*temperature: 0,/.test(源),
    '⚠ 四个裁判必须同时带 provider/model 和 temperature=0 —— '
    + '只传 temperature 会让 问模型 整体回退到 llmModel')
  // 不许还有「只传 temperature」的裁判调用残留
  assert.ok(!/问模型\(ctx, agent, system, user, 最多, \{ temperature: 0 \}\)/.test(源),
    '⚠ 还有只传 temperature 的裁判调用残留')
})

test('FM-18 /facts/state 暴露 factsModel 状态', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(/模型字段[\s\S]{0,300}选模来源: 'factsModel'/.test(源),
    '/facts/state 必须带上 选模来源 factsModel')
  assert.ok(/事实层路由\.set\('state'[\s\S]{0,600}事实层模型注册状态/.test(源),
    '/facts/state 必须真的去查注册表状态')
})

test('FM-19 真配置含 factsModel 且与 llmModel 不同（若本机有真配置）', () => {
  // ⚠ 不写死个人路径：从 DSH 家目录推出来
  const 真家 = process.env.DSH_HOME_REAL || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const 真路 = join(真家, 'fish-memory-config.json')
  if (!existsSync(真路)) {
    assert.ok(true, '真配置不在本机，跳过')
    return
  }
  const c = JSON.parse(readFileSync(真路, 'utf8'))
  assert.ok(c.factsModel, '必须有 factsModel')
  assert.equal(c.factsModel.provider, 'zz')
  assert.equal(c.factsModel.model, 好模型, '⚠ factsModel 必须是 flash，不是 -1017')
  assert.equal(c.llmModel && c.llmModel.model, 坏模型, 'llmModel 一个字都不该改')
  assert.equal(c.eventsModel && c.eventsModel.model, 好模型, 'eventsModel 一个字都不该改')
})
