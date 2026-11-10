// 事件层：finish 状态识别 + 截断加码重试 —— 确定性硬边界
//
// ⚠⚠ 这个文件钉的是一个**真实存在过的死代码**：
//
//   2026-11-10 14:11 实测，事件层第一次尝试的输出被截断在 122 字：
//     模型原始输出：共 122 字  顶层字段=（无法解析为 JSON 对象）
//     类型=json_syntax
//     预览="{\"keep\":true,\"title\":\"事实层提取连续失败\",\"summary\":\"..."
//     Unterminated string in JSON at position 122
//
//   真因是 maxTokens 不够（最多首次 = 900），但被报成了「JSON 语法坏」。
//
//   查下去发现 event-builder.mjs 里那段截断判定是**死代码**，两个地方都错：
//     · 读的字段是 `输出.finishReason / 输出.finish_reason`，
//       而 问模型（index.js L1536）返回的字段叫 **finishKind**；
//     · 值判 `'length'`，
//       而 pi-ai 的 finish chunk 是 reason:{ kind:'max-tokens' }，
//       stopReason='length' 映射到的 kind 是 **'max-tokens'**。
//
//   后果：收尾原因恒为空 ⇒ 永远不进 truncated 分支 ⇒
//     `末错 === 'truncated' ? 1800 : 最多首次` 那个加码重试从来没生效过；
//     每次截断都只能拿 900 再试一次，赌模型这次写短点。
//
// 三条腿：
//   ① max-tokens 必须被认成截断，并触发第二次调用
//   ② 第二次调用的 maxTokens 必须提高（900 → 1800）
//   ③ 别的 finish 值不许被误认成截断（stop / aborted / 缺失）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const eb = await import('../lib/event-builder.mjs')

const 首次上限 = 900
const 加码上限 = 1800

/** 合法的事件卡 JSON */
const 合法卡 = '{"keep":true,"title":"完整卡","summary":"测试","highlights":[],'
  + '"openLoops":[],"tags":["a","b"],"importance":30,"importanceReasons":["理由"]}'

/**
 * 铺一个临时 raw 归档，返回 { 根, session, 清理 }。
 * 消息时间往前推 2 小时，保证不被「还在进行中」的稳定性判据留住。
 */
function 铺素材() {
  const 根 = join(tmpdir(), 'ev-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const session = 'testsess'
  mkdirSync(join(根, session), { recursive: true })
  const now = Date.now()
  const 条们 = [
    {
      id: 'm1', session, scope: 'private', direction: 'inbound', role: 'user',
      speakerId: 'u', speakerName: '他', text: '我今天很累',
      at: new Date(now - 7200000).toISOString(),
    },
    {
      id: 'm2', session, scope: 'private', direction: 'outbound', role: 'assistant',
      speakerId: 'fish', speakerName: '鱼板', text: '那我陪你聊会儿',
      at: new Date(now - 7100000).toISOString(),
    },
  ]
  writeFileSync(
    join(根, session, '2026-11-10.jsonl'),
    条们.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  )
  return { 根, session, now, 清理: () => rmSync(根, { recursive: true, force: true }) }
}

/** 跑一轮，返回 { 调用们, 结果 } */
async function 跑(模型回调) {
  const { 根, session, now, 清理 } = 铺素材()
  const 调用们 = []
  const 包 = async (参) => {
    调用们.push(参.最多)
    return 模型回调(参, 调用们.length)
  }
  try {
    const 结果 = await eb.跑一轮({
      raw根: 根, session, 状态: { 文件水位: {}, 连败: 0 },
      模型回调: 包, 现在: now, 强制收尾: true,
    })
    return { 调用们, 结果 }
  } finally {
    清理()
  }
}

// ════════════════════════════════════════════════════════════════
// 一、max-tokens 必须被认成截断，并加码重试（验收 1、2）
// ════════════════════════════════════════════════════════════════

test('A-1 finishKind=max-tokens 触发第二次调用', async () => {
  const { 调用们 } = await 跑((参, 第几次) => {
    if (第几次 === 1) {
      return { ok: true, text: '{"keep":true,"title":"被截断了', finishKind: 'max-tokens', finishSeen: true }
    }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  assert.equal(调用们.length, 2, '截断后必须再问一次')
})

test('A-2 第二次调用的 maxTokens 从 900 提到 1800', async () => {
  const { 调用们 } = await 跑((参, 第几次) => {
    if (第几次 === 1) {
      return { ok: true, text: '{"keep":true,"title":"被截断了', finishKind: 'max-tokens', finishSeen: true }
    }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  assert.equal(调用们[0], 首次上限, '首次必须是 900')
  assert.equal(调用们[1], 加码上限, '加码重试必须提到 1800 —— 这正是原来死掉的那条路')
})

test('A-3 诊断里明说 finishKind=max-tokens', async () => {
  const { 结果 } = await 跑((参, 第几次) => {
    if (第几次 === 1) {
      return { ok: true, text: '{"keep":true,"title":"被截断了', finishKind: 'max-tokens', finishSeen: true }
    }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  const 全 = (结果.诊断 || []).join('\n')
  assert.match(全, /finishKind=max-tokens/, '诊断要能看出是截断，不是语法坏')
  assert.doesNotMatch(全, /finish_reason=length/, '旧的错误字段名不许再出现')
})

test('A-4 加码后拿到合法 JSON，卡要正常写出来', async () => {
  const { 结果 } = await 跑((参, 第几次) => {
    if (第几次 === 1) {
      return { ok: true, text: '{"keep":true,"title":"被截断了', finishKind: 'max-tokens', finishSeen: true }
    }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  assert.equal(结果.ok, true)
  assert.equal((结果.卡们 || []).length, 1, '应当写出一张卡')
  assert.equal(结果.卡们[0].title, '完整卡')
})

// ════════════════════════════════════════════════════════════════
// 二、别的 finish 值不许被误认成截断（验收 3）
// ════════════════════════════════════════════════════════════════

test('B-1 finishKind=stop 不触发加码，只用 900', async () => {
  const { 调用们 } = await 跑(() => ({ ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }))
  assert.equal(调用们.length, 1, '正常收尾不该重试')
  assert.equal(调用们[0], 首次上限)
})

test('B-2 finishKind=aborted 不走加码路径（它不是 max-tokens）', async () => {
  const { 调用们 } = await 跑((参, 第几次) => {
    if (第几次 === 1) return { ok: true, text: '{"keep":true,"title":"半截', finishKind: 'aborted', finishSeen: true }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  // aborted 不被认成 truncated，所以第一次就落到 json_syntax 的普通重试，
  // 第二次仍是 900 —— 绝不能提到 1800。
  assert.equal(调用们[1], 首次上限, 'aborted 不该拿到加码额度')
})

test('B-3 finishKind 缺失（老内核不发 finish chunk）不炸', async () => {
  const { 调用们, 结果 } = await 跑(() => ({ ok: true, text: 合法卡, finishKind: null, finishSeen: false }))
  assert.equal(调用们.length, 1)
  assert.equal(结果.ok, true)
  assert.equal((结果.卡们 || []).length, 1)
})

test('B-4 旧字段名 finishReason=length 不再被当真（回归钉子）', async () => {
  const { 调用们 } = await 跑((参, 第几次) => {
    // 明明没截断，却塞一个旧的 finishReason —— 它已经不参与判定了
    if (第几次 === 1) {
      return { ok: true, text: '{"keep":true,"title":"半截', finishReason: 'length', finishSeen: true }
    }
    return { ok: true, text: 合法卡, finishKind: 'stop', finishSeen: true }
  })
  assert.equal(调用们[1], 首次上限, 'finishReason 已经是死字段，不许因此加码')
})

// ════════════════════════════════════════════════════════════════
// 三、只重试一次，绝不无限加码
// ════════════════════════════════════════════════════════════════

test('C-1 两次都 max-tokens → 最多调两次，不许第三次', async () => {
  const { 调用们, 结果 } = await 跑(() => ({
    ok: true, text: '{"keep":true,"title":"一直是半截', finishKind: 'max-tokens', finishSeen: true,
  }))
  assert.equal(调用们.length, 2, '重试上限就是一次')
  assert.deepEqual(调用们, [首次上限, 加码上限])
  assert.equal(结果.ok, false, '两次都截断 → 整轮失败')
  assert.equal((结果.卡们 || []).length, 0, '失败时不许写卡')
})

test('C-2 重试仍截断时，水位不推进（失败不丢消息）', async () => {
  const { 结果 } = await 跑(() => ({
    ok: true, text: '{"keep":true,"title":"一直是半截', finishKind: 'max-tokens', finishSeen: true,
  }))
  const 推 = 结果.水位推进 || {}
  assert.equal(推['2026-11-10.jsonl'] || 0, 0, '失败时水位必须停住，下次接着处理')
})
