// 私聊严格身份事实「本人直接自述」硬边界 —— 确定性测试
//
// ⚠⚠⚠ 这个文件要钉死的是一个**真实发生过的错误**，不是假想需求。
//
//   2026-11-09 首次受控 preview 里，模型把：
//       证据原句「大学生熬夜是正常的」
//   提炼成：
//       accepted 候选 predicate=user.identity.occupation value=在校大学生
//
//   那句话只是对「大学生」群体的评价，没有说「我是大学生」。
//   同一轮里「已成年」却因为「调侃语气、推断扩大」被拒 ——
//   同一类推理两种结果，说明这件事不能交给模型碰运气。
//
//   所以这里有两条腿：
//     ① 纯函数契约（查身份直接自述）—— 逐句钉死允许/拒绝
//     ② 真实接入（语义准入）—— 命中时 **0 次裁判调用**，且不影响 routine
//
// ⚠ 本文件不含个人路径、真实会话 ID 或聊天内容中与身份无关的原文（check.mjs 约束）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const 模块 = await import('../lib/fact-builder.mjs')
const 查身份直接自述 = 模块.查身份直接自述
const 身份非自述码 = 模块.身份非自述码
const 语义准入 = 模块.语义准入

const 码 = 'strict_identity_not_direct_self_statement'

/** 造候选 */
const 候 = (predicate, category, value) => ({ predicate, category, value })

/** 造一条证据消息（语义准入要的是 Map<eventId, 消息[]>） */
function 造证据(id, 文本, 说话人 = '他', 方向 = 'inbound', 角色 = 'user') {
  return {
    id, speakerName: 说话人, speakerId: 'speaker-a', role: 角色,
    direction: 方向, text: 文本, session: 'session-idg-test',
  }
}

/** 造一个候选 + 对应的 消息证据 Map + 事件 id */
function 造一条(文本, predicate, category, value) {
  const 消息 = 造证据('msg-1', 文本)
  const 证据Map = new Map([['ev-1', [消息]]])
  const 候选 = {
    predicate, category, value, subject: 'user', subjectId: '',
    eventIds: ['ev-1'], messageIds: ['msg-1'], evidenceMessageIds: ['msg-1'],
    准入路径: 'private_strict', confidence: 80, durability: 'stable',
  }
  return { 候选, 证据Map }
}

// ════════════════════════════════════════════════════════════════
// 一、真实失败样本的确定性复现
// ════════════════════════════════════════════════════════════════

test('G-1 真实失败样本：大学生熬夜是正常的 → reject，码正确', () => {
  const r = 查身份直接自述(
    候('user.identity.occupation', 'identity', '在校大学生'),
    ['大学生熬夜是正常的'],
  )
  assert.ok(r, '必须命中（这正是 2026-11-09 那次被错误 accept 的那条）')
  assert.equal(r.码, 码)
})

test('G-2 成年人熬夜很正常 → 已成年 → reject', () => {
  const r = 查身份直接自述(
    候('user.identity.occupation', 'identity', '已成年'),
    ['成年人熬夜很正常'],
  )
  assert.ok(r, '必须命中')
  assert.equal(r.码, 码)
})

test('G-3 程序员一般都熬夜 → 程序员 → reject', () => {
  const r = 查身份直接自述(
    候('user.identity.occupation', 'identity', '程序员'),
    ['程序员一般都熬夜'],
  )
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-4 杭州人都爱吃甜的 → 杭州 → reject', () => {
  const r = 查身份直接自述(
    候('user.identity.city', 'identity', '杭州'),
    ['杭州人都爱吃甜的'],
  )
  assert.ok(r)
  assert.equal(r.码, 码)
})

// ════════════════════════════════════════════════════════════════
// 二、否定 / 条件 / 疑问 / 转述 / 举例 / 虚拟 / 不确定 → 全拒
// ════════════════════════════════════════════════════════════════

test('G-5 否定句「我不是大学生」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '大学生'), ['我不是大学生'])
  assert.ok(r, '⚠ 本轮不得把否定句当正向身份候选放行')
  assert.equal(r.码, 码)
})

test('G-6 否定句「我已经不在杭州住了」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.city', 'identity', '杭州'), ['我已经不在杭州住了'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-7 条件句「如果我是老师就好了」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '老师'), ['如果我是老师就好了'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-8 疑问句「你觉得我是学生吗」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '学生'), ['你觉得我是学生吗'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-9 转述「别人说我是大学生」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '大学生'), ['别人说我是大学生'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-10 角色扮演「游戏里我是医生」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '医生'), ['游戏里我是医生'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-11 举例「比如我是老师的话」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '老师'), ['比如我是老师的话'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-12 不确定「大概是学生吧」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '学生'), ['大概是学生吧'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-13 第三人称「他是大学生」→ reject', () => {
  const r = 查身份直接自述(候('user.identity.occupation', 'identity', '学生'), ['他是大学生'])
  assert.ok(r)
  assert.equal(r.码, 码)
})

test('G-14 「我」不是充分条件：含我但仍不合格的六种全部拒', () => {
  const 样本 = [
    ['如果我是老师就好了', '老师'],
    ['我不是大学生', '大学生'],
    ['你觉得我是学生吗', '学生'],
    ['游戏里我是医生', '医生'],
    ['别人说我是大学生', '大学生'],
    ['比如我是老师的话', '老师'],
  ]
  for (const [句, val] of 样本) {
    const r = 查身份直接自述(候('user.identity.occupation', 'identity', val), [句])
    assert.ok(r, '⚠ 「' + 句 + '」含「我」但不能放行 —— 不许拿 includes("我") 当充分条件')
    assert.equal(r.码, 码)
  }
})

// ════════════════════════════════════════════════════════════════
// 三、明确直接自述 → 放行（进入裁判，不是自动 accept）
// ════════════════════════════════════════════════════════════════

test('G-15 正例九种全部不被硬规则拒绝', () => {
  const 样本 = [
    ['我是大学生', 'user.identity.occupation', '大学生'],
    ['我现在还在上大学', 'user.identity.occupation', '大学生'],
    ['我在XX大学读书', 'user.identity.school', 'XX大学'],
    ['我的学校是XX大学', 'user.identity.school', 'XX大学'],
    ['我是程序员', 'user.identity.occupation', '程序员'],
    ['我现在住在杭州', 'user.identity.city', '杭州'],
    ['我叫航', 'user.identity.name', '航'],
    ['我的名字是航', 'user.identity.name', '航'],
    ['我学的是计算机专业', 'user.identity.school', '计算机'],
    ['我是大二学生', 'user.identity.occupation', '大二学生'],
  ]
  for (const [句, pred, val] of 样本) {
    const r = 查身份直接自述(候(pred, 'identity', val), [句])
    assert.equal(r, null, '⚠ 「' + 句 + '」是明确自述，不该被硬规则拦（实际拦了：'
      + (r && r.命中) + '）')
  }
})

test('G-16 放行 ≠ 自动 accept：过了硬规则仍要过语义裁判', async () => {
  const { 候选, 证据Map } = 造一条('我是大学生', 'user.identity.occupation', 'identity', '大学生')
  let 裁判调用 = 0
  const r = await 语义准入([候选], {
    裁判回调: async () => { 裁判调用++; return { ok: true, text: JSON.stringify({ decision: 'reject', reason: '裁判自己的判断' }) } },
    消息证据: 证据Map,
  })
  assert.equal(裁判调用, 1, '⚠ 过了硬规则就必须真的去问裁判 —— 硬规则不是 accept')
  assert.equal(r.候选们.length, 0, '裁判 reject 后不该进 候选们')
  // 裁判说 reject，最终就该是 reject
  assert.equal(r.拒绝们.length, 1)
})

// ════════════════════════════════════════════════════════════════
// 四、命中时 0 次模型调用（真实接入语义准入验证）
// ════════════════════════════════════════════════════════════════

test('G-17 命中硬规则 → 语义准入里 0 次裁判调用', async () => {
  const { 候选, 证据Map } = 造一条('大学生熬夜是正常的', 'user.identity.occupation', 'identity', '在校大学生')
  let 裁判调用 = 0
  const r = await 语义准入([候选], {
    裁判回调: async () => { 裁判调用++; return { ok: true, text: JSON.stringify({ decision: 'accept' }) } },
    消息证据: 证据Map,
  })
  assert.equal(裁判调用, 0, '⚠ 命中必须 0 次裁判调用（不许交给模型碰运气）')
  assert.equal(r.拒绝们.length, 1, '必须进拒绝列表')
  assert.equal(r.拒绝们[0].码, 码, '拒绝码必须是 ' + 码)
  assert.equal(r.拒绝们[0].层, '边界', '层必须是 边界')
})

test('G-18 rejected 的 reason 必须含 predicate / value / 证据摘要 / 为什么', async () => {
  const { 候选, 证据Map } = 造一条('大学生熬夜是正常的', 'user.identity.occupation', 'identity', '在校大学生')
  const r = await 语义准入([候选], {
    裁判回调: async () => ({ ok: true, text: JSON.stringify({ decision: 'accept' }) }),
    消息证据: 证据Map,
  })
  const 说 = String(r.拒绝们[0].说 || '')
  assert.ok(说.includes('user.identity.occupation'), 'reason 必须含 predicate')
  assert.ok(说.includes('在校大学生'), 'reason 必须含 value')
  assert.ok(说.includes('大学生熬夜是正常的'), 'reason 必须含精确证据摘要')
  assert.ok(/不构成|不足以|没有/.test(说), 'reason 必须说明为什么不构成本人自述')
})

test('G-19 拒绝审计结构：码 / 层 / 来源', async () => {
  const { 候选, 证据Map } = 造一条('成年人熬夜很正常', 'user.identity.occupation', 'identity', '已成年')
  const r = await 语义准入([候选], {
    裁判回调: async () => ({ ok: true, text: JSON.stringify({ decision: 'accept' }) }),
    消息证据: 证据Map,
  })
  const 项 = r.拒绝们[0]
  assert.equal(项.码, 码)
  assert.equal(项.层, '边界')
  // 语义准入这一层的来源就是「语义准入」，由上层清洗时标注
  assert.ok('码' in 项 && '层' in 项, '审计结构必须有 码 / 层')
})

// ════════════════════════════════════════════════════════════════
// 五、正确候选不受影响（最重要的一条：别修出连带伤害）
// ════════════════════════════════════════════════════════════════

test('G-20 正确 routine「我晚上经常和他们一起玩游戏」不受 identity 闸门影响', async () => {
  const { 候选, 证据Map } = 造一条(
    '我晚上经常和他们一起玩游戏', 'user.game.plays', 'routine', '晚上经常和朋友一起打游戏')
  let 裁判调用 = 0
  let 收到证据 = ''
  const r = await 语义准入([候选], {
    裁判回调: async (参) => { 裁判调用++; 收到证据 = JSON.stringify(参 || {}); return { ok: true, text: JSON.stringify({ decision: 'accept' }) } },
    消息证据: 证据Map,
  })
  assert.equal(裁判调用, 1, '⚠ routine 必须照常进入裁判，不能被 identity 闸门误拦')
  assert.equal(r.拒绝们.length, 0, '不该有任何拒绝')
  assert.equal(r.候选们.length, 1, '必须通过')
})

test('G-21 正确 preference 候选不受影响', async () => {
  const { 候选, 证据Map } = 造一条('我喜欢喝咖啡', 'user.preference.drink', 'preference', '喜欢咖啡')
  let 裁判调用 = 0
  const r = await 语义准入([候选], {
    裁判回调: async () => { 裁判调用++; return { ok: true, text: JSON.stringify({ decision: 'accept' }) } },
    消息证据: 证据Map,
  })
  assert.equal(裁判调用, 1, 'preference 必须照常进入裁判')
  assert.equal(r.候选们.length, 1)
})

test('G-22 群聊 identity 路径不受影响（准入路径=group 不触发本闸门）', async () => {
  const 消息 = 造证据('msg-g', '大学生熬夜是正常的', '他', 'inbound', 'user')
  const 候选 = {
    predicate: 'user.identity.occupation', category: 'identity', value: '在校大学生',
    subject: 'user', subjectId: 'speaker-a',
    eventIds: ['ev-g'], messageIds: ['msg-g'], evidenceMessageIds: ['msg-g'],
    准入路径: 'group',
  }
  let 裁判调用 = 0
  await 语义准入([候选], {
    裁判回调: async () => { 裁判调用++; return { ok: true, text: JSON.stringify({ decision: 'reject', reason: '群聊自己判' }) } },
    消息证据: new Map([['ev-g', [消息]]]),
  })
  assert.equal(裁判调用, 1, '⚠ 群聊必须照常走自己的裁判 —— 新闸门只作用于 private_strict')
})

test('G-23 legacy 私聊路径不受影响（准入路径不是 private_strict，直接通过）', async () => {
  const 消息 = 造证据('msg-l', '大学生熬夜是正常的')
  const 候选 = {
    predicate: 'user.identity.occupation', category: 'identity', value: '在校大学生',
    subject: 'user', subjectId: '',
    eventIds: ['ev-l'], messageIds: ['msg-l'], evidenceMessageIds: ['msg-l'],
    准入路径: '',
  }
  let 裁判调用 = 0
  const r = await 语义准入([候选], {
    裁判回调: async () => { 裁判调用++; return { ok: true, text: JSON.stringify({ decision: 'reject' }) } },
    消息证据: new Map([['ev-l', [消息]]]),
  })
  assert.equal(裁判调用, 0, 'legacy 私聊根本不该进裁判（原有行为）')
  assert.equal(r.拒绝们.length, 0, '⚠ legacy 私聊不该被新闸门拒绝')
  assert.equal(r.候选们.length, 1, 'legacy 私聊保持原行为：直接通过')
})

// ════════════════════════════════════════════════════════════════
// 六、触发面与安全边界
// ════════════════════════════════════════════════════════════════

test('G-24 只按 category=identity 或四个身份 predicate 触发', () => {
  // category=identity 触发
  assert.ok(查身份直接自述(候('something.else', 'identity', 'x'), ['大学生熬夜是正常的']),
    'category=identity 必须触发')
  // 四个 predicate 逐个触发
  for (const p of ['user.identity.city', 'user.identity.school', 'user.identity.name', 'user.identity.occupation']) {
    assert.ok(查身份直接自述(候(p, 'routine', 'x'), ['大学生熬夜是正常的']),
      '⚠ predicate ' + p + ' 即使 category 不是 identity 也必须触发')
  }
  // 其他 predicate + 其他 category → 不触发
  assert.equal(查身份直接自述(候('user.game.plays', 'routine', 'x'), ['大学生熬夜是正常的']), null)
  assert.equal(查身份直接自述(候('user.preference.drink', 'preference', 'x'), ['大学生熬夜是正常的']), null)
  // user.identity.* 之外的身份类键不接管
  assert.equal(查身份直接自述(候('user.identity.gender', 'routine', 'x'), ['随便']), null,
    '⚠ 不许用前缀匹配 —— 将来新增的键不该被这条规则顺手接管')
})

test('G-25 没有证据原句时不拦（交给 semantic_evidence_missing）', () => {
  assert.equal(查身份直接自述(候('user.identity.occupation', 'identity', '在校大学生'), []), null,
    '⚠ 无证据是另一类问题，不能在这里也报同一个错')
  assert.equal(查身份直接自述(候('user.identity.occupation', 'identity', '在校大学生'), ['  ']), null)
})

test('G-26 拒绝码与常量逐字一致', () => {
  assert.equal(身份非自述码, 'strict_identity_not_direct_self_statement')
  assert.equal(码, 身份非自述码)
})

test('G-27 表情噪声不影响判定', () => {
  // preview 里那条证据实际含 [表情]
  const r = 查身份直接自述(
    候('user.identity.occupation', 'identity', '在校大学生'),
    ['大学生熬夜是正常的\n[表情]'],
  )
  assert.ok(r, '带表情噪声仍必须拒绝')
  assert.equal(r.码, 码)
})

// ════════════════════════════════════════════════════════════════
// 七、闸门顺序：identity → 单次情境 → 模型裁判
// ════════════════════════════════════════════════════════════════

test('G-28 identity 闸门在模型裁判之前（源码级顺序核查）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')

  const i身份 = 源.indexOf('const 身 = 查身份直接自述(c, 原句们)')
  const i情境 = 源.indexOf('const 情 = 查情境单次回答(c, 原句们, 对话上下文)')
  const i裁判 = 源.indexOf('if (typeof 裁判 !== \'function\')')
  assert.ok(i身份 > 0, 'identity 闸门调用必须在')
  assert.ok(i情境 > 0, '单次情境闸门调用必须在')
  assert.ok(i裁判 > 0, '模型裁判检查必须在')
  assert.ok(i身份 < i情境, '⚠ identity 闸门必须在单次情境之前')
  assert.ok(i情境 < i裁判, '⚠ 两个确定性闸门都必须在模型裁判之前')
})

test('G-29 identity 闸门受 private_strict 守卫（不会波及 group/legacy）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const 根 = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const 源 = readFileSync(join(根, 'lib', 'fact-builder.mjs'), 'utf8')
  const i = 源.indexOf('const 身 = 查身份直接自述(c, 原句们)')
  // 往上看 400 字符，必须能看到 if (是私聊严格)
  const 前文 = 源.slice(Math.max(0, i - 400), i)
  assert.ok(前文.includes('if (是私聊严格)'),
    '⚠ 闸门必须包在 if (是私聊严格) 里，否则会波及 group 和 legacy')
})




