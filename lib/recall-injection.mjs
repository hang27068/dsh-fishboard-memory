// 五层记忆第四阶段 B：受控上下文接入 —— 纯函数层
//
// ⭐ 2026-11-03 当前用户定的第四阶段 B：
//   把第四阶段 A 已验收的召回结果**接入 DSH 动态 context**，
//   让助手在相关聊天里自然用上记忆。
//
// ⚠⚠ 这层的硬边界（一条都不能破）：
//   · 不调模型（没有第二次模型调用做召回）
//   · 不写 facts / events / raw / fact-state / 旧记忆库
//   · 不开自动扫描
//   · 不碰 QQ 桥、不碰人格包
//   · 不新增第二个 memory context，不新增 systemPrompt.section
//   · 召回失败时**绝不回退到旧记忆**（否则用户判断不了这一轮到底用了哪套）
//
// 这个文件只放**纯函数**，不 import 任何 DSH 服务，方便单测。

import * as 召回层 from './recall-engine.mjs'
import * as 召回渲染 from './recall-renderer.mjs'

/** 记忆块的硬上限（含标题）。第四阶段 A 的 selected 预算 1200 字仍然生效。 */
export const 记忆块上限 = 1400

/** 给诊断用的 query 截断长度 */
export const 诊断查询上限 = 100

/**
 * 会话模式判定 —— **纯函数**，不读配置、不碰文件。
 *
 * 只有同时满足三条才进 v2：
 *   ① 原记忆总开关 on（isEnabled(sid)）
 *   ② recallInjection.enabled **严格 === true**
 *   ③ recallInjection.sessions[sid] **严格 === true**
 *
 * ⚠ 以下是**都不算 true** 的（当前用户明确点名）：
 *   "true" / 1 / "yes" / 缺失 / 配置损坏
 *
 * ⚠ 默认必须是 legacy —— 保证升级后现有聊天行为一个字都不变。
 *
 * @param {{总开关?:boolean, 注入配置?:any}} 参数
 * @returns {'legacy'|'v2'}
 */
export function 记忆模式(参数) {
  const p = 参数 && typeof 参数 === 'object' ? 参数 : {}
  // ① 原记忆总开关关着 → 什么记忆都不挂（这条由调用方处理成「不挂」，
  //    但纯函数这里也要能正确回答：不是 v2）
  if (p.总开关 !== true) return 'legacy'

  const 注入 = p.注入配置
  // 配置缺失 / 不是对象 → legacy
  if (!注入 || typeof 注入 !== 'object' || Array.isArray(注入)) return 'legacy'

  // ② 总开关必须**严格**是 true
  //    ⚠ 用 === true 而不是真值判断：`"true"`、`1`、`"yes"` 都是真值，
  //      但它们不该打开注入 —— 写错配置不能变成意外开启。
  if (注入.enabled !== true) return 'legacy'

  // ③ 会话开关必须**严格**是 true
  const 表 = 注入.sessions
  if (!表 || typeof 表 !== 'object' || Array.isArray(表)) return 'legacy'
  const sid = String(p.sid == null ? '' : p.sid)
  if (!sid) return 'legacy'
  if (!Object.prototype.hasOwnProperty.call(表, sid)) return 'legacy'
  if (表[sid] !== true) return 'legacy'

  return 'v2'
}

/**
 * 从配置对象里取注入配置。配置损坏时返回 null（→ legacy）。
 * @param {any} 配置
 */
export function 取注入配置(配置) {
  try {
    if (!配置 || typeof 配置 !== 'object') return null
    const v = 配置.recallInjection
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    return v
  } catch (error) {
    return null
  }
}

/**
 * 构造 v2 记忆上下文 —— 第四阶段 B 的核心。
 *
 * 流程（严格按当前用户定的七步）：
 *   1. query 清洗并 trim
 *   2. query 为空 → 不召回
 *   3. 调 召回层.召回(...)
 *   4. 调 召回渲染.渲染(result)
 *   5. 组装 [当前状态块, V2记忆文本, 防复读块].filter(Boolean).join('\n\n')
 *
 * ⚠ 失败时返回 [状态块, 防复读块]，**不自动回退 legacy**。
 *
 * @param {{
 *   事实根:string, 事件根:string, session:string, query:string,
 *   状态块?:string, 防复读块?:string, 现在?:number,
 *   召回?:Function, 渲染?:Function,   // 便于测试注入替身
 * }} 参数
 * @returns {{
 *   文本:string, 空:boolean, 模式:'v2',
 *   查询字数:number, 注入字数:number,
 *   selected:{facts:number,episodes:number,openLoops:number},
 *   记忆文本:string, 错误:string|null
 * }}
 */
export function 构造V2记忆上下文(参数) {
  const p = 参数 && typeof 参数 === 'object' ? 参数 : {}
  const 状态块 = typeof p.状态块 === 'string' ? p.状态块 : ''
  const 防复读块 = typeof p.防复读块 === 'string' ? p.防复读块 : ''

  // 前置两块的兜底拼接（任何情况下都不能丢）
  const 前置 = () => [状态块, 防复读块].filter((s) => s && s.length > 0).join('\n\n')

  const 失败 = (错) => ({
    文本: 前置(),
    空: true,
    模式: 'v2',
    查询字数: 查询清理后长度,
    注入字数: 字数(前置()),
    selected: { facts: 0, episodes: 0, openLoops: 0 },
    记忆文本: '',
    错误: String(错 && 错.message ? 错.message : 错 || '未知错误').slice(0, 200),
  })

  // ── 1. query 清洗（调用方已经过 去掉系统块，这里只 trim）──
  let 查询 = String(p.query == null ? '' : p.query)
  查询 = 查询.trim()
  const 查询清理后长度 = 字数(查询)

  try {
    // ── 2. 空查询不召回 ──
    if (!查询) {
      return {
        文本: 前置(),
        空: true,
        模式: 'v2',
        查询字数: 0,
        注入字数: 字数(前置()),
        selected: { facts: 0, episodes: 0, openLoops: 0 },
        记忆文本: '',
        错误: null,
      }
    }

    const 召回 = typeof p.召回 === 'function' ? p.召回 : 召回层.召回
    const 渲染 = typeof p.渲染 === 'function' ? p.渲染 : 召回渲染.渲染

    // ⭐⭐ 第四阶段 E1：群聊缺身份 → **整个 V2 召回 fail closed**
    //
    // ⚠⚠ 运行时硬边界，当前用户的规则一条都不许松：
    //   · 群聊标记和 speakerId 必须来自**现有可信身份透传**（QQ bridge 给的）
    //   · 群聊缺 speakerId → 整个 V2 召回直接不跑，返回空
    //   · **不许**从正文、昵称、群号、chatId、上一轮身份去补 speakerId
    //   · 私聊不许复用上一轮群聊身份
    //   · 群聊事实不许回流私聊（召回引擎的 scope 隔离兜底）
    //
    // ⚠ 为什么在**这一层**就拦，不只靠 过滤事实：
    //   过滤事实 只拦 user/relationship 事实，事件卡和其它主体还能进来。
    //   群聊里身份不明时，连「这是谁的记忆」都判不了 ——
    //   这时候给模型任何记忆都是在赌。宁可这一轮什么都不带。
    const 是群聊 = p.群聊 === true
    const 说话人 = String(p.说话人 == null ? '' : p.说话人).trim()
    if (是群聊 && !说话人) {
      return {
        文本: 前置(),
        空: true,
        模式: 'v2',
        查询字数: 查询清理后长度,
        注入字数: 字数(前置()),
        selected: { facts: 0, episodes: 0, openLoops: 0 },
        记忆文本: '',
        错误: null,
        诊断: ['group_identity_missing：群聊未提供 speakerId → V2 召回整体 fail closed'
          + '（不从正文/昵称/群号/chatId/上一轮身份补身份）'],
      }
    }

    // ── 3. 召回（第四阶段 A 的引擎，纯确定性，不调模型）──
    const 结果 = 召回({
      事实根: p.事实根,
      事件根: p.事件根,
      session: p.session,
      q: 查询,
      现在: Number.isFinite(p.现在) ? p.现在 : Date.now(),
      // ⭐ 2026-11-04 群聊主体隔离 / 第四阶段 E1：
      //   群聊召回 user 事实时必须知道「现在是谁在问」。
      //   身份只能来自可信透传（说话人 / 群聊 两个参数），
      //   这里绝不推导、绝不补值。
      说话人,
      群聊: 是群聊,
    })

    // ── 4. 渲染 ──
    let 记忆文本 = 渲染(结果)
    记忆文本 = typeof 记忆文本 === 'string' ? 记忆文本.trim() : ''

    // ── 5. 上限：整个记忆块不超过 1400 字 ──
    //    ⚠ 渲染器本身已经在 1200 字预算内组装，
    //      这里只是最后一道保险。真超了**整块不要**，绝不截断成半句。
    if (字数(记忆文本) > 记忆块上限) {
      记忆文本 = ''
    }

    const selected = {
      facts: 结果 && 结果.selected && Array.isArray(结果.selected.facts) ? 结果.selected.facts.length : 0,
      episodes: 结果 && 结果.selected && Array.isArray(结果.selected.episodes) ? 结果.selected.episodes.length : 0,
      openLoops: 结果 && 结果.selected && Array.isArray(结果.selected.openLoops) ? 结果.selected.openLoops.length : 0,
    }

    // ⚠ 空结果完全不输出「可用记忆」标题（渲染器已经保证返回 ''，这里再确认一次）
    const 有记忆 = 记忆文本.length > 0

    // ── 组装：状态 → 记忆 → 防复读 ──
    const 文本 = [状态块, 有记忆 ? 记忆文本 : '', 防复读块]
      .filter((s) => s && s.length > 0)
      .join('\n\n')

    return {
      文本,
      空: !有记忆,
      模式: 'v2',
      查询字数: 查询清理后长度,
      注入字数: 字数(文本),
      selected,
      记忆文本,
      错误: null,
    }
  } catch (错) {
    // ⚠ 故障降级：只给状态块 + 防复读块
    //   **绝不**回退到旧记忆召回，**绝不**临时启用 legacy
    return 失败(错)
  }
}

/** 数字符（按 code point，跟渲染器一致） */
function 字数(s) {
  return Array.from(String(s == null ? '' : s)).length
}

/**
 * 给 /recall/injection/last 用的摘要 —— 只留长度，不留正文。
 * @param {object} 结果 构造V2记忆上下文 的返回值
 * @param {string} sid
 * @param {number} at
 */
export function 上次摘要(结果, sid, at) {
  const r = 结果 && typeof 结果 === 'object' ? 结果 : {}
  return {
    session: String(sid == null ? '' : sid),
    mode: 'v2',
    at: Number.isFinite(at) ? at : null,
    queryChars: Number.isFinite(r.查询字数) ? r.查询字数 : 0,
    selected: r.selected || { facts: 0, episodes: 0, openLoops: 0 },
    injectedChars: Number.isFinite(r.注入字数) ? r.注入字数 : 0,
    empty: !!r.空,
    // ⚠ 只给记忆块（那是要注入的内容，当前用户要能看见到底注入了什么），
    //    不含 query 原文、不含 ID / 分数 / 路径（渲染器已清洗）
    text: typeof r.记忆文本 === 'string' ? r.记忆文本.slice(0, 记忆块上限) : '',
    error: r.错误 ? String(r.错误).slice(0, 诊断查询上限) : null,
  }
}
