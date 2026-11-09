// B3B 负向偏好 predicate（user.preference.dislike）与极性一致性边界
//
// ⚠⚠ 这个文件钉的是一个**真实发生过的错**：
//
//   2026-11-09 最终受控 preview 里，
//       证据「肯定打了，我最讨厌淋雨了」
//   被写成了：
//       predicate = user.preference.hobby
//       value     = 讨厌淋雨
//       category  = preference   ← accept
//
//   那条候选**本身是对的**（本人直接自述的偏好），
//   错的是键：hobby 的语义是「爱好」，「讨厌淋雨」是负向偏好。
//   以后召回「他喜欢什么」，会把「讨厌淋雨」当一个爱好捞出来。
//
//   根因：predicate 注册表里当时**没有任何负向偏好键**，
//   模型只能把「讨厌淋雨」塞进唯一能用的 hobby。
//
// 三条腿：
//   ① 注册 / 白名单 / 提示词表 / 基数表 —— 键真的存在且可用
//   ② 极性硬边界 —— hobby 只收正向，dislike 只收负向，只拒不改
//   ③ 召回侧 —— 问「喜欢什么」不许把负向偏好当爱好答

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fb = await import('../lib/fact-builder.mjs')
const reg = await import('../lib/predicate-registry.mjs')
const txt = await import('../lib/fact-text.mjs')
const recall = await import('../lib/recall-engine.mjs')

const 极性码 = 'strict_preference_polarity_mismatch'
const DISLIKE = 'user.preference.dislike'
const HOBBY = 'user.preference.hobby'

/** 造候选 */
const 候 = (predicate, value, category = 'preference') => ({ predicate, value, category })

// ════════════════════════════════════════════════════════════════
// 一、注册表 / 白名单 / 基数 / 提示词表（验收 1、2）
// ════════════════════════════════════════════════════════════════

test('P-1 新 predicate 已注册，字段逐个符合规格', () => {
  const e = reg.predicate注册表[DISLIKE]
  assert.ok(e, '注册表里必须有 ' + DISLIKE)
  assert.equal(e.canonical, DISLIKE)
  assert.deepEqual([...e.aliases], [], 'aliases 必须是空数组（不设别名）')
  assert.equal(e.category, 'preference')
  assert.equal(e.cardinality, 'set')
  assert.deepEqual([...e.subjectTypes], ['user', 'fish'])
  assert.equal(e.valueSchema, 'string')
  assert.equal(e.status, 'active')
  assert.ok(/负向偏好|厌恶/.test(String(e.note)), 'note 必须说明这是负向偏好')
  assert.ok(/多个/.test(String(e.note)), 'note 必须说明允许同时存在多个对象')
})

test('P-2 基数是 set（不是 single）', () => {
  assert.equal(txt.取基数(DISLIKE), 'set')
  assert.equal(txt.predicate基数表[DISLIKE], 'set')
  assert.equal(reg.取基数(DISLIKE), 'set')
})

test('P-3 已进入私聊严格可写白名单', () => {
  assert.ok(fb.私聊严格可写predicate.includes(DISLIKE),
    DISLIKE + ' 必须在私聊严格可写白名单里')
})

test('P-4 与「恒为 event_only」互斥（不许同时出现在两个表）', () => {
  assert.equal(fb.严格仅事件predicate.includes(DISLIKE), false,
    '⚠ 同时出现在可写表和仅事件表会让可写闸失去意义')
})

test('P-5 已进入主提炼提示词的允许表', () => {
  const 表 = fb.渲染predicate表()
  assert.ok(表.includes(DISLIKE), '提示词表必须列出 ' + DISLIKE)
  assert.ok(表.includes(HOBBY), 'hobby 仍在表里（不能为了加 dislike 把 hobby 弄丢）')
})

test('P-6 提示词明确写了正负分键与保留极性', () => {
  const 提示 = fb.取严格系统提示()
  assert.ok(提示.includes(DISLIKE), '提示词必须提到 dislike 键')
  assert.ok(提示.includes('讨厌淋雨'), '提示词必须给出「讨厌淋雨」这个正例')
  assert.ok(/保留极性/.test(提示), '提示词必须要求保留极性词')
})

// ════════════════════════════════════════════════════════════════
// 二、极性硬边界（验收 3、4、6、7）
// ════════════════════════════════════════════════════════════════

test('P-7 真实失败样本：hobby = 讨厌淋雨 → 确定性拒绝', () => {
  const r = fb.查偏好极性一致(候(HOBBY, '讨厌淋雨'), ['我最讨厌淋雨了'])
  assert.ok(r, '必须拒绝（这正是 2026-11-09 那次被 accept 的那条）')
  assert.equal(r.码, 极性码)
  assert.equal(r.命中, 'negative_value_on_positive_key')
})

test('P-8 其他负向表达写进 hobby 也拒', () => {
  const 样本 = [
    ['不喜欢吃香菜', '我不喜欢吃香菜'],
    ['反感别人随便翻东西', '我反感别人随便翻东西'],
    ['不爱早起', '我不爱早起'],
    ['受不了吵闹', '我受不了吵闹'],
  ]
  for (const [value, 句] of 样本) {
    const r = fb.查偏好极性一致(候(HOBBY, value), [句])
    assert.ok(r, '⚠ 「' + value + '」写进 hobby 必须拒')
    assert.equal(r.码, 极性码)
  }
})

test('P-9 dislike = 喜欢淋雨（正向内容写进负向键）→ 拒', () => {
  const r = fb.查偏好极性一致(候(DISLIKE, '喜欢淋雨'), ['我最喜欢淋雨了'])
  assert.ok(r, '⚠ 负向键下出现正向内容必须拒')
  assert.equal(r.码, 极性码)
  assert.equal(r.命中, 'dislike_value_missing_negative')
})

test('P-10 dislike 的 value 删掉极性词 → 拒（不许只写「淋雨」）', () => {
  const r = fb.查偏好极性一致(候(DISLIKE, '淋雨'), ['我最讨厌淋雨了'])
  assert.ok(r, '⚠ 只写「淋雨」等于把讨厌变成中性，必须拒')
  assert.equal(r.码, 极性码)
  assert.equal(r.命中, 'dislike_value_missing_negative')
})

test('P-11 双重否定不得按关键词判成负向偏好 → 拒', () => {
  const 样本 = [
    ['不讨厌淋雨', '我不讨厌淋雨'],
    ['不是不喜欢香菜', '我不是不喜欢香菜'],
    ['没那么讨厌下雨', '我没那么讨厌下雨'],
    ['谈不上讨厌', '谈不上讨厌'],
  ]
  for (const [value, 句] of 样本) {
    const r = fb.查偏好极性一致(候(DISLIKE, value), [句])
    assert.ok(r, '⚠ 「' + value + '」是双重否定，极性拿不准必须拒，不得误写')
    assert.equal(r.码, 极性码)
    assert.equal(r.命中, 'double_negation')
  }
})

test('P-12 正确候选放行：dislike = 讨厌淋雨 / hobby = 喜欢打游戏', () => {
  assert.equal(fb.查偏好极性一致(候(DISLIKE, '讨厌淋雨'), ['我最讨厌淋雨了']), null)
  assert.equal(fb.查偏好极性一致(候(DISLIKE, '不喜欢吃香菜'), ['我不喜欢吃香菜']), null)
  assert.equal(fb.查偏好极性一致(候(HOBBY, '喜欢打游戏'), ['我喜欢打游戏']), null)
  assert.equal(fb.查偏好极性一致(候(HOBBY, '爱看海'), ['我很爱看海']), null)
})

test('P-13 只作用于 hobby / dislike 两个键，别的键一律不触发', () => {
  const 别的 = [
    'user.identity.city', 'user.identity.occupation',
    'user.preference.food', 'user.preference.drink',
    'user.preference.music', 'user.game.plays',
  ]
  for (const p of 别的) {
    assert.equal(fb.查偏好极性一致(候(p, '讨厌淋雨'), ['我最讨厌淋雨了']), null,
      '⚠ ' + p + ' 不该被偏好极性闸接管')
  }
})

// ════════════════════════════════════════════════════════════════
// 三、真实接入语义准入：裁判调用 0 次（验收 4、5、7）
// ════════════════════════════════════════════════════════════════

function 造一条(文本, predicate, value) {
  const 消息 = {
    id: 'msg-1', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: 文本, session: 'session-idg-test',
  }
  return {
    候选: {
      predicate, value, category: 'preference', subject: 'user', subjectId: '',
      eventIds: ['ev-1'], messageIds: ['msg-1'], evidenceMessageIds: ['msg-1'],
      准入路径: 'private_strict', confidence: 80, durability: 'stable',
    },
    证据Map: new Map([['ev-1', [消息]]]),
  }
}

const 裁判 = (决定) => async () => ({ ok: true, text: JSON.stringify({ decision: 决定 }) })

test('P-14 hobby = 讨厌淋雨 → 语义准入里 0 次裁判调用', async () => {
  const { 候选, 证据Map } = 造一条('我最讨厌淋雨了', HOBBY, '讨厌淋雨')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 0, '⚠ 极性命中必须 0 次裁判调用（确定性，不交给模型）')
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].码, 极性码)
  assert.equal(r.拒绝们[0].层, '边界')
})

test('P-15 dislike = 讨厌淋雨 → 继续进入原有语义裁判（不是自动 accept）', async () => {
  const { 候选, 证据Map } = 造一条('我最讨厌淋雨了', DISLIKE, '讨厌淋雨')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 1, '⚠ 过了硬边界必须真的去问裁判 —— 硬边界不是 accept 后门')
  assert.equal(r.拒绝们.length, 0)
  assert.equal(r.候选们.length, 1)
})

test('P-16 拒绝不得自动改键（hobby 的错误候选不许被改写成 dislike）', async () => {
  const { 候选, 证据Map } = 造一条('我最讨厌淋雨了', HOBBY, '讨厌淋雨')
  const r = await fb.语义准入([候选], {
    裁判回调: 裁判('accept'),
    消息证据: 证据Map,
  })
  assert.equal(r.候选们.length, 0, '⚠ 不许把错误 hobby 候选修成成功候选')
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].predicate, HOBBY, '⚠ 拒绝记录里的 predicate 必须保持原样')
  assert.equal(r.拒绝们[0].value, '讨厌淋雨', '⚠ value 不许被删否定词')
})

test('P-17 拒绝理由必须含 predicate / value / 证据 / 为什么', async () => {
  const { 候选, 证据Map } = 造一条('我最讨厌淋雨了', HOBBY, '讨厌淋雨')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  const 说 = String(r.拒绝们[0].说 || '')
  assert.ok(说.includes(HOBBY), '必须含 predicate')
  assert.ok(说.includes('讨厌淋雨'), '必须含 value')
  assert.ok(说.includes('我最讨厌淋雨了'), '必须含证据摘要')
  assert.ok(/必须用 user\.preference\.dislike|只能装正向/.test(说), '必须说明为什么')
})

// ════════════════════════════════════════════════════════════════
// 四、展示层：只显示 value，不显示 predicate（验收 8）
// ════════════════════════════════════════════════════════════════

test('P-18 展示层输出「讨厌淋雨」，不露内部 predicate', () => {
  const 文 = recall.渲染事实值('讨厌淋雨')
  assert.equal(文, '讨厌淋雨')
  assert.equal(文.includes('user.preference'), false, '⚠ 不许把 predicate 漏进展示')
  assert.equal(文.includes('.'), false)
})

test('P-19 极性词必须在展示值里（删了就变味）', () => {
  const 文 = recall.渲染事实值('讨厌淋雨')
  assert.ok(/讨厌/.test(文), '⚠ 展示值是唯一的展示通道，删掉极性等于改成「淋雨」')
  assert.ok(/不喜欢/.test(recall.渲染事实值('不喜欢吃香菜')))
  assert.ok(/反感/.test(recall.渲染事实值('反感别人随便翻东西')))
})

// ════════════════════════════════════════════════════════════════
// 五、召回极性（验收 9、10）
// ════════════════════════════════════════════════════════════════

function 造召回现场() {
  const 根 = mkdtempSync(join(tmpdir(), 'b3b-pol-'))
  const 会 = 'sess-pol'
  const 事实目录 = join(根, 'facts')
  mkdirSync(事实目录, { recursive: true })
  mkdirSync(join(根, 'events', 会), { recursive: true })
  const t = new Date(Date.now() - 3600e3).toISOString()
  const 行 = (id, p, v, c) => JSON.stringify({
    factId: id, subject: 'user', subjectId: '', predicate: p, value: v,
    category: c, confidence: 80, durability: 'stable', status: 'active',
    lastSeenAt: t, createdAt: t, firstSeenAt: t,
  })
  writeFileSync(join(事实目录, 会 + '.jsonl'), [
    行('F1', DISLIKE, '讨厌淋雨', 'preference'),
    行('F2', DISLIKE, '不喜欢吃香菜', 'preference'),
    行('F3', HOBBY, '喜欢打游戏', 'routine'),
    行('F4', HOBBY, '爱看海', 'preference'),
  ].join('\n') + '\n', 'utf8')
  return { 根, 会, 事实目录 }
}

function 问(现场, q) {
  const r = recall.召回({
    事实根: 现场.事实目录,
    事件根: join(现场.根, 'events'),
    session: 现场.会,
    q,
    预算: { maxChars: 2000, maxFacts: 10, maxEpisodes: 0, maxOpenLoops: 0 },
  })
  return ((r.selected && r.selected.facts) || []).map((x) => x.text)
}

test('P-20 ★ 问「我喜欢什么」不得把负向偏好当爱好答', () => {
  const 现场 = 造召回现场()
  try {
    const 得 = 问(现场, '我喜欢什么')
    const 负 = 得.filter((t) => /讨厌|不喜欢|反感/.test(t))
    assert.deepEqual(负, [],
      '⚠ 这是本轮的核心修复：负向偏好被当爱好召回了 —— ' + JSON.stringify(得))
  } finally { rmSync(现场.根, { recursive: true, force: true }) }
})

test('P-21 问「我不喜欢什么」可以召回该负向偏好', () => {
  const 现场 = 造召回现场()
  try {
    const 得 = 问(现场, '我不喜欢什么')
    assert.ok(得.some((t) => /讨厌|不喜欢/.test(t)),
      '⚠ 问负向时必须召得回来，实际：' + JSON.stringify(得))
  } finally { rmSync(现场.根, { recursive: true, force: true }) }
})

test('P-22 问「我讨厌什么」可以召回该负向偏好', () => {
  const 现场 = 造召回现场()
  try {
    const 得 = 问(现场, '我讨厌什么')
    assert.ok(得.some((t) => /讨厌/.test(t)),
      '⚠ 问讨厌时必须召得回来，实际：' + JSON.stringify(得))
  } finally { rmSync(现场.根, { recursive: true, force: true }) }
})

test('P-23 原有正向召回不破', () => {
  const 现场 = 造召回现场()
  try {
    const 得 = 问(现场, '我喜欢玩什么游戏')
    assert.ok(得.some((t) => /打游戏/.test(t)),
      '⚠ 正向查询必须照常召回到 hobby，实际：' + JSON.stringify(得))
  } finally { rmSync(现场.根, { recursive: true, force: true }) }
})

test('P-24 查询不带极性词 → 不拦（极性未知，行为不变）', () => {
  const 现场 = 造召回现场()
  try {
    const 得 = 问(现场, '淋雨')
    assert.ok(得.length > 0, '⚠ 只说主题词时不该被极性闸挡掉，实际：' + JSON.stringify(得))
  } finally { rmSync(现场.根, { recursive: true, force: true }) }
})

test('P-25 「不」不能把「不喜欢」吃成「喜欢」（切词级）', () => {
  const 词 = recall.切词('我不喜欢吃香菜')
  assert.ok(词.has('不喜欢'),
    '⚠ 「不」是停用字，会把整个否定吃掉 —— 必须整词保护，实际切出：' + [...词].join('/'))
})

// ════════════════════════════════════════════════════════════════
// 六、闸门顺序与守卫（不许波及 group / legacy）
// ════════════════════════════════════════════════════════════════

test('P-26 极性闸门在模型裁判之前、身份闸门之后', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  const i身份 = 源.indexOf('const 身 = 查身份直接自述(c, 原句们)')
  const i极性 = 源.indexOf('const 极 = 查偏好极性一致(c, 原句们)')
  const i情境 = 源.indexOf('const 情 = 查情境单次回答(c, 原句们, 对话上下文)')
  const i裁判 = 源.indexOf("if (typeof 裁判 !== 'function')")
  assert.ok(i身份 > 0 && i极性 > 0 && i情境 > 0 && i裁判 > 0)
  assert.ok(i身份 < i极性, '身份闸门在前')
  assert.ok(i极性 < i情境, '极性闸门在情境闸门之前')
  assert.ok(i情境 < i裁判, '三个确定性闸门都在模型裁判之前')
})

test('P-27 极性闸门包在 if (是私聊严格) 里', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  const i = 源.indexOf('const 极 = 查偏好极性一致(c, 原句们)')
  const 前文 = 源.slice(Math.max(0, i - 400), i)
  assert.ok(前文.includes('if (是私聊严格)'),
    '⚠ 必须包在 if (是私聊严格) 里，否则会波及 group 和 legacy')
})

test('P-28 群聊路径不触发极性闸门', async () => {
  const 消息 = {
    id: 'msg-g', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我最讨厌淋雨了', session: 'session-idg-test',
  }
  const 候选 = {
    predicate: HOBBY, value: '讨厌淋雨', category: 'preference',
    subject: 'user', subjectId: 'speaker-a',
    eventIds: ['ev-g'], messageIds: ['msg-g'], evidenceMessageIds: ['msg-g'],
    准入路径: 'group',
  }
  let 次 = 0
  await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"reject"}' } },
    消息证据: new Map([['ev-g', [消息]]]),
  })
  assert.equal(次, 1, '⚠ 群聊必须照常走自己的裁判，新闸门只管 private_strict')
})

test('P-29 legacy 私聊路径不触发极性闸门', async () => {
  const 消息 = {
    id: 'msg-l', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我最讨厌淋雨了', session: 'session-idg-test',
  }
  const 候选 = {
    predicate: HOBBY, value: '讨厌淋雨', category: 'preference',
    subject: 'user', subjectId: '',
    eventIds: ['ev-l'], messageIds: ['msg-l'], evidenceMessageIds: ['msg-l'],
    准入路径: '',
  }
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"reject"}' } },
    消息证据: new Map([['ev-l', [消息]]]),
  })
  assert.equal(次, 0, 'legacy 私聊根本不进裁判（原有行为）')
  assert.equal(r.拒绝们.length, 0, '⚠ legacy 私聊不该被新闸门拒绝')
  assert.equal(r.候选们.length, 1)
})

test('P-30 拒绝码常量逐字一致', () => {
  assert.equal(fb.偏好极性错配码, 'strict_preference_polarity_mismatch')
  assert.equal(极性码, fb.偏好极性错配码)
})
