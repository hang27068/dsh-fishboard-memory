// qq-runtime-identity.mjs —— 从 DSH 的 `message.source` 解出**本轮可靠的说话人身份**
//
// 为什么要有这个模块（2026-11-05，第四阶段 C）：
//   群聊里 subject=user 是歧义的 —— 当前用户和群友乙的 subject 都是 user。
//   要判「这条事实属于谁」，就必须知道「现在是谁在问」。
//
//   以前拿不到：桥只传 `source: { kind: 'qq' }`，正文里的 `昵称（QQ号）：`
//   是给人看的字符串（昵称里带括号就歪，谁都能照着写一行冒充）。
//   现在桥改成传结构化元数据，这个模块负责**严格地**把它解出来。
//
//   ⚠ 全部规则只在这里实现一份，index.js 不许再散落一套。
//
// 契约（identityVersion 1）：
//   {
//     kind: 'qq',
//     identityVersion: 1,
//     scope: 'group' | 'private',
//     speakerId: 'QQ号字符串',   // 群聊缺失时是 ''
//     speakerName: '显示名',      // 只用于显示
//     messageId: '归档 id',       // 只用于诊断
//     chatId: '群号 / 私聊号',
//   }
//
// 硬规则：
//   · 只认 identityVersion === 1，版本不对 → 不信任
//   · scope 只能是 group / private
//   · 群聊 speakerId 必须是非空数字字符串，否则**留空并 fail closed**
//   · speakerName 只用于显示，**绝不当身份主键**
//   · messageId 只用于诊断，**绝不参与猜身份**
//   · 禁止从正文解析、禁止取最近发言人、禁止默认当前用户的 QQ、禁止按 speakerName 匹配

export const 身份版本 = 1

/** 合法的 scope 取值 */
const 合法范围 = new Set(['group', 'private'])

/** 是不是纯数字串（QQ 号只可能是这个形状） */
function 是数字串(s) {
  return typeof s === 'string' && /^[1-9][0-9]{4,15}$/.test(s)
}

/**
 * 空身份（非 QQ / 私聊某些情况 / 解析失败都用它）
 * @param {string} 原因
 */
function 空身份(原因, 加 = {}) {
  return {
    sourceKind: '',
    scope: '',
    群聊: false,
    说话人: '',
    speakerName: '',
    messageId: '',
    chatId: '',
    有效: false,
    原因,
    ...加,
  }
}

/**
 * 解析一条 DSH message 的 source，得出运行时身份。
 *
 * @param {object|null} source  message.source
 * @returns {{
 *   sourceKind: string, scope: string, 群聊: boolean,
 *   说话人: string, speakerName: string, messageId: string, chatId: string,
 *   有效: boolean, 原因: string
 * }}
 */
export function 解析身份(source) {
  // ── 非 QQ：一律空身份 ──
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return 空身份('消息没有 source')
  }
  const kind = String(source.kind == null ? '' : source.kind)
  if (kind !== 'qq') {
    return 空身份('不是 QQ 消息（kind=' + (kind || '空') + '）')
  }

  // ── 版本：只认 1 ──
  //
  // ⚠ 这条是**防串门**的关键：以后桥升级了字段含义（比如 speakerId 换成
  //   别的意思），老插件必须拒绝，而不是照着旧假设瞎读。
  const 版本 = source.identityVersion
  if (版本 !== 身份版本) {
    return 空身份('identityVersion 不认识（' + String(版本) + '，只认 ' + 身份版本 + '）', {
      sourceKind: kind,
    })
  }

  // ── scope：只认 group / private ──
  const scope = String(source.scope == null ? '' : source.scope)
  if (!合法范围.has(scope)) {
    return 空身份('scope 不合法（' + (scope || '空') + '）', { sourceKind: kind })
  }

  const speakerName = String(source.speakerName == null ? '' : source.speakerName)
  const messageId = String(source.messageId == null ? '' : source.messageId)
  const chatId = String(source.chatId == null ? '' : source.chatId)
  const 原说话人 = String(source.speakerId == null ? '' : source.speakerId)

  // ── 私聊：群聊=false，不需要 speakerId 也能工作 ──
  //
  // 私聊本来就只有一个对话人，主体不存在歧义，所以**不要求** speakerId。
  // 但给了就带着（只用于显示/诊断），给了非法值也**不影响私聊可用**。
  if (scope === 'private') {
    return {
      sourceKind: kind,
      scope,
      群聊: false,
      说话人: 是数字串(原说话人) ? 原说话人 : '',
      speakerName,
      messageId,
      chatId,
      有效: true,
      原因: '私聊（不需要 speakerId）',
    }
  }

  // ── 群聊：speakerId 必须是合法数字串 ──
  //
  // ⚠ 缺失 / 非法 → **说话人留空、继续 fail closed**。
  //   绝不能回退成群号、默认当前用户的号、或者「最近一个说话的人」。
  if (!原说话人) {
    return {
      sourceKind: kind,
      scope,
      群聊: true,
      说话人: '',
      speakerName: '',
      messageId,
      chatId,
      有效: false,
      原因: '群聊但 speakerId 缺失 —— fail closed',
    }
  }
  if (!是数字串(原说话人)) {
    return {
      sourceKind: kind,
      scope,
      群聊: true,
      说话人: '',
      speakerName: '',
      messageId,
      chatId,
      有效: false,
      原因: '群聊 speakerId 不是合法 QQ 号（' + 原说话人 + '）—— fail closed',
    }
  }

  return {
    sourceKind: kind,
    scope,
    群聊: true,
    说话人: 原说话人,
    speakerName,
    messageId,
    chatId,
    有效: true,
    原因: '群聊，speakerId 可靠',
  }
}

/**
 * 诊断用的**安全投影** —— 绝不带正文。
 *
 * 只放这些字段，别把 message 或 content 漏出去。
 *
 * ⚠ `at` 只能由这里产出，调用方**不许再往结果上叠时间**。
 *
 *   2026-11-05 的真实 bug：这里写死 `at: 0`，而调用方是
 *   `{ at: Date.now(), ...身份诊断(身份) }` —— 展开写在后面，
 *   把真实时间**盖成了 0**，于是诊断接口里「最近运行时身份.at」永远是 0。
 *   字段名撞了 + 展开顺序，两个小问题凑成一个查不出来的假数据。
 *
 *   现在只有一个来源：这个参数。调用方显式传 Date.now()，
 *   不传就用此刻；给了非法值也退回此刻 —— 诊断字段的契约是
 *   「一个真实的毫秒时间戳」，产出 0 没有任何信息量，只会像故障。
 *
 * @param {object} 身份
 * @param {number} [时间戳] 毫秒时间戳
 */
export function 身份诊断(身份, 时间戳 = Date.now()) {
  const s = 身份 || {}
  const 给 = Number(时间戳)
  const at = Number.isFinite(给) && 给 > 0 ? Math.floor(给) : Date.now()
  return {
    at,
    sourceKind: String(s.sourceKind || ''),
    scope: String(s.scope || ''),
    群聊: s.群聊 === true,
    说话人: String(s.说话人 || ''),
    speakerName: String(s.speakerName || ''),
    messageId: String(s.messageId || ''),
    有效: s.有效 === true,
    原因: String(s.原因 || ''),
  }
}

/**
 * ⭐⭐⭐ 防串轮：算出「这一轮该用哪个身份」。
 *
 * 这是 index.js 里那道判断的**唯一实现**。抽成纯函数是为了能被测试真实覆盖 ——
 * 放在闭包里的话，测试只能抄一份等价实现，抄件永远不会跟着源码一起坏。
 *
 * 输入：
 *   @param {object} 状态  { 身份, 属于本轮 }  —— inbox 监听维护的两个变量
 *   @param {boolean} 用本轮正文  true = 正文来自本轮 inbox；false = 走了 lastUserTextOf 兜底
 * @returns {object} 可用的运行时身份（不可用时是空身份）
 *
 * 规则：
 *   ① 只有「身份属于本轮 inbox」且「正文也来自本轮 inbox」才认这份身份
 *   ② 只要有一边不成立 → 空身份（群聊 → 群聊=false，私聊行为不变）
 *   ③ 群聊里说话人为空 → 原样传下去，让召回层 fail closed，
 *      **绝不在这里补默认值**（补了就等于谁都能看别人的事实）
 */
export function 选本轮身份(状态, 用本轮正文) {
  const 身份 = (状态 && 状态.身份) || null
  const 属于本轮 = !!(状态 && 状态.属于本轮)

  if (!用本轮正文) {
    return 空身份('正文走了 lastUserTextOf 兜底，上一轮的身份不可复用')
  }
  if (!属于本轮) {
    return 空身份('本轮 inbox 没接住这条消息')
  }
  if (!身份) {
    return 空身份('还没有解析过身份')
  }
  return 身份
}

