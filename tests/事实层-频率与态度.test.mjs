// B3B：行为频率 ≠ 偏好态度 —— 确定性硬边界
//
// ⚠⚠ 这个文件钉的是一个**真实发生过的错**：
//
//   2026-11-09 21:55 preview 里，
//     证据：跟朋友一起玩游戏 / 我晚上经常和他们一起玩游戏
//   被写成了：
//     predicate = user.preference.hobby
//     value     = 喜欢和朋友一起玩游戏
//     category  = preference        ← accept
//
//   原话只说「晚上经常玩」，**没有一个字说喜欢**。
//   「经常做」被读成「喜欢做」—— 这是两件事：
//     · 行为频率 → routine（user.game.plays）
//     · 态度偏好 → preference（user.preference.hobby 等）
//
//   一个人可以经常做一件他并不喜欢的事。
//   多个事件重复证明的是**行为规律**，不自动证明喜欢。
//
// 三条腿：
//   ① 正向偏好必须有明确态度证据（strict_preference_attitude_not_explicit）
//   ② routine 必须保留证据里的时间/频率限定词，不许扩大
//   ③ 只拒不改：不改键、不重写 value、不删词

import { test } from 'node:test'
import assert from 'node:assert/strict'

const fb = await import('../lib/fact-builder.mjs')

const 态码 = 'strict_preference_attitude_not_explicit'
const 查态度 = fb.查偏好态度显式
const 查限定 = fb.查routine限定词保留

/** 真实失败样本的原证据 */
const 真实证据 = ['跟朋友一起玩游戏', '我晚上经常和他们一起玩游戏']

const 候 = (predicate, value, category = 'preference') => ({ predicate, value, category })

// ════════════════════════════════════════════════════════════════
// 一、真实失败样本（验收 1）
// ════════════════════════════════════════════════════════════════

test('A-1 真实错误候选被 strict_preference_attitude_not_explicit 拒绝', () => {
  const r = 查态度(候('user.preference.hobby', '喜欢和朋友一起玩游戏'), 真实证据)
  assert.ok(r, '必须拒绝（这正是 21:55 preview 被 accept 的那条）')
  assert.equal(r.码, 态码)
  assert.equal(r.命中, 'frequency_only_no_attitude')
})

test('A-2 拒绝理由必须含 predicate / value / 证据 / 为什么', () => {
  const r = 查态度(候('user.preference.hobby', '喜欢和朋友一起玩游戏'), 真实证据)
  const 说 = String(r.说 || '')
  assert.ok(说.includes('user.preference.hobby'), '必须含 predicate')
  assert.ok(说.includes('喜欢和朋友一起玩游戏'), '必须含 value')
  assert.ok(说.includes('我晚上经常和他们一起玩游戏'), '必须含证据摘要')
  assert.ok(/经常做某事|行为频率|不等于/.test(说), '必须说明为什么不成立')
})

// ════════════════════════════════════════════════════════════════
// 二、正向偏好必须有明确态度（验收 6、7）
// ════════════════════════════════════════════════════════════════

test('A-3 四个正向偏好 predicate 没有态度证据时全拒', () => {
  const 四键 = [
    'user.preference.hobby',
    'user.preference.food',
    'user.preference.drink',
    'user.preference.music',
  ]
  const 样本 = [
    ['喜欢和朋友一起玩游戏', 真实证据],
    ['经常吃火锅', ['我经常吃火锅']],
    ['平时喝茶', ['我平时喝茶']],
    ['总是听周杰伦', ['我总是听周杰伦']],
    ['每天玩游戏', ['我每天玩游戏']],
    ['周末会打球', ['我周末会打球']],
    ['习惯早起', ['我习惯早起']],
  ]
  for (const p of 四键) {
    for (const [val, 句们] of 样本) {
      const r = 查态度(候(p, val), 句们)
      assert.ok(r, '⚠ ' + p + ' = 「' + val + '」没有态度证据，必须拒')
      assert.equal(r.码, 态码)
    }
  }
})

test('A-4 「我喜欢和朋友一起玩游戏」→ 放行（有态度）', () => {
  assert.equal(
    查态度(候('user.preference.hobby', '喜欢和朋友一起玩游戏'), ['我喜欢和朋友一起玩游戏']),
    null,
  )
})

test('A-5 「我经常和朋友一起玩游戏」→ 不能支持 hobby', () => {
  const r = 查态度(候('user.preference.hobby', '喜欢和朋友一起玩游戏'), ['我经常和朋友一起玩游戏'])
  assert.ok(r, '⚠ 只有「经常」，不能支持 hobby')
  assert.equal(r.码, 态码)
})

test('A-6 九种态度表达都能支撑正向偏好', () => {
  const 样本 = [
    ['我喜欢打游戏', '喜欢打游戏'],
    ['我很爱看海', '爱看海'],
    ['我的爱好是摄影', '爱好摄影'],
    ['我最喜欢下雨天', '最喜欢下雨天'],
    ['我偏爱老歌', '偏爱老歌'],
    ['我中意这家店', '中意这家店'],
    ['我钟爱钓鱼', '钟爱钓鱼'],
    ['我最爱吃火锅', '爱吃火锅'],
    ['我最爱喝冰水', '最爱喝冰水'],
  ]
  for (const [句, val] of 样本) {
    assert.equal(查态度(候('user.preference.hobby', val), [句]), null,
      '⚠ 「' + 句 + '」有明确态度，不该被拦')
  }
})

test('A-7 多个事件重复出现「玩游戏」仍不能证明「喜欢玩游戏」', () => {
  // 三个不同事件、三种频率说法，全都没有态度词
  const 多事件 = [
    '跟朋友一起玩游戏',
    '我晚上经常和他们一起玩游戏',
    '昨天又玩了一晚上',
    '我们经常一起开黑',
  ]
  const r = 查态度(候('user.preference.hobby', '喜欢玩游戏'), 多事件)
  assert.ok(r, '⚠ 重复发生证明的是行为规律，不是喜欢')
  assert.equal(r.码, 态码)
})

test('A-8 只认证据不认 value：value 里写「喜欢」不能自证', () => {
  // 证据完全没有态度词，但模型在 value 里塞了「喜欢」—— 不能因为 value 有就放行
  const r = 查态度(候('user.preference.hobby', '喜欢玩游戏'), ['我每天晚上都玩游戏'])
  assert.ok(r, '⚠ 拿 value 自证是循环论证，必须拒')
})

// ════════════════════════════════════════════════════════════════
// 三、routine 限定词保留（验收 5、9、10）
// ════════════════════════════════════════════════════════════════

test('A-9 正确 routine 放行：晚上经常和朋友一起玩游戏', () => {
  assert.equal(
    查限定(候('user.game.plays', '晚上经常和朋友一起玩游戏', 'routine'), 真实证据),
    null,
  )
})

test('A-10 五种错误改写全拒（你第四节点名的）', () => {
  const 错 = [
    ['喜欢和朋友一起玩游戏', 'frequency_word_dropped'],
    ['爱和朋友一起玩游戏', 'frequency_word_dropped'],
    ['经常玩游戏', 'time_word_dropped'],
    ['每天晚上玩游戏', 'frequency_inflated'],
    ['固定和三个人玩游戏', 'frequency_word_dropped'],
  ]
  for (const [val, 期望命中] of 错) {
    const r = 查限定(候('user.game.plays', val, 'routine'), 真实证据)
    assert.ok(r, '⚠ 「' + val + '」是错误改写，必须拒')
    assert.equal(r.码, 态码)
    assert.equal(r.命中, 期望命中, '「' + val + '」的命中原因不对')
  }
})

test('A-11 不得把「经常」扩大成「每天」', () => {
  const 样本 = [
    ['我经常玩游戏', '每天晚上玩游戏'],
    ['我平时看书', '每天晚上看书'],
    ['我每周会玩几次游戏', '每天玩游戏'],
    ['我常常跑步', '每天跑步'],
  ]
  for (const [句, val] of 样本) {
    const r = 查限定(候('user.game.plays', val, 'routine'), [句])
    assert.ok(r, '⚠ 证据「' + 句 + '」不含每日档，value「' + val + '」是扩大，必须拒')
    assert.equal(r.命中, 'frequency_inflated')
  }
})

test('A-12 证据本来就说「每天」时允许写每天', () => {
  assert.equal(
    查限定(候('user.game.plays', '每天晚上玩游戏', 'routine'), ['我每天晚上玩游戏']),
    null,
  )
})

test('A-13 同义档内允许换写法', () => {
  assert.equal(查限定(候('user.game.plays', '常常和朋友一起玩游戏', 'routine'),
    ['我经常和朋友一起玩游戏']), null)
  assert.equal(查限定(候('user.game.plays', '时常玩游戏', 'routine'),
    ['我经常玩游戏']), null)
})

// ════════════════════════════════════════════════════════════════
// 四、真实接入语义准入：裁判 0 次（验收 2、3、4）
// ════════════════════════════════════════════════════════════════

function 造一条(文本们, predicate, value, category) {
  const 消息们 = 文本们.map((t, i) => ({
    id: 'msg-' + (i + 1), speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: t, session: 'session-att-test',
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

test('A-14 错误 hobby 候选 → 语义准入 0 次裁判调用', async () => {
  const { 候选, 证据Map } = 造一条(真实证据, 'user.preference.hobby', '喜欢和朋友一起玩游戏', 'preference')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 0, '⚠ 命中必须 0 次裁判调用')
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].码, 态码)
  assert.equal(r.拒绝们[0].层, '边界')
})

test('A-15 不得自动把 hobby 改成 user.game.plays（验收 3）', async () => {
  const { 候选, 证据Map } = 造一条(真实证据, 'user.preference.hobby', '喜欢和朋友一起玩游戏', 'preference')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.候选们.length, 0, '⚠ 不许把错误候选修成成功候选')
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].predicate, 'user.preference.hobby',
    '⚠ 拒绝记录里 predicate 必须保持原样，不许改成 game.plays')
  assert.equal(r.拒绝们[0].value, '喜欢和朋友一起玩游戏',
    '⚠ value 不许被重写')
})

test('A-16 正确 routine 候选可进入原语义裁判（验收 5）', async () => {
  const { 候选, 证据Map } = 造一条(真实证据, 'user.game.plays', '晚上经常和朋友一起玩游戏', 'routine')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 1, '⚠ 正确的 routine 必须真的去问裁判')
  assert.equal(r.拒绝们.length, 0)
  assert.equal(r.候选们.length, 1)
})

test('A-17 错误 routine 改写 → 0 次裁判调用', async () => {
  const { 候选, 证据Map } = 造一条(真实证据, 'user.game.plays', '每天晚上玩游戏', 'routine')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 0)
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].码, 态码)
})

// ════════════════════════════════════════════════════════════════
// 五、不波及已有边界（验收 11、12、13）
// ════════════════════════════════════════════════════════════════

test('A-18 dislike=讨厌淋雨 仍走原有路径（验收 11）', async () => {
  const { 候选, 证据Map } = 造一条(['我最讨厌淋雨了'], 'user.preference.dislike', '讨厌淋雨', 'preference')
  let 次 = 0
  const r = await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"accept"}' } },
    消息证据: 证据Map,
  })
  assert.equal(次, 1, '⚠ 负向偏好不受本轮新闸门影响，必须照常问裁判')
  assert.equal(r.拒绝们.length, 0)
  assert.equal(r.候选们.length, 1)
})

test('A-19 身份候选仍走身份闸门（验收 12）', async () => {
  const { 候选, 证据Map } = 造一条(['大学生熬夜是正常的'], 'user.identity.occupation', '大学生', 'identity')
  const r = await fb.语义准入([候选], { 裁判回调: 裁判('accept'), 消息证据: 证据Map })
  assert.equal(r.拒绝们.length, 1)
  assert.equal(r.拒绝们[0].码, 'strict_identity_not_direct_self_statement')
})

test('A-20 群聊路径不变（验收 13）', async () => {
  const 消息 = {
    id: 'msg-g', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我经常和朋友一起玩游戏', session: 'session-att-test',
  }
  const 候选 = {
    predicate: 'user.preference.hobby', value: '喜欢和朋友一起玩游戏', category: 'preference',
    subject: 'user', subjectId: 'speaker-a',
    eventIds: ['ev-g'], messageIds: ['msg-g'], evidenceMessageIds: ['msg-g'],
    准入路径: 'group',
  }
  let 次 = 0
  await fb.语义准入([候选], {
    裁判回调: async () => { 次++; return { ok: true, text: '{"decision":"reject"}' } },
    消息证据: new Map([['ev-g', [消息]]]),
  })
  assert.equal(次, 1, '⚠ 群聊必须照常走自己的裁判')
})

test('A-21 legacy 私聊路径不变（验收 13）', async () => {
  const 消息 = {
    id: 'msg-l', speakerName: '航', speakerId: 'speaker-a', role: 'user',
    direction: 'inbound', text: '我经常和朋友一起玩游戏', session: 'session-att-test',
  }
  const 候选 = {
    predicate: 'user.preference.hobby', value: '喜欢和朋友一起玩游戏', category: 'preference',
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
  assert.equal(r.拒绝们.length, 0, '⚠ legacy 不该被新闸门拒绝')
  assert.equal(r.候选们.length, 1)
})

// ════════════════════════════════════════════════════════════════
// 六、触发面与顺序
// ════════════════════════════════════════════════════════════════

test('A-22 只按四个正向偏好 predicate 精确触发', () => {
  for (const p of ['user.preference.hobby', 'user.preference.food',
    'user.preference.drink', 'user.preference.music']) {
    assert.ok(查态度(候(p, '经常吃'), ['我经常吃']), p + ' 必须触发')
  }
  // 不在这里的键一律不触发
  for (const p of ['user.preference.dislike', 'user.game.plays',
    'user.identity.city', 'user.identity.occupation',
    'user.preference.communication_style', 'relationship.callname']) {
    assert.equal(查态度(候(p, '经常吃'), ['我经常吃']), null,
      '⚠ ' + p + ' 不该被正向偏好闸接管')
  }
})

test('A-23 routine 闸只在 category=routine 上触发', () => {
  assert.equal(查限定(候('user.game.plays', '喜欢玩游戏', 'preference'), ['我经常玩游戏']), null,
    '⚠ preference 类不归 routine 闸管')
  assert.equal(查限定(候('user.game.plays', '喜欢玩游戏', 'identity'), ['我经常玩游戏']), null)
})

test('A-24 没有证据时不拦（交给 semantic_evidence_missing）', () => {
  assert.equal(查态度(候('user.preference.hobby', '喜欢玩游戏'), []), null)
  assert.equal(查限定(候('user.game.plays', '晚上经常玩', 'routine'), []), null)
})

test('A-25 闸门顺序：身份 → 极性 → 态度 → routine → 情境 → 裁判', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  // ⚠ 极性闸刻意排在态度闸**之前**：
  //   hobby=讨厌淋雨 是对该候选最精确的判断（键和值极性相反），
  //   不能被新加的、更宽的态度闸抢走拒绝码。
  const 位 = [
    ['身份', 源.indexOf('const 身 = 查身份直接自述(c, 原句们)')],
    ['极性', 源.indexOf('const 极 = 查偏好极性一致(c, 原句们)')],
    ['态度', 源.indexOf('const 态 = 查偏好态度显式(c, 原句们)')],
    ['routine', 源.indexOf('const 限 = 查routine限定词保留(c, 原句们)')],
    ['情境', 源.indexOf('const 情 = 查情境单次回答(c, 原句们, 对话上下文)')],
    ['裁判', 源.indexOf("if (typeof 裁判 !== 'function')")],
  ]
  for (const [名, i] of 位) assert.ok(i > 0, 名 + ' 闸门必须在')
  for (let k = 1; k < 位.length; k++) {
    assert.ok(位[k - 1][1] < 位[k][1],
      '⚠ 顺序错：' + 位[k - 1][0] + ' 必须在 ' + 位[k][0] + ' 之前')
  }
})

test('A-26 两个新闸门都包在 if (是私聊严格) 里', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  for (const 锚 of ['const 态 = 查偏好态度显式(c, 原句们)', 'const 限 = 查routine限定词保留(c, 原句们)']) {
    const i = 源.indexOf(锚)
    const 前文 = 源.slice(Math.max(0, i - 300), i)
    assert.ok(前文.includes('if (是私聊严格)'),
      '⚠ ' + 锚 + ' 必须包在 if (是私聊严格) 里')
  }
})

// ════════════════════════════════════════════════════════════════
// 七、提示词（第五节）
// ════════════════════════════════════════════════════════════════

test('A-27 提示词含五条规则与本样本正误示例', () => {
  const 提示 = fb.取严格系统提示()
  assert.ok(/经常做某事/.test(提示), '必须有第 1 条')
  assert.ok(/不等于/.test(提示), '必须讲清不等于')
  assert.ok(/routine/.test(提示), '必须提到 routine')
  assert.ok(/不能自动支持 preference/.test(提示) || /不能自动/.test(提示), '必须有第 2 条')
  assert.ok(/明确出现/.test(提示), '必须有第 3 条')
  assert.ok(/时间、频率限定词必须保留/.test(提示), '必须有第 4 条')
  assert.ok(提示.includes('"predicate":"user.game.plays"'), '必须有正确示例')
  assert.ok(提示.includes('"predicate":"user.preference.hobby"'), '必须有错误示例')
  assert.ok(提示.includes('晚上经常和朋友一起玩游戏'), '正确示例的 value must be right')
  assert.ok(提示.includes(态码), '必须写明拒绝码')
})

test('A-28 提示词没有因为新增内容把已有要求弄丢', () => {
  const 提示 = fb.取严格系统提示()
  assert.ok(提示.includes('user.preference.dislike'), '负向键仍在表里')
  assert.ok(提示.includes('讨厌淋雨'), '负向偏好示例仍在')
  assert.ok(/保留极性/.test(提示), '保留极性要求仍在')
  assert.ok(提示.includes('user.preference.hobby'), '正向键仍在表里')
})

test('A-29 拒绝码常量逐字一致', () => {
  assert.equal(fb.偏好态度不显式码, 'strict_preference_attitude_not_explicit')
  assert.equal(态码, fb.偏好态度不显式码)
})

test('A-30 正向偏好 predicate 列表与要求一致', () => {
  assert.deepEqual([...fb.正向偏好predicate们], [
    'user.preference.hobby',
    'user.preference.food',
    'user.preference.drink',
    'user.preference.music',
  ])
})
