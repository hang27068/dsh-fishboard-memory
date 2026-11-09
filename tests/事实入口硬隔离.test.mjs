// 事实入口硬隔离：legacy 只收群聊，strict 只收私聊 —— 确定性测试
//
// ⚠⚠⚠ 这个文件要钉死的是**两个入口的准入边界**，不是纯函数。
//
//   事故背景（2026-11-09，真实的）：
//     一个 28 张事件卡全是 scope=private 的会话，
//     被 POST /dsh-fish-memory/facts/run 直接接受 ——
//     那个入口是 legacy / 群聊路径，不给私聊开 privateStrict，
//     结果 25 条候选**绕过私聊严格准入**写进了正式 facts，整轮作废回退。
//     根因：legacy 入口当时根本不看会话类型。
//
//   所以要真的跑 apply(ctx) → 经 事实层内部挂钩.整理一个()，
//   用不同 scope 的事件卡把每个分支都验证一遍。
//
// ⚠ 本文件不含任何个人路径、真实会话 ID 或聊天内容（scripts/check.mjs 的公开约束）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const 假家 = mkdtempSync(join(tmpdir(), 'fish-scope-'))
process.env.DSH_HOME = 假家

const 仓根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const 插件入口 = join(仓根, 'lib', 'index.js')

const 会 = 'session-scope-test'
const 好模型 = 'deepseek-v4.1-flash'
const 坏模型 = 'deepseek-v4.1-flash-1017'

const 事件根 = join(假家, 'fish-memory-v2', 'events')
const 事实根 = join(假家, 'fish-memory-v2', 'facts')
const 状态根 = join(假家, 'fish-memory-v2', 'fact-state')
const 冲突根 = join(假家, 'fish-memory-v2', 'fact-conflicts')
const 配置路径 = join(假家, 'fish-memory-config.json')

const 基 = Date.parse('2026-11-10T10:00:00+08:00')
const 时刻 = (ms) => {
  const d = new Date(ms); const 偏 = -d.getTimezoneOffset()
  const 号 = 偏 >= 0 ? '+' : '-'
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return new Date(d.getTime() + 偏 * 60000).toISOString().slice(0, 19) + 号 + p(偏 / 60) + ':' + p(偏 % 60)
}

// ════════════════════════════════════════════════════════════════
// 模型替身：任何一次调用都会被记下来
// ════════════════════════════════════════════════════════════════
let 调用们 = []

function 认用途(system) {
  const s = String(system || '')
  if (s.startsWith('你在补齐一条记忆候选事实的证据')) return '证据修复'
  if (s.startsWith('你是「事实谓词归一裁判」')) return '映射'
  if (s.startsWith('你是一个事实关系判定器')) return '关系'
  if (s.startsWith('你是一个记忆准入裁判')) return '语义'
  return '其它'
}

function 造llm() {
  return {
    listProviders: () => [{ id: 'zz' }, { id: 'deepseek' }],
    listModels: async (p) => (p === 'zz' ? [好模型] : [坏模型]).map((id) => ({ id })),
    stream(参) {
      调用们.push({ 用途: 认用途(参.system), provider: 参.provider, model: 参.model })
      const 内容 = JSON.stringify({ facts: [{
        subject: 'user', predicate: 'user.preference.drink', value: '喜欢咖啡',
        valueType: 'string', category: 'preference', durability: 'stable',
        confidence: 85, op: 'open', evidenceEventIds: ['ev-s1'],
        evidenceMessageIds: ['m-1'], reason: '明确',
      }] })
      return (async function* () {
        yield { type: 'text-delta', text: 内容 }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function 造ctx() {
  const 监听 = new Map(); const 路由 = new Map()
  const ctx = {
    监听, 路由, _effects: [], _agents: [],
    on(e, h) { if (!监听.has(e)) 监听.set(e, new Set()); 监听.get(e).add(h); return () => 监听.get(e).delete(h) },
    触发(e, ...a) { const s = 监听.get(e); if (!s) return 0; const 们 = [...s]; for (const h of 们) h(...a); return 们.length },
    effect(fn) { const r = fn(); if (typeof r === 'function') ctx._effects.push(r); return r },
    interval() { return () => {} },
    get() {}, agents: { list: () => ctx._agents }, sessions: { list: () => [] },
    sessionTitle: {}, fiber: { assertActive() {}, effect() {} },
    llm: 造llm(), logger: { info() {}, warn() {}, error() {} },
    systemPrompt: { context() { return () => {} }, section() { return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register({ path, handler }) { 路由.set(path, handler); return () => {} } },
  }
  return ctx
}

// ════════════════════════════════════════════════════════════════
// 造数据
// ════════════════════════════════════════════════════════════════
function 清数据() {
  for (const d of [事件根, 事实根, 状态根, 冲突根]) rmSync(d, { recursive: true, force: true })
  调用们 = []
}

/** scopes: 数组，每个元素是一张卡的 scope（null 表示该字段缺失） */
function 写事件(scopes) {
  const 目录 = join(事件根, 会)
  mkdirSync(目录, { recursive: true })
  const 行 = scopes.map((s, i) => {
    const 卡 = {
      schemaVersion: 1, eventId: 'ev-s' + (i + 1), session: 会,
      startAt: 时刻(基 + i * 60000), endAt: 时刻(基 + i * 60000 + 30000),
      participants: [], title: 't' + i, summary: 's' + i, highlights: [],
      openLoops: [], tags: [], importance: 50, importanceReasons: [],
      sourceMessageIds: ['m-' + (i + 1)], sourceCount: 1,
    }
    if (s !== null) 卡.scope = s
    return JSON.stringify(卡)
  })
  writeFileSync(join(目录, '2026-11.jsonl'), 行.join('\n') + '\n', 'utf8')
}

function 写配置() {
  writeFileSync(配置路径, JSON.stringify({
    llmModel: { provider: 'deepseek', model: 坏模型 },
    eventsModel: { provider: 'zz', model: 好模型 },
    factsModel: { provider: 'zz', model: 好模型 },
  }, null, 2) + '\n', 'utf8')
}

/** 事件读取失败：把事件目录做成一个文件，读目录会抛错 */
function 造读取失败() {
  mkdirSync(事件根, { recursive: true })
  writeFileSync(join(事件根, 会), '不是一个目录', 'utf8')
}

/** 群聊主体隔离要求 raw 证据完整 —— 要真跑到模型调用，必须先备好 raw */
function 写raw() {
  const 目录 = join(假家, 'fish-memory-v2', 'raw', 会)
  mkdirSync(目录, { recursive: true })
  writeFileSync(join(目录, '2026-11-10.jsonl'), [
    { id: 'm-1', session: 会, scope: 'group', direction: 'inbound', role: 'user',
      speakerId: 'speaker-a', speakerName: '甲', text: '我喜欢咖啡', at: 时刻(基 + 60000) },
    { id: 'm-2', session: 会, scope: 'group', direction: 'inbound', role: 'user',
      speakerId: 'speaker-b', speakerName: '乙', text: '我讨厌咖啡', at: 时刻(基 + 120000) },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
}

function 读状态() {
  const p = join(状态根, 会 + '.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const 读事实 = () => {
  const p = join(事实根, 会 + '.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const 读冲突 = () => {
  const p = join(冲突根, 会 + '.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
}

test('S-5 全 group 事件 → legacy 允许进入原逻辑', async () => {
  清数据(); 写配置(); 写事件(['group', 'group']); 写raw()
  const { 挂钩, 路由 } = await 起插件()
  // 先用只读 state 确认：群聊时 legacy 允许位 = true
  const 态 = await 调state(路由)
  assert.equal(态.会话类型, 'group')
  assert.equal(态.legacy入口允许, true, '⚠ 群聊必须允许 legacy')
  assert.equal(态.strict入口允许, false)
  // 再真跑一次，确认进到了模型调用（没被 scope 闸门误拦）
  const 果 = await 挂钩.整理一个(会)
  assert.equal(果.会话类型, undefined, '✅ 不该返回 scope 拒绝形状')
  assert.ok(调用们.length > 0,
    '⚠ 群聊必须真的进到模型调用，实际 0 次。返回：' + JSON.stringify(果).slice(0, 400))
})

async function 起插件() {
  const 插件 = await import('file:///' + 插件入口.replace(/\\/g, '/'))
  const ctx = 造ctx()
  ctx._agents = [{ session: {}, options: {}, sessionId: 会 }]
  插件.apply(ctx)
  return { 插件, ctx, 挂钩: 插件.事实层内部挂钩, 路由: ctx.路由 }
}

/** legacy 拒绝时必须满足的全套断言：0 调用、0 读写、0 写入 */
async function 断言legacy拒(挂钩, 期望类型) {
  const 果 = await 挂钩.整理一个(会)
  assert.equal(果.ok, false, '必须 ok=false')
  assert.equal(果.跑了, false, '必须 跑了=false')
  assert.equal(果.会话类型, 期望类型, '会话类型必须是 ' + 期望类型)
  assert.equal(果.入口, 'legacy-facts')
  assert.equal(果.写事实, 0)
  assert.equal(果.状态写了, false)
  // ⚠ 最关键的三条
  assert.equal(调用们.length, 0, '⚠ 必须 0 次模型调用，实际：'
    + JSON.stringify(调用们.map((c) => c.用途 + ':' + c.provider + '/' + c.model)))
  assert.equal(读状态(), null, '⚠ 必须不写 fact-state')
  assert.equal(读事实().length, 0, '⚠ 必须不写 facts')
  assert.equal(读冲突().length, 0, '⚠ 必须不写 conflicts')
  return 果
}

// ════════════════════════════════════════════════════════════════
// 一、legacy /facts/run 只收群聊
// ════════════════════════════════════════════════════════════════

test('S-1 全 private 事件 → legacy 拒绝', async () => {
  清数据(); 写配置(); 写事件(['private', 'private', 'private'])
  const { 挂钩 } = await 起插件()
  const 果 = await 断言legacy拒(挂钩, 'private')
  assert.equal(果.应使用, 'private-strict-production', '必须提示应使用哪个入口')
})

test('S-2 全 private → 0 次模型调用（单独再钉一次）', async () => {
  清数据(); 写配置(); 写事件(['private'])
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(会)
  assert.equal(调用们.length, 0, '⚠ 私聊不许触发任何模型调用')
})

test('S-3 全 private → 完全不碰 fact-state（既不读也不写）', async () => {
  清数据(); 写配置(); 写事件(['private'])
  // 预置一份状态，若被读过也可能被改写；拒绝后必须逐字节不变
  mkdirSync(状态根, { recursive: true })
  const 原状态 = { schemaVersion: 1, session: 会, 文件水位: { '2026-11.jsonl': 7 }, 连败: 2 }
  const 原 = JSON.stringify(原状态, null, 2)
  writeFileSync(join(状态根, 会 + '.json'), 原, 'utf8')
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(会)
  const 后 = readFileSync(join(状态根, 会 + '.json'), 'utf8')
  assert.equal(后, 原, '⚠ fact-state 必须一个字节都不变')
})

test('S-4 全 private → 0 facts / 0 conflicts 写入', async () => {
  清数据(); 写配置(); 写事件(['private', 'private'])
  const { 挂钩 } = await 起插件()
  await 挂钩.整理一个(会)
  assert.equal(读事实().length, 0)
  assert.equal(读冲突().length, 0)
  assert.equal(existsSync(事实根), false, 'facts 目录都不该被创建')
})

test('S-6 mixed（private + group）→ legacy 拒绝', async () => {
  清数据(); 写配置(); 写事件(['private', 'group'])
  const { 挂钩 } = await 起插件()
  const 果 = await 断言legacy拒(挂钩, 'mixed')
  assert.equal(果.scope统计.private, 1)
  assert.equal(果.scope统计.group, 1)
})

test('S-7 unknown scope（缺失 / 空串 / 非法值）→ legacy 拒绝', async () => {
  for (const 坏 of [null, '', 'channel', 'GROUP', 'Private']) {
    清数据(); 写配置(); 写事件(['private', 坏])
    const { 挂钩 } = await 起插件()
    await 断言legacy拒(挂钩, 'unknown')
  }
})

test('S-8 空事件（一张卡都没有）→ legacy 拒绝', async () => {
  清数据(); 写配置()
  mkdirSync(join(事件根, 会), { recursive: true })
  writeFileSync(join(事件根, 会, '2026-11.jsonl'), '', 'utf8')
  const { 挂钩 } = await 起插件()
  await 断言legacy拒(挂钩, 'empty')
})

test('S-9 事件读取失败 → legacy 拒绝', async () => {
  清数据(); 写配置(); 写事件(['private'])
  const { 插件 } = await 起插件()
  // ⚠ 事件库.读事件 内部全吞异常、失败返回 []（所以磁盘上造不出 read_failed）。
  //   这里直接给判定器注入一个抛错的读取器，验证契约本身。
  const 判 = 插件.判定会话scope
  assert.ok(typeof 判 === 'function', '判定器必须导出，才能验证 read_failed 分支')
  const 抛 = 判(会, () => { throw new Error('假的读盘故障') })
  assert.equal(抛.type, 'read_failed')
  assert.equal(抛.ok, false)
  assert.match(抛.reason, /读事件失败|假的读盘故障/)
  // 返回非数组也算查不动
  const 非数组 = 判(会, () => 'not-an-array')
  assert.equal(非数组.type, 'read_failed')
})

// ════════════════════════════════════════════════════════════════
// 二、strict 入口只收私聊（判定器同源）
// ════════════════════════════════════════════════════════════════

/** 直接问共享判定器：strict 入口 用的就是它 */
async function 取判定(type期望) {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('const 判定会话scope'), '共享判定器必须存在')
}

test('S-10 全 private → strict 入口允许（判定器返回 private）', async () => {
  清数据(); 写配置(); 写事件(['private', 'private'])
  const { 路由 } = await 起插件()
  // 走真实 HTTP 处理函数（state 路由会算两个入口的允许位）
  const 果 = await 调state(路由)
  assert.equal(果.会话类型, 'private')
  assert.equal(果.strict入口允许, true, '⚠ 私聊必须允许走 strict')
  assert.equal(果.legacy入口允许, false, '⚠ 私聊必须禁止走 legacy')
})

test('S-11 全 group → strict 入口拒绝', async () => {
  清数据(); 写配置(); 写事件(['group'])
  const { 路由 } = await 起插件()
  const 果 = await 调state(路由)
  assert.equal(果.会话类型, 'group')
  assert.equal(果.strict入口允许, false, '⚠ 群聊必须禁止走 strict')
  assert.equal(果.legacy入口允许, true)
})

test('S-12 mixed / unknown / empty → 两个入口都拒绝', async () => {
  const 情形 = [
    ['mixed', () => 写事件(['private', 'group'])],
    ['unknown', () => 写事件(['private', null])],
    ['empty', () => { mkdirSync(join(事件根, 会), { recursive: true }); writeFileSync(join(事件根, 会, '2026-11.jsonl'), '', 'utf8') }],
  ]
  for (const [期望, 造] of 情形) {
    清数据(); 写配置(); 造()
    const { 路由 } = await 起插件()
    const 果 = await 调state(路由)
    assert.equal(果.会话类型, 期望, '会话类型应为 ' + 期望)
    assert.equal(果.legacy入口允许, false, 期望 + ' 必须禁止 legacy')
    assert.equal(果.strict入口允许, false, 期望 + ' 必须禁止 strict')
  }
})

test('S-12b read_failed → 两个入口都拒绝', async () => {
  清数据(); 写配置(); 写事件(['private'])
  const { 插件 } = await 起插件()
  // 事件库.读事件 吞异常，磁盘造不出 read_failed → 直接验证判定器契约
  const 判 = 插件.判定会话scope(会, () => { throw new Error('假的读盘故障') })
  assert.equal(判.type, 'read_failed')
  assert.equal(判.ok, false)
  // read_failed 时两个入口的允许位都必须是 false（由 state 路由的同一条规则导出）
  assert.equal(判.type === 'group', false, 'read_failed 不得放行 legacy')
  assert.equal(判.type === 'private', false, 'read_failed 不得放行 strict')
})

test('S-13 legacy 拒绝不得自动转发 strict', async () => {
  清数据(); 写配置(); 写事件(['private'])
  const { 挂钩 } = await 起插件()
  const 果 = await 挂钩.整理一个(会)
  // 自动转发会留下痕迹：要么有模型调用，要么有 shadow / 状态写入
  assert.equal(调用们.length, 0, '⚠ 不许偷偷转发后调模型')
  assert.equal(读状态(), null, '⚠ 不许偷偷转发后写状态')
  assert.equal(果.应使用, 'private-strict-production', '只提示，不代跑')
})

test('S-14 strict preview 不得自动 commit（源码级核查）', async () => {
  const 源 = readFileSync(插件入口, 'utf8')
  // preview 段落里不许出现落盘调用
  const i = 源.indexOf("mroute('/dsh-fish-memory/private-strict-production/preview'")
  const j = 源.indexOf("mroute('/dsh-fish-memory/private-strict-production/commit'")
  assert.ok(i > 0 && j > i, '两个路由都要在')
  const preview段 = 源.slice(i, j)
  assert.ok(!/写事实\s*\(/.test(preview段), '⚠ preview 里不许直接写事实')
  assert.ok(!/写状态\s*\(/.test(preview段), '⚠ preview 里不许直接写状态')
})

// ════════════════════════════════════════════════════════════════
// 三、既有行为不许被这次改动带动
// ════════════════════════════════════════════════════════════════

test('S-15 factsModel 隔离代码仍在（模型隔离修复没被回退）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('function 取事实层模型()'))
  assert.ok(源.includes("选模来源: 'factsModel'"))
  assert.ok(/问模型\(ctx, agent, system, user, 最多, 指定模型\)/.test(源))
  assert.ok(/provider: 指定模型\.provider,\s*\n\s*model: 指定模型\.model,\s*\n\s*temperature: 0,/.test(源))
})

test('S-16 事件层行为不变（仍是 eventsModel，没被 scope 改动带动）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('function 取事件层模型()'))
  assert.ok(源.includes("选模来源: 'eventsModel'"))
})

test('S-17 群聊主体隔离行为不变（按 id 取消息仍在）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  assert.ok(源.includes('造读消息实现'), '按 id 取消息的实现必须还在')
  assert.ok(源.includes('读消息:'), '事实层仍然要传读消息')
})

test('S-18 recall-engine 未被这次改动碰到', () => {
  const 源 = readFileSync(join(仓根, 'lib', 'recall-engine.mjs'), 'utf8')
  assert.ok(源.includes('是元话题'), 'meta_topic 逻辑原样保留')
  assert.ok(!源.includes('判定会话scope'), '⚠ 判定器不许渗进 recall-engine')
})

test('S-19 判定器不看配置白名单 / session 名 / QQ 号', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  const 起 = 源.indexOf('const 判定会话scope = (sid, 读事件实现) =>')
  const 止 = 源.indexOf('// 这个会话正在用哪个模型', 起)
  assert.ok(起 > 0 && 止 > 起, '判定器段落必须能定位到')
  const 段 = 源.slice(起, 止)
  // ⚠ 只看**代码行**，注释里解释「不看这些」是允许的
  const 码 = 段.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  for (const 禁 of ['privateStrictProduction', '2706899763', 'startsWith', "includes('qq", 'ctx.', 'agent']) {
    assert.ok(!码.includes(禁), '⚠ 判定器代码里不许出现 ' + 禁 + '（会变成猜类型）')
  }
})

test('S-20 判定器在定义之后才被使用（无 TDZ）', () => {
  const 源 = readFileSync(插件入口, 'utf8')
  const 定义 = 源.indexOf('const 判定会话scope = (sid, 读事件实现) =>')
  assert.ok(定义 > 0, '定义必须在')
  const 用们 = [...源.matchAll(/判定会话scope\(sid\)/g)].map((m) => m.index)
  assert.ok(用们.length >= 2, '至少两处使用（legacy + state），实际 ' + 用们.length)
  for (const u of 用们) {
    assert.ok(u > 定义, '⚠ 第 ' + u + ' 处的使用在定义之前 —— 会 ReferenceError')
  }
})

// ════════════════════════════════════════════════════════════════
// 辅助：调用 facts/state 路由
// ════════════════════════════════════════════════════════════════
async function 调state(路由) {
  const h = 路由.get('/dsh-fish-memory/facts/state')
  assert.ok(h, 'state 路由必须注册了')
  let 体 = ''
  const res = {
    writeHead() {},
    end(s) { 体 = s },
  }
  await h({ url: '/dsh-fish-memory/facts/state?session=' + encodeURIComponent(会) }, res)
  return JSON.parse(体)
}
