// B3B：routine 稳定锚点与跨事件细节隔离
//
// ⚠⚠ 这个文件钉的是一个真实发生过的错：
//
//   2026-11-09 22:23 preview 里，被 accept 的这条：
//
//     predicate = user.game.plays
//     category  = routine
//     value     = 晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起
//                 ^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^
//                 锚点来的     另一张事件卡的当次细节    模型自己加的泛化
//
//   证据来自两张不同的事件卡（相隔 7 条消息、分属两张卡）：
//     ev-51466715（那一晚）: 跟朋友一起玩游戏 / PVE和合作游戏 / 3个人一起玩的
//     ev-57211292（频率）  : 我晚上经常和他们一起玩游戏
//
//   模型把「那一晚是三个人玩 PVE」写成了「通常是3个人一起玩 PVE」。
//   单看每段都有证据，合起来是一句原话没说过的话。
//
// 判据的核心不是关键词，是**事件归属**：
//   routine 只能围绕一条稳定锚点成立；其他事件只能帮助理解指代，
//   不能给 value 添新属性。
//
// ⚠ 只为「事件归属」写规则，不为「PVE」「3个人」写特例 ——
//   那样换一种游戏就又漏了。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const fb = await import('../lib/fact-builder.mjs')

const 跨事件码 = 'strict_routine_cross_event_detail_merge'
const 频率码 = 'strict_routine_frequency_invented'
const 查 = fb.查routine跨事件细节

/** 真实现场的四条证据（带事件归属） */
const 真实证据 = [
  { id: 'qq-1742685415', 原句: '跟朋友一起玩游戏', 事件id: 'ev-51466715' },
  { id: 'qq-1537060995', 原句: '我们玩的pve和合作游戏', 事件id: 'ev-51466715' },
  { id: 'qq-1323642279', 原句: '3个人一起玩的', 事件id: 'ev-51466715' },
  { id: 'qq--115350239', 原句: '我晚上经常和他们一起玩游戏', 事件id: 'ev-57211292' },
]

/** 只有一条锚点，没有别的证据 */
const 单锚点 = [{ id: 'm1', 原句: '我晚上经常和他们一起玩游戏', 事件id: 'ev-B' }]

const 候 = (value, category = 'routine', predicate = 'user.game.plays') =>
  ({ predicate, value, category })

// ════════════════════════════════════════════════════════════════
// 一、真实失败样本（验收 1、2）
// ════════════════════════════════════════════════════════════════

test('R-1 本次真实错误候选被拒绝，码为 cross_event_detail_merge', () => {
  const r = 查(候('晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起'), 真实证据)
  assert.ok(r, '⚠ 这条必须被拒（22:23 preview 里它被 accept 了）')
  assert.equal(r.码, 跨事件码)
  assert.equal(r.命中, 'cross_event_detail_merged')
})

test('R-2 拒绝理由必须点出「哪个细节来自哪个事件」', () => {
  const r = 查(候('晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起'), 真实证据)
  const 说 = String(r.说 || '')
  assert.ok(说.includes('PVE') || 说.includes('pve'), '必须点名 PVE')
  assert.ok(/3个人|3个人一起/.test(说), '必须点名人数')
  assert.ok(说.includes('我们玩的pve和合作游戏') || 说.includes('3个人一起玩的'),
    '必须给出证据原句')
  assert.ok(/其他事件|跨事件/.test(说), '必须说明是跨事件合并')
})

// ════════════════════════════════════════════════════════════════
// 二、只混一样也必须拒（验收 8、9）
// ════════════════════════════════════════════════════════════════

test('R-3 只混当次游戏类型 → 拒', () => {
  for (const v of [
    '晚上经常和朋友一起玩PVE',
    '晚上经常和朋友一起玩合作游戏',
    '晚上经常和朋友一起玩PVE和合作游戏',
  ]) {
    const r = 查(候(v), 真实证据)
    assert.ok(r, '⚠ 「' + v + '」混入了当次游戏类型，必须拒')
    assert.equal(r.码, 跨事件码)
  }
})

test('R-4 只混当次人数 → 拒', () => {
  for (const v of [
    '晚上经常和朋友一起玩，3个人',
    '晚上经常和朋友一起玩，3个人一起',
    '晚上经常和朋友一起玩，三个人',
  ]) {
    const r = 查(候(v), 真实证据)
    assert.ok(r, '⚠ 「' + v + '」混入了当次人数，必须拒')
    assert.equal(r.码, 跨事件码)
  }
})

test('R-5 同时混两样 → 仍拒，且报跨事件码（不是频率码）', () => {
  const r = 查(候('晚上经常和朋友一起玩PVE，通常是3个人'), 真实证据)
  assert.ok(r)
  assert.equal(r.码, 跨事件码, '⚠ 跨事件合并优先级高于频率副词')
})

// ════════════════════════════════════════════════════════════════
// 三、正确候选必须放行（验收 6、7）
// ════════════════════════════════════════════════════════════════

test('R-6 只围绕锚点的正确 routine 放行', () => {
  assert.equal(查(候('晚上经常和朋友一起玩游戏'), 真实证据), null)
})

test('R-7 「他们」规范化成「朋友」允许（你第六条）', () => {
  // 锚点是「我晚上经常和他们一起玩游戏」，value 写「朋友」
  assert.equal(查(候('晚上经常和朋友一起玩游戏'), 单锚点), null,
    '⚠ 指代规范化不是新增细节')
})

test('R-8 同一条锚点确实说了游戏类型/人数时允许保留（你第十一条）', () => {
  const 锚含细节 = [{ id: 'm1', 原句: '我经常和朋友一起玩PVE，通常3个人', 事件id: 'ev-A' }]
  assert.equal(查(候('经常和朋友一起玩PVE，通常3个人'), 锚含细节), null,
    '⚠ 锚点自己说了，就不算跨事件合并')
})

test('R-9 锚点自己含「通常」时，value 可以写「通常」', () => {
  const 锚 = [{ id: 'm1', 原句: '我通常晚上和朋友一起玩游戏', 事件id: 'ev-B' }]
  assert.equal(查(候('通常晚上和朋友一起玩游戏'), 锚), null)
})

// ════════════════════════════════════════════════════════════════
// 四、频率副词凭空增加（验收 10）
// ════════════════════════════════════════════════════════════════

test('R-10 锚点没有「通常」，value 新增「通常」必须拒', () => {
  const r = 查(候('晚上通常和朋友一起玩游戏'), 单锚点)
  assert.ok(r, '⚠ 锚点说「经常」，value 说「通常」，是凭空加泛化')
  assert.equal(r.码, 频率码)
  assert.equal(r.命中, 'frequency_adverb_invented')
})

test('R-11 一般／基本上／大多 同样拒', () => {
  for (const w of ['一般', '基本上', '大多']) {
    const r = 查(候('晚上' + w + '和朋友一起玩游戏'), 单锚点)
    assert.ok(r, '⚠ 凭空加「' + w + '」必须拒')
    assert.equal(r.码, 频率码)
  }
})

// ════════════════════════════════════════════════════════════════
// 五、稳定锚点（第二条）
// ════════════════════════════════════════════════════════════════

test('R-12 没有任何稳定锚点 → 拒（no_stable_anchor）', () => {
  const 无锚 = [{ id: 'm1', 原句: '跟朋友一起玩游戏', 事件id: 'ev-A' }]
  const r = 查(候('和朋友一起玩游戏'), 无锚)
  assert.ok(r, '⚠ 没有长期频率自述，不能写长期 routine')
  assert.equal(r.码, 跨事件码)
  assert.equal(r.命中, 'no_stable_anchor')
})

test('R-13 多个单次事件拼起来也不构成锚点', () => {
  const 多单次 = [
    { id: 'm1', 原句: '跟朋友一起玩游戏', 事件id: 'ev-A' },
    { id: 'm2', 原句: '昨天又玩到很晚', 事件id: 'ev-B' },
    { id: 'm3', 原句: '前天也玩了几把', 事件id: 'ev-C' },
  ]
  const r = 查(候('和朋友一起玩游戏'), 多单次)
  assert.ok(r, '⚠ 多个单次事件不能自动归纳成 routine（你第四条）')
  assert.equal(r.命中, 'no_stable_anchor')
})

test('R-14 长期频率词表覆盖要求里的词', () => {
  const 必含 = ['经常', '通常', '平时', '习惯', '总是', '一直', '每天', '每晚', '每周']
  for (const w of 必含) {
    assert.ok(fb.长期频率词表.includes(w), '⚠ 长期频率词表缺少「' + w + '」')
    assert.equal(fb.是长期频率句('我' + w + '玩游戏'), true, '「' + w + '」应判为长期频率句')
  }
})

// ════════════════════════════════════════════════════════════════
// 六、只拒不改（验收 4、5）
// ════════════════════════════════════════════════════════════════

function 造一条(文本们, predicate, value, category) {
  const 消息们 = 文本们.map((t, i) => ({
    id: 'msg-' + (i + 1), speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: t, session: 'session-routine-test',
  }))
  return {
    候选: {
      predicate, value, category, subject: 'user', subjectId: '',
      eventIds: ['ev-1'], messageIds: 消息们.map((m) => m.id),
      evidenceMessageIds: 消息们.map((m) => m.id),
      准入路径: 'private_strict', confidence: 80, durability: 'medium',
    },
    证据Map: new Map([['ev-1', 消息们]]),
  }
}

const 裁判 = (决定) => async () => ({ ok: true, text: JSON.stringify({ decision: 决定 }) })

test('R-15 真实错误候选在语义准入里 0 次裁判调用（验收 3）', async () => {
  // 两张事件卡：一张是那一晚，一张是频率自述
  const m = (id, t, ev) => ({
    id, speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: t, session: 's', eventId: ev,
  })
  const A = [
    m('a1', '跟朋友一起玩游戏', 'ev-A'),
    m('a2', '我们玩的pve和合作游戏', 'ev-A'),
    m('a3', '3个人一起玩的', 'ev-A'),
  ]
  const B = [m('b1', '我晚上经常和他们一起玩游戏', 'ev-B')]
  const 候选 = {
    predicate: 'user.game.plays',
    value: '晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起',
    category: 'routine', subject: 'user', subjectId: '',
    eventIds: ['ev-A', 'ev-B'],
    messageIds: ['a1', 'a2', 'a3', 'b1'],
    evidenceMessageIds: ['a1', 'a2', 'a3', 'b1'],
    准入路径: 'private_strict', confidence: 80, durability: 'medium',
  }
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: new Map([['ev-A', A], ['ev-B', B]]),
  })
  assert.equal(次, 0, '⚠ 命中必须 0 次裁判调用')
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].码, 跨事件码)
  assert.equal(r.拒绝们[0].层, '边界')
})

test('R-16 不得自动删 PVE、删人数、删「通常」（验收 4）', async () => {
  const { 候选, 证据Map } = 造一条(
    ['跟朋友一起玩游戏', '我们玩的pve和合作游戏', '3个人一起玩的', '我晚上经常和他们一起玩游戏'],
    'user.game.plays', '晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起', 'routine',
  )
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.候选们.length, 0, '⚠ 不许把错误候选修成成功候选')
  assert.equal(r.拒绝们[0].value, '晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起',
    '⚠ value 必须原样保留，不许删词')
  assert.equal(r.拒绝们[0].predicate, 'user.game.plays')
})

test('R-17 不得自动重写成正确候选、不得缩减证据（验收 5）', async () => {
  // ⚠ 这里必须造成「跨事件」局面：锚点在一张卡，PVE 细节在另一张卡。
  //   （第一版只给了两条同事件证据，锚点自己就在里面，
  //     根本没有「其他事件」，闸门当然不该拦 —— 是测试设计错了，不是代码错。）
  const m = (id, t) => ({
    id, speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: t, session: 's',
  })
  const A = [m('a1', '我们玩的pve和合作游戏')]
  const B = [m('b1', '我晚上经常和他们一起玩游戏')]
  const 候选 = {
    predicate: 'user.game.plays', value: '晚上经常和朋友一起玩PVE', category: 'routine',
    subject: 'user', subjectId: '',
    eventIds: ['ev-A', 'ev-B'],
    messageIds: ['a1', 'b1'], evidenceMessageIds: ['a1', 'b1'],
    准入路径: 'private_strict', confidence: 80, durability: 'medium',
  }
  const 原证据 = [...候选.evidenceMessageIds]
  const r = await fb.语义准入([候选], {
    裁判回调: 裁判('accept'),
    消息证据: new Map([['ev-A', A], ['ev-B', B]]),
  })
  assert.equal(r.候选们.length, 0, '⚠ 错误候选不得进入 accepted')
  assert.deepEqual(候选.evidenceMessageIds, 原证据, '⚠ 不许缩减 evidenceMessageIds')
  assert.ok(!JSON.stringify(r.候选们).includes('晚上经常和朋友一起玩游戏'),
    '⚠ 不许凭空造一条正确候选塞进去')
  assert.equal(r.拒绝们[0].value, '晚上经常和朋友一起玩PVE', '⚠ value 不许被改写')
})

test('R-18 正确 routine 可以进入语义裁判（验收 6）', async () => {
  const { 候选, 证据Map } = 造一条(
    ['跟朋友一起玩游戏', '我晚上经常和他们一起玩游戏'],
    'user.game.plays', '晚上经常和朋友一起玩游戏', 'routine',
  )
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 1, '⚠ 正确候选必须真的去问裁判')
  assert.equal(r.拒绝们.length, 0)
  assert.equal(r.候选们.length, 1)
})

// ════════════════════════════════════════════════════════════════
// 七、不波及已有边界（验收 12、13、14）
// ════════════════════════════════════════════════════════════════

test('R-19 dislike=最讨厌淋雨 仍正常（验收 12）', async () => {
  const { 候选, 证据Map } = 造一条(['肯定打了，我最讨厌淋雨了'],
    'user.preference.dislike', '最讨厌淋雨', 'preference')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 1, '⚠ dislike 不受 routine 闸影响')
  assert.equal(r.拒绝们.length, 0)
})

test('R-20 身份边界保持（验收 13）', async () => {
  const { 候选, 证据Map } = 造一条(['大学生熬夜是正常的'],
    'user.identity.occupation', '大学生', 'identity')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.拒绝们[0].码, 'strict_identity_not_direct_self_statement')
})

test('R-21 态度边界保持（验收 13）', async () => {
  const { 候选, 证据Map } = 造一条(['我经常和朋友一起玩游戏'],
    'user.preference.hobby', '喜欢和朋友一起玩游戏', 'preference')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.拒绝们[0].码, 'strict_preference_attitude_not_explicit')
})

test('R-22 极性边界保持（验收 13）', async () => {
  const { 候选, 证据Map } = 造一条(['我最讨厌淋雨了'],
    'user.preference.hobby', '讨厌淋雨', 'preference')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.拒绝们[0].码, 'strict_preference_polarity_mismatch')
})

test('R-23 群聊路径不变（验收 14）', async () => {
  const 消息 = {
    id: 'msg-g', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我们玩的pve和合作游戏', session: 's',
  }
  const 候选 = {
    predicate: 'user.game.plays', value: '玩PVE', category: 'routine',
    subject: 'user', subjectId: 'speaker-a',
    eventIds: ['ev-g'], messageIds: ['msg-g'], evidenceMessageIds: ['msg-g'],
    准入路径: 'group',
  }
  let 次 = 0
  await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"reject"}' } },
    消息证据: new Map([['ev-g', [消息]]]),
  })
  assert.equal(次, 1, '⚠ 群聊必须照常走自己的裁判，不被 routine 闸拦')
})

test('R-24 legacy 私聊路径不变（验收 14）', async () => {
  const 消息 = {
    id: 'msg-l', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我们玩的pve和合作游戏', session: 's',
  }
  const 候选 = {
    predicate: 'user.game.plays', value: '玩PVE', category: 'routine',
    subject: 'user', subjectId: '',
    eventIds: ['ev-l'], messageIds: ['msg-l'], evidenceMessageIds: ['msg-l'],
    准入路径: '',
  }
  const r = await fb.语义准入([候选], {
    裁判回调: 裁判('reject'),
    消息证据: new Map([['ev-l', [消息]]]),
  })
  assert.equal(r.拒绝们.length, 0, '⚠ legacy 不该被新闸门拒绝')
  assert.equal(r.候选们.length, 1)
})

// ════════════════════════════════════════════════════════════════
// 八、触发面与顺序
// ════════════════════════════════════════════════════════════════

test('R-25 只在 category=routine 上触发', () => {
  assert.equal(查(候('晚上经常和朋友一起玩PVE', 'preference'), 真实证据), null,
    '⚠ preference 不归 routine 闸管')
  assert.equal(查(候('晚上经常和朋友一起玩PVE', 'identity'), 真实证据), null)
  assert.equal(查(候('晚上经常和朋友一起玩PVE', 'routine'), 真实证据)?.码, 跨事件码)
})

test('R-26 没有证据时不拦（交给 semantic_evidence_missing）', () => {
  assert.equal(查(候('晚上经常和朋友一起玩游戏'), []), null)
})

test('R-27 闸门顺序：身份 → 跨事件 → 极性 → 态度 → 限定词 → 情境 → 裁判', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  const 位 = [
    ['身份', 源.indexOf('const 身 = 查身份直接自述(c, 原句们)')],
    ['跨事件', 源.indexOf('const 跨 = 查routine跨事件细节(c, 证据详情)')],
    ['极性', 源.indexOf('const 极 = 查偏好极性一致(c, 原句们)')],
    ['态度', 源.indexOf('const 态 = 查偏好态度显式(c, 原句们)')],
    ['限定词', 源.indexOf('const 限 = 查routine限定词保留(c, 原句们)')],
    ['情境', 源.indexOf('const 情 = 查情境单次回答(c, 原句们, 对话上下文)')],
    ['裁判', 源.indexOf("if (typeof 裁判 !== 'function')")],
  ]
  for (const [名, i] of 位) assert.ok(i > 0, 名 + ' 闸门必须在')
  for (let k = 1; k < 位.length; k++) {
    assert.ok(位[k - 1][1] < 位[k][1],
      '⚠ 顺序错：' + 位[k - 1][0] + ' 必须在 ' + 位[k][0] + ' 之前')
  }
})

test('R-28 跨事件闸包在 if (是私聊严格) 里', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  const i = 源.indexOf('const 跨 = 查routine跨事件细节(c, 证据详情)')
  assert.ok(源.slice(Math.max(0, i - 400), i).includes('if (是私聊严格)'))
})

test('R-29 证据详情带事件归属（闸门靠它区分锚点/当次）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  assert.ok(/证据详情\.push\(\{[\s\S]{0,400}事件id: String\(eid\)/.test(源),
    '⚠ 证据详情 必须记录每条证据属于哪个事件卡')
})

// ════════════════════════════════════════════════════════════════
// 九、提示词（第五节）
// ════════════════════════════════════════════════════════════════

test('R-30 提示词含五条规则与本样本正误示例', () => {
  const 提示 = fb.取严格系统提示()
  assert.ok(/稳定锚点/.test(提示), '必须有第 1 条')
  assert.ok(/只能围绕一条/.test(提示))
  assert.ok(/只能帮助理解指代/.test(提示), '必须有第 2 条')
  assert.ok(/游戏类型、参与人数/.test(提示), '必须有第 3 条')
  assert.ok(/不得因为两张事件卡/.test(提示), '必须有第 4 条')
  assert.ok(提示.includes('strict_routine_cross_event_detail_merge'), '必须写明跨事件码')
  assert.ok(提示.includes('strict_routine_frequency_invented'), '必须写明频率码')
  assert.ok(提示.includes('晚上经常和朋友一起玩PVE和合作游戏，通常是3个人一起'), '错误示例')
  assert.ok(提示.includes('"value":"晚上经常和朋友一起玩游戏"'), '正确示例')
})

test('R-31 提示词没弄丢已有要求', () => {
  const 提示 = fb.取严格系统提示()
  assert.ok(提示.includes('strict_preference_attitude_not_explicit'), '态度码仍在')
  assert.ok(提示.includes('strict_preference_polarity_mismatch'), '极性码仍在')
  assert.ok(提示.includes('user.preference.dislike'), '负向键仍在')
  assert.ok(/保留极性/.test(提示), '保留极性要求仍在')
})

test('R-32 拒绝码常量逐字一致', () => {
  assert.equal(fb.跨事件细节合并码, 'strict_routine_cross_event_detail_merge')
  assert.equal(fb.频率凭空增加码, 'strict_routine_frequency_invented')
})

// ════════════════════════════════════════════════════════════════
// 十、不为 PVE / 3个人 写特例
// ════════════════════════════════════════════════════════════════

test('R-33 换一种游戏、换一种人数，同样能拦住（不是特例关键词）', () => {
  const 另一场 = [
    { id: 'x1', 原句: '我周末经常去爬山', 事件id: 'ev-X' },
    { id: 'x2', 原句: '上周爬的是香山', 事件id: 'ev-Y' },
    { id: 'x3', 原句: '一共五个人', 事件id: 'ev-Y' },
  ]
  // 锚点是「我周末经常去爬山」，value 混入了另一事件的「香山」「五个人」
  const r = 查(候('周末经常去香山爬山，一共五个人', 'routine', 'user.routine.activity'), 另一场)
  assert.ok(r, '⚠ 换个场景同样要拦住，说明规则不是 PVE 特例')
  assert.equal(r.码, 跨事件码)
})

test('R-34 源码里没有 PVE / 3个人 的特例判断', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  // 取 查routine跨事件细节 函数体
  const 起 = 源.indexOf('export function 查routine跨事件细节')
  const 止 = 源.indexOf('export function 查身份直接自述')
  const 体 = 源.slice(起, 止)
  assert.ok(!/['"`]PVE['"`]/.test(体), '⚠ 函数体里不许写死 PVE')
  assert.ok(!/['"`]3个人['"`]/.test(体), '⚠ 函数体里不许写死 3个人')
  assert.ok(!/['"`]pve['"`]/.test(体), '⚠ 函数体里不许写死 pve')
})
