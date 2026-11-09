// predicate 注册表 —— D3 后半段按当前用户的规格重做
//
// ⚠⚠ 为什么要这个模块（把踩过的坑写在这里）：
//
//   一开始的做法是「真实模型跑出什么写法，就往别名表里加一条」。
//   影子复验里模型吐了 `user.prefer.communication_style`、
//   `user.communication.style`、`user.dislike.reply_style`，
//   我就照着加——当前用户当场否掉了，理由是这会变成**见一个补一个的无限追加**：
//   模型换个说法，库里就多一条脏 predicate。
//
//   正确的分层是三层，职责绝不混：
//
//     1. **结构归一**（纯字符串，不懂语义）
//        camelCase→snake、小写、连字符/空格→下划线、折叠连续分隔符。
//        只解决「写法」，绝不解决「意思是哪个字段」。
//        ⚠ `prefer` 只能归成命名空间 `preference`，不许从它猜出具体 predicate。
//
//     2. **受控词表**（注册表，人工审核过）
//        每个 canonical 都带 category / cardinality / subjectTypes /
//        valueSchema / status，以及一组**冻结的** aliases。
//        模型输出必须最终落到注册表里的某个 canonical。
//
//     3. **映射裁判**（模型，只判「该归到哪一个」，不许造新的）
//        注册表外的 predicate → 调一次裁判，三态：
//          map      归到注册表内某个 canonical（要过 subject/category/valueSchema 复核）
//          reject   这条候选不写
//          propose  不落库、不扩表，写进 proposals 队列等人看
//        裁判失败/非法 JSON → group fail closed。
//
//   ⚠ 禁止清单（当前用户明确写的）：
//     · 不许 `contains('dislike')` 这种关键词直接映射
//     · 不许按 value 里的单个词映射
//     · 不许允许模型自己造 canonical 直接写入
//     · 不许把未识别的 predicate 原样落库
//     · 不许让别名影响历史 factId（老事实保持原 ID）

/**
 * canonical predicate 注册表。
 *
 * 字段说明：
 *   canonical    规范名，落库就用这个
 *   aliases      **冻结的**已知变体（结构归一之后仍然对不上的那些写法）
 *   category     事实类别
 *   cardinality  基数类型：single / set / composite / temporal
 *   subjectTypes 允许的主体类型
 *   valueSchema  值的形态
 *   status       active = 可用于新事实；其余状态不得写入
 *   note         为什么登记它
 */
export const predicate注册表 = Object.freeze({
  'user.preference.communication_style': {
    canonical: 'user.preference.communication_style',
    aliases: Object.freeze([
      // ── D2 影子复验里真实出现过的 5 条（当前用户点名的）──
      'user.preference.reply_style',        // D2 变体 1
      'user.preference.replystyle',         // D2 变体 2（camelCase 归一后仍无下划线）
      'user.preference.chat_style',         // D2 变体 3
      'user.preference.conversation_style', // D2 变体 4
      'user.preference.speaking_style',     // D2 变体 5
      // ── D3 影子复验里真实出现过的（均已冻结，不再追加）──
      'user.preference.talking_style',
      'user.preference.talk_style',
      'user.preference.speech_style',
      'user.preference.style',
      'user.preference.ai_reply_style',
      'user.preference.ai_style',
      'user.preference.ai_response_style',
      'user.preference.assistant_style',
      'user.preference.response_style',
      'user.preference.reply_preference',
      'user.preference.communication_preference',
      'user.preference.direct_speech',
      'user.preference.directness',
      'user.preference.frankness',
    ]),
    category: 'preference',
    cardinality: 'composite',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '用户希望助手怎么说话。措辞千变万化但语义同一，'
      + '所以是 composite —— 同键不同值必须由关系裁判判 same / distinct。',
  },

  'user.game.plays': {
    canonical: 'user.game.plays',
    aliases: Object.freeze([
      'user.game.play',
      'user.game.playing',
      'user.preference.game',
      'user.hobby.game',
    ]),
    category: 'hobby',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '玩哪些游戏。可以同时玩很多个，所以是 set —— '
      + '「明日方舟」和「卫戍协议」必须并存，不许判冲突。',
  },

  'user.preference.food': {
    canonical: 'user.preference.food',
    aliases: Object.freeze([
      'user.preference.foods',
      'user.preference.eating',
      'user.preference.cuisine',
      'user.food.preference',
    ]),
    category: 'preference',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '爱吃什么。set —— 喜欢的东西可以很多样。',
  },

  'user.preference.drink': {
    canonical: 'user.preference.drink',
    aliases: Object.freeze([
      'user.preference.drinks',
      'user.preference.drinking',
      'user.preference.beverage',
      'user.food.drink',
    ]),
    category: 'preference',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '爱喝什么。set。',
  },

  'user.preference.hobby': {
    canonical: 'user.preference.hobby',
    aliases: Object.freeze([
      'user.preference.hobbies',
      'user.preference.interest',
      'user.preference.interests',
    ]),
    category: 'hobby',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '兴趣。set。',
  },

  'user.preference.music': {
    canonical: 'user.preference.music',
    aliases: Object.freeze([
      'user.preference.musics',
      'user.preference.song',
      'user.preference.band',
    ]),
    category: 'preference',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '听什么。set。',
  },

  // ⭐⭐ 2026-11-09 B3B：负向偏好独立成键。
  //
  //   为什么不能塞进 hobby：
  //     2026-11-09 那次 preview 里「我最讨厌淋雨了」被写成了
  //     `user.preference.hobby = 讨厌淋雨`。
  //     hobby 的语义是「爱好」，「讨厌淋雨」是负向偏好 ——
  //     以后召回「他喜欢什么」时会把「讨厌淋雨」当爱好捞出来，直接变成错话。
  //
  //   ⚠ aliases 故意留空：不设别名就不会有旧数据要靠别名归并，
  //     也让「未知 predicate」这条分流保持干净。
  'user.preference.dislike': {
    canonical: 'user.preference.dislike',
    aliases: Object.freeze([]),
    category: 'preference',
    cardinality: 'set',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '用户明确且稳定表达的负向偏好或厌恶。允许同时存在多个不同对象。'
      + ' value 必须保留极性（「讨厌淋雨」，不能只写「淋雨」）。set。',
  },

  'user.identity.city': {
    canonical: 'user.identity.city',
    aliases: Object.freeze([
      'user.city',
      'user.location.city',
      'user.identity.location',
      'user.identity.residence',
    ]),
    category: 'identity',
    cardinality: 'single',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '住哪。**single** —— 一个人同一时刻只住一个城市，'
      + '不同值必须由关系裁判判 supersedes / contradicts，不许自动并存。',
  },

  'user.identity.school': {
    canonical: 'user.identity.school',
    aliases: Object.freeze(['user.school', 'user.identity.university']),
    category: 'identity',
    cardinality: 'single',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '学校。single。',
  },

  'user.identity.name': {
    canonical: 'user.identity.name',
    aliases: Object.freeze(['user.name', 'user.identity.nickname']),
    category: 'identity',
    cardinality: 'single',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '名字/称呼。single。',
  },

  'user.identity.occupation': {
    canonical: 'user.identity.occupation',
    aliases: Object.freeze(['user.job', 'user.identity.job', 'user.identity.work']),
    category: 'identity',
    cardinality: 'single',
    subjectTypes: Object.freeze(['user', 'fish']),
    valueSchema: 'string',
    status: 'active',
    note: '职业。single。',
  },

  'relationship.callname': {
    canonical: 'relationship.callname',
    aliases: Object.freeze(['relationship.call_name', 'relationship.nickname']),
    category: 'relationship',
    cardinality: 'single',
    subjectTypes: Object.freeze(['relationship']),
    valueSchema: 'string',
    status: 'active',
    note: '互相怎么称呼。single。',
  },
})

/** canonical 名列表（给映射裁判当可选集） */
export const canonical们 = Object.freeze(Object.keys(predicate注册表))

/** 冻结的别名 → canonical（由注册表反推，不单独维护） */
export const predicate别名表 = Object.freeze((() => {
  const 表 = Object.create(null)
  for (const 项 of Object.values(predicate注册表)) {
    for (const a of 项.aliases) 表[a] = 项.canonical
  }
  return 表
})())

/**
 * 结构归一：**只解决写法，不解决语义**。
 *
 * 顺序不能乱：
 *   1. camelCase → snake        （必须先做，否则大写边界一丢就分不出词）
 *   2. 小写
 *   3. 分隔符统一：`-` `/` 空格 → `_`，保留 `.`（`.` 是层级，有意义）
 *   4. 折叠连续分隔符
 *   5. 去首尾分隔符
 *   6. `prefer` / `prefers` **只**归成命名空间 `preference`，
 *      ⚠ 绝不允许从它推断出具体 predicate
 *
 * @returns {string} 结构归一后的形态（**不保证**是 canonical）
 */
export function 结构归一(predicate) {
  let s = String(predicate == null ? '' : predicate).trim()
  if (!s) return ''
  // 1) camelCase → snake
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  // 2) 小写
  s = s.toLowerCase()
  // 3) 分隔符统一（保留点）
  s = s.replace(/[-/\s]+/g, '_')
  // 4) 折叠连续分隔符（含连续的 . 和 ._ / _.）
  s = s.replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_')
  s = s.replace(/\._/g, '.').replace(/_\./g, '.')
  s = s.replace(/_{2,}/g, '_')
  // 5) 去首尾分隔符
  s = s.replace(/^[._]+/, '').replace(/[._]+$/, '')
  // 6) prefer / prefers 只能归一成命名空间 preference
  s = s.replace(/(^|\.)prefers(?=\.|$)/g, '$1preference')
  s = s.replace(/(^|\.)prefer(?=\.|$)/g, '$1preference')
  // 7) ⚠ 兜底：`user_preference_reply_style` / `relationship_callname` 这种
  //    「整串下划线、没有点」的形态 —— 模型有时把层级分隔符全写成下划线。
  //    如果第一段是已知命名空间（user / fish / relationship），
  //    就把**已知的命名空间层级**还原成点。
  //
  //    ⚠ 只还原注册表里真实存在的层级段，绝不猜：
  //      已知第二层 = preference / identity / game / temporary_state
  //      （这些是 canonical 里实际出现的命名空间层）
  //      不在这个集合里的一律不动 → 保持 unknown，交给映射裁判。
  //
  //    ⚠ 这仍然是**纯结构**操作：只是把分隔符放回去，
  //      不做任何语义判断。`prefer` → `preference` 的还原已在第 6 步做过。
  if (!s.includes('.')) {
    const 命名空间层 = ['preference', 'identity', 'game', 'relationship', 'temporary_state']
    const 段 = s.split('_')
    const 首 = 段[0]
    if (首 === 'user' || 首 === 'fish' || 首 === 'relationship') {
      if (段.length >= 2 && 命名空间层.includes(段[1])) {
        s = 首 + '.' + 段.slice(1).join('_').replace(
          /^(preference|identity|game|relationship|temporary_state)_/,
          '$1.',
        )
      } else {
        s = 首 + '.' + 段.slice(1).join('_')
      }
    }
  }
  return s
}

/**
 * 把 predicate 落到注册表。
 *
 * @param {string} predicate 模型给的原始 predicate
 * @returns {{ 归一到: string, 状态: 'canonical'|'alias'|'unknown', 结构形: string }}
 *   canonical —— 结构归一后直接就是注册表里的规范名
 *   alias     —— 结构归一后命中冻结别名表
 *   unknown   —— 对不上，交给映射裁判
 */
export function 归到注册表(predicate) {
  const 结构形 = 结构归一(predicate)
  if (!结构形) return { 归一到: '', 状态: 'unknown', 结构形: '' }
  if (predicate注册表[结构形]) return { 归一到: 结构形, 状态: 'canonical', 结构形 }
  const 别名 = predicate别名表[结构形]
  if (别名) return { 归一到: 别名, 状态: 'alias', 结构形 }
  return { 归一到: '', 状态: 'unknown', 结构形 }
}

/**
 * 取 cardinality（基数类型）。
 *
 * ⚠ 未登记 predicate 默认 single（最保守：宁可进未决冲突，不可静默并存）。
 * ⚠ `user.temporary_state.*` 通配为 temporal，这样新出现的临时状态不用一个个登记。
 */
export function 取基数(predicate) {
  const 项 = predicate注册表[String(predicate || '')]
  if (项 && 项.cardinality) return 项.cardinality
  if (String(predicate || '').startsWith('user.temporary_state.')) return 'temporal'
  return 'single'
}
