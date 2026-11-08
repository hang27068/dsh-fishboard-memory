// 影子召回层（shadow recall）—— 五层记忆的**第四层 A**
//
// ⭐ 2026-11-02 当前用户定的第四阶段 A：根据「当前用户输入」，从长期事实和事件卡里
//   筛选真正相关的记忆，生成一份**受预算约束**的召回预览。
//
// ⚠ 本阶段只做 shadow preview：
//   · 计算召回结果、记录评分与淘汰原因、提供诊断接口
//   · **不接 systemPrompt、不修改模型输入、不影响助手回复**
//   · 不参与 QQ 回复门槛、不调用主动会话
//   · 不改 raw / events / facts / 旧记忆库 / 人格包 / QQ 桥
//   · 不开启任何自动扫描
//
// ⚠ 硬约束：
//   1. **只读** facts 和 events。绝不读 raw、event-state/open、DSH session 历史、
//      assistant/message、压缩摘要、旧记忆库、诊断日志、人格包、QQ 桥。
//   2. **不调用模型**。纯确定性计算，同样输入必得同样输出。
//   3. **不写任何文件**。这个模块连写函数都不引入。
//
// ⭐ 相关性第一版用可测试、可解释的确定性方法：中文 n-gram + 关键词交集 +
//   同义词小词表 + 时间词/实体匹配。绝不引入向量库，绝不为召回再调大模型
//   —— 那样成本、延迟、非确定性都不可控。
//
// ⭐ 架构上预留 semanticScore 接口，当前恒返回 0。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── 预算（当前用户定的默认值） ──────────────────────────────────────────

export const 默认预算 = {
  maxChars: 1200,        // 总字符数上限（中文字符计）
  maxFacts: 5,
  maxEpisodes: 2,
  maxOpenLoops: 2,
  factMaxChars: 120,     // 单条事实
  episodeMaxChars: 220,  // 单条事件
}

/** 最低入选分数（低于这个不选，哪怕预算还有空） */
export const 默认最低分 = 45

// ── 评分权重（范围写死，方便以后调） ──────────────────────────────
//
// totalScore = relevance + importance + confidence + recency + repetition
//              - agePenalty - redundancyPenalty
//
// ⚠ 相关性必须是主要分数：relevance 0~60，其余加起来最多 40。
//   这样一条「很新但完全无关」的记忆数学上赢不过一条「有点旧但很相关」的。

export const 权重 = {
  relevanceMax: 60,
  importanceMax: 15,
  confidenceMax: 10,
  recencyMax: 10,
  repetitionMax: 5,
  agePenaltyMax: 20,
  redundancyPenaltyMax: 30,
}

// ── 会话消毒 ──────────────────────────────────────────────────────

function 干净会话(session) {
  return String(session || '').replace(/[^A-Za-z0-9_-]/g, '')
}

// ── 时间 ──────────────────────────────────────────────────────────

/** 带本地时区的 ISO（不能用 toISOString —— UTC 会跨零点写错天） */
export function 时刻ISO(ms) {
  const d = new Date(ms == null ? Date.now() : ms)
  const 偏 = -d.getTimezoneOffset()
  const 号 = 偏 >= 0 ? '+' : '-'
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const 本 = new Date(d.getTime() + 偏 * 60000).toISOString().slice(0, 19)
  return 本 + 号 + p(偏 / 60) + ':' + p(偏 % 60)
}

// ── 文本处理：n-gram + 关键词 ─────────────────────────────────────

/** 常见虚词，不参与匹配（否则「的」「了」会把一切连起来） */
const 停用词 = new Set([
  // 单字虚词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和',
  '就', '都', '也', '还', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '哈', '嘛',
  '不', '要', '会', '能', '想', '说', '个', '把', '被', '给', '对', '从', '到',
  '得', '怎', '么', '样', '过', '着', '又', '很', '太', '更', '最', '让', '用',
  '做', '去', '来', '上', '下', '里', '外', '好', '多', '少', '大', '小',
  // 多字虚词 / 疑问词
  '一个', '什么', '怎么', '为什么', '可以', '现在', '今天', '已经', '然后', '但是',
  '怎么样', '这个', '那个', '我们', '你们', '他们', '自己', '这样', '那样',
  // 英文
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'as', 'it', 'its',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our',
  'this', 'that', 'these', 'those', 'do', 'does', 'did', 'have', 'has', 'had',
])

/**
 * ⭐ 必须完整保留的双字词 —— 在字符级清洗**之前**先抽出来。
 *
 * ⚠ 为什么需要这个（2026-11-04 灰度实测）：
 *   「爱好」不是停用词，但「爱」是。
 *   切词时所有含停用字的二元组一律丢掉，于是「爱好」根本长不出来；
 *   而字级兜底只在段 ≤ 3 时才跑，产出的是单字「爱」——
 *   结果「爱好」这个词**变成了单字「爱」**，
 *   再经同义扩展变成「爱/喜欢/中意/偏好」整组。
 *   等于「爱好」被降级成了「爱」，还附带四个同义词 —— 全反了。
 *
 * 这里只保护**明确表意、且构不成歧义**的双字词。
 * 不含单字，不做生成，纯白名单，可审计。
 *
 * ⚠ 只需列「含停用字、否则切不出来」或「会被拆坏」的词。
 *   「泡水」「晚课」「抽纸」这种两字都不是停用字的，bigram 本来就能切出来，
 *   列在这里是多余的 —— 不列。
 */
const 保护词 = new Set([
  // 「好」是停用字 → 含它的二元组全丢 → 必须整词保护
  '爱好', '喜好',
  // 「啥」「什」等组合容易碎，且是真实主题词
  '抽纸', '罐头', '纸箱',
  // 「在」「了」是停用字，但「泡在水里」走短语规范，不必在此保护
])

/**
 * ⭐ 短语规范化 —— 把同一个概念的不同说法折到**同一个规范词**上。
 *
 * ⚠ 为什么需要这个（2026-11-04 灰度实测）：
 *   中文按 bigram 切，「泡在水里」被「在」截断只剩「泡在」，
 *   「总泡水里」切出「总泡」，「总待在水里」切出「总待」。
 *   而记忆侧是「泡水」「一半泡水里」。词面**零交集**，
 *   所以「那天你为什么总泡在水里？」永远召不回来 —— 这是真盲区。
 *
 * 做法：命中左边任一写法，就补一个规范词进 token 集。
 *   ⚠ 只补规范词，**不删原词**（原词留着继续参与精确命中判定）。
 *   ⚠ 纯字符串包含判断，不接模型、不做模糊生成、可审计。
 *   ⚠ 规范词必须是「本来就存在、有意义的词」，不能凭空造。
 */
const 短语规范 = [
  // 泡水这件事的几种说法 → 全折到「泡水」
  {
    规范: '泡水',
    写法: ['泡在水里', '泡水里', '待在水里', '待水里', '泡在水下', '总泡水', '总待水'],
  },
]

/**
 * ⭐ 泛化互动词 —— 描述「怎么说话」而不是「在说哪件事」的词。
 *
 * ⚠ 它们**不是停用词**，正常召回时照常参与匹配（可能对上下文有用）。
 *   只在一种情况下特殊处理：当整个查询**只剩这类词**时，
 *   说明用户只是在接话/寒暄，没有要捞任何具体记忆 → 返回空。
 *
 * ⚠ 绝不把它们从词表里删掉 ——
 *   「你当时怎么调侃我看错抽纸的」里「调侃」是真的在用，
 *   删了就丢了「调侃」这个信息，而且用户问的确实是那件事。
 *
 * 收录标准（三条全满足才算）：
 *   1. 它本身不指任何具体的人/物/事/时间/地点
 *   2. 单独出现时不构成一个可检索的「那件事是什么」
 *   3. 它在日常对话里大量出现在「接话」位置（还在… / 你又… / 你怎么…）
 */
const 弱互动词组 = new Set([
  // 互动 / 态度
  '调侃', '吐槽', '开玩笑', '玩笑', '嫌弃', '埋汰', '打趣',
  '觉得', '认为', '感觉', '以为',
  // 泛化提及
  '说过', '讲过', '提过', '聊过', '记得', '忘了', '想起',
  // 泛化时间指代（没有具体日期，指不到任何一件事）
  '当时', '那天', '那次', '刚才', '之前', '上次',
  // 泛化状态/延续
  '还在', '又在', '总是', '老是', '一直',
])

/**
 * 这个 token 是不是泛化互动词。
 *
 * ⚠ 判据要**宽松地覆盖写法**，但不能误伤主题词：
 *   · 完全等于表里的词 → 弱
 *   · 以「还/又/总/老」开头且长度 ≤ 3 的副词性组合（如「还在」「又在」）→ 弱
 *   ⚠ 不做「包含即弱」—— 那会把「调侃抽纸」误判成弱词。
 */
function 弱互动词(t) {
  const s = String(t || '')
  if (!s) return true
  if (弱互动词组.has(s)) return true
  return false
}

/**
 * 把一段文字切成可比较的 token。
 *
 * 中文没有空格，用**二元组（bigram）+ 单字**混合：
 *   · 二元组抓住「马原」「晚课」这种词
 *   · 单字兜底抓住「课」「累」这种单字概念
 * 英文/数字按词切。
 *
 * ⚠ 关键细节：二元组**不能跨停用字**。
 *   否则「上了马原课」会切出「了马」「了原」这种假词，
 *   既污染匹配、又会把不相干的两句话连起来。
 *   所以任何**含停用字的二元组直接丢掉**。
 *
 * ⭐ 2026-11-04 补两道工序（顺序很重要）：
 *   1. **先保护完整词**：白名单里的双字词先整词入集，
 *      再去做字符级清洗 —— 保证「爱好」不会退化成单字「爱」。
 *   2. **短语规范化**：把「泡在水里 / 待在水里 / 总泡水里」
 *      这类说法补一个规范词「泡水」进集，解决词面不交集。
 */
export function 切词(文) {
  const s = String(文 || '').toLowerCase()
  const 出 = new Set()

  // 英文/数字整词
  for (const m of s.matchAll(/[a-z0-9_]+/g)) {
    const w = m[0]
    if (w.length >= 2 && !停用词.has(w)) 出.add(w)
  }

  // ⭐ 工序一：完整词保护（在字符级清洗之前）
  //   只认白名单，长度 ≥ 2，且必须真的出现在原文里
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const 段 = m[0]
    for (const w of 保护词) {
      if (Array.from(w).length >= 2 && 段.includes(w)) 出.add(w)
    }
  }

  // 中文：先抽连续中文段
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const 段 = m[0]
    // 二元组 —— 含停用字的一律不要
    for (let i = 0; i + 2 <= 段.length; i++) {
      const a = 段[i]
      const b = 段[i + 1]
      if (停用词.has(a) || 停用词.has(b)) continue
      出.add(a + b)
    }
    // 单字兜底：只在段很短时加，避免噪音太大
    if (段.length <= 3) {
      for (const c of 段) {
        if (!停用词.has(c)) 出.add(c)
      }
    }
  }

  // ⭐ 工序三：短语规范化（只补规范词，不删原词）
  for (const { 规范, 写法 } of 短语规范) {
    if (写法.some((w) => s.includes(w))) 出.add(规范)
  }

  return 出
}

/**
 * 同义词小词表 —— 只做**极少量**扩展，够用就行。
 * 边界：键是标准词，值是它的近义写法。匹配时双向展开。
 *
 * ⚠ 2026-11-02 踩过的坑：这里不能放**单字**当键。
 *   原来有 `'课': ['课程','上课','课表']`，结果查「马原课」时，
 *   单字「课」把「课程/上课/课表」全拉进来（4 个命中 × 各 0.4 权重 = 1.6），
 *   反而压过了真正命中「马原」「原课」的那句话（2 个命中 × 1.0 = 2.0 但分数被摊薄）。
 *   一句话说：**同义词扩展会把单字的噪音放大**。
 *   所以只允许长度 ≥ 2 的键。
 */
const 同义 = {
  '不喜欢': ['讨厌', '烦', '反感', '不爱'],
  '喜欢': ['爱', '中意', '偏好'],
  '正式': ['正经', '客套', '官腔', '端着'],
  '回复': ['回话', '答', '说话', '回'],
  '累': ['疲惫', '乏', '撑不住', '没力气'],
  '睡觉': ['睡眠', '入睡', '躺下'],
  '工作': ['上班', '干活', '班'],
  '游戏': ['打游戏', '玩', '明日方舟', '卫戍协议'],
  '叫法': ['称呼', '叫我', '怎么叫'],
  '老大': ['老板'],
  '课程': ['上课', '课表', '晚课'],
}

/** 把 token 集合按同义词表扩展一遍 */
export function 扩展同义(tokens) {
  const 出 = new Set(tokens)
  for (const [标准, 们] of Object.entries(同义)) {
    // ⚠ 单字键一律跳过（见上面的教训）
    if (Array.from(标准).length < 2) continue
    const 全部 = [标准, ...们]
    const 命中 = 全部.some((w) => tokens.has(w))
    if (命中) for (const w of 全部) 出.add(w)
  }
  return 出
}

// ⭐⭐⭐ 2026-11-03 第四阶段 B 同义词重复计分边界修复
//
// 问题：扩展同义() 会把一个概念扩成整组（喜欢 → 喜欢、爱、中意、偏好），
//   而算相关性() 随后把交集里每个词当成**独立证据**各加一次权重。
//   于是一个「喜欢/爱好」概念被算四遍 → 无关事件的 relevance 虚增到 45。
//
//   线上实例：查「你觉得猫为什么喜欢纸箱？」时，
//   「鲸鱼娘泡水与下课等候」那张卡里有一句「对方说泡水是休息、是爱好」，
//   命中「爱好」→ 扩展出整组四个词 → 4 × 1.0 = 4.0 加权 → 基础分封顶 38
//   → 加上覆盖分变成 45 → 刚好压过最低分门槛 45 → 串话题。
//
// 修法：给每个同义词组建**概念键**，算分时同一概念最多计一次。
//   这不是「少算了」，而是「本来就该算一次」——
//   同义词是同一个概念的不同写法，不是四条独立证据。
//
// ⚠ 不能靠提高全局最低分掩盖（那会连真该召回的也一起挡掉）；
//   不能删掉同义匹配（「喜欢泡水」这类查询要靠它）；
//   不能针对「猫」「纸箱」「泡水」写死补丁。

/** token → 它所属的概念键（同一同义词组共用一个键）；不在任何组里就返回它自己 */
const 概念键表 = (() => {
  const 表 = new Map()
  for (const [标准, 们] of Object.entries(同义)) {
    if (Array.from(标准).length < 2) continue
    // 概念键用**表里那个标准词**（Object.entries 顺序稳定），读起来也最顺
    const 键 = '组:' + 标准
    const 全部 = [标准, ...们]
    for (const w of 全部) {
      // ⚠ 一个词可能同时出现在多个组里（比如「不爱」在「不喜欢」组、「爱」在「喜欢」组）。
      //   只认第一个登记的组 —— 保证「一词一键」是确定的，不随遍历顺序漂。
      if (!表.has(w)) 表.set(w, 键)
    }
  }
  return 表
})()

/**
 * 取一个 token 的概念键。
 * 同组的不同写法拿到**同一个键**，于是算分时能折叠成一次命中。
 */
export function 概念键(t) {
  const s = String(t == null ? '' : t)
  return 概念键表.get(s) || ('词:' + s)
}

// ══════════════════════════════════════════════════════════════════
// 查询答案槽（answerability slot）
// ══════════════════════════════════════════════════════════════════
//
// ⭐⭐ 2026-11-08 当前用户的验收现场：
//   查「我固定和几个人玩游戏」时，「晚上经常和朋友一起打游戏」被召回了，
//   51 分压过门槛 45。但它**答不了这个问题** —— 用户问几个，事实里没有人数。
//
// 病根不是相关性算错，是**相关性根本不检查「答不答得上」**：
//   两边都含「游戏」→ 同义组满额命中 → relevance 24 → 加上基础分过线。
//   话题确实相同，但候选缺了回答所需的那个槽位。
//
// ⚠ 当前用户定的修法边界（一条都不能违）：
//   · 不提高全局最低分 45
//   · 不针对「游戏」或某一句测试话写死拦截
//   · 不靠拆同义表过关（复算表明只拆表解决不了）
//   · 缺槽必须是**硬拒绝**，不是扣几分
//   · 规则只能有一处，不许散成多个特殊补丁
//
// 所以这里做的是**独立于相关性的一层确定性检查**，
// 在过线判定里对 **fact 和 event 走同一个函数**（见 过线()）。

/** 答案槽清单。每项：查询怎么问 */
export const 答案槽 = Object.freeze({
  participant_count: Object.freeze({
    说明: '查询在问人数',
    问法: Object.freeze([
      '几个人', '多少人', '人数', '几位', '几个朋友', '几个队友',
      '几个同学', '几个同事',
    ]),
  }),
  duration: Object.freeze({
    说明: '查询在问时长',
    问法: Object.freeze([
      '多久', '多长时间', '几小时', '几个小时', '多少小时', '多少时间',
      '几十分钟', '几分钟', '花多久', '玩多久',
    ]),
  }),
  time: Object.freeze({
    说明: '查询在问时间点/时段',
    问法: Object.freeze([
      '什么时候', '几点', '什么时间', '哪个时间', '啥时候',
    ]),
  }),
})

/** 稳定性要求：查询里出现这些词，说明问的是「长期固定」而不是「某一次」 */
const 稳定性词 = Object.freeze(new Set([
  '固定', '通常', '一般', '总是', '每次', '平常', '平时', '一向', '向来', '习惯',
]))

/**
 * 中文数字 / 阿拉伯数字 / 数量词 —— 判断候选里有没有「真正的人数」。
 *
 * ⚠ 「朋友」「一起」「他们」**不算**人数 —— 它们不回答「几个」。
 *   这是当前用户明确点名的：`"朋友"、"一起"、"他们" 不等于人数答案`。
 *
 * ⚠⚠ 2026-11-08 第二次收紧（当前用户点出来的）：
 *   上一版让「一些/一群/一帮/一半」**自带数量义**、不需要人类单位也返回 true。
 *   结果是「我喜欢一些游戏」被判成有人数 —— 拿数量词冒充人数。
 *
 *   「一些游戏」「一群鱼」「一帮代码」「一半时间」都不是人数。
 *   所以现在**没有例外**：任何数量词都必须紧跟人类单位。
 */
const 个数数字 = Object.freeze(new Set([
  '一', '二', '两', '三', '四', '五', '六', '七', '八', '九', '十',
  '几', '半', '俩', '仨',
]))
const 数量词 = Object.freeze([
  '一个', '两个', '俩个', '三个', '仨', '四个', '五个', '六个', '七个', '八个', '九个', '十个',
  '几个', '一些', '一群', '一帮', '一双', '一半',
])
/** 人类单位 —— 数量词**必须**紧跟其中之一才算人数 */
const 人数单位 = Object.freeze([
  '人', '个人', '位',
  '朋友', '队友', '成员', '同学', '同事', '同伴', '伙伴',
  '玩家', '室友', '哥们', '姐妹',
])

/** 「位」后面跟这些字就不是人（位置/位数…） */
const 非人后缀 = Object.freeze(['置', '数', '于'])

/**
 * 找「人数」表达。
 *
 * 规则（两条都要满足）：
 *   ① 出现数字或数量词
 *   ② 它**紧跟**人类单位
 *
 * ⚠ 为什么要求相邻：「晚上和朋友玩三个小时」里有「三」也有「朋友」，
 *   但那是时长不是三人。不相邻就会误判。
 *
 * ⚠⚠ 2026-11-08 收紧：上一版曾让「一些/一群/一帮/一半」自带数量义、
 *   不需要人类单位也返回 true —— 于是「我喜欢一些游戏」被判成有人数。
 *   现在**没有任何豁免**：数量词后面必须紧跟人类单位。
 *
 * @returns {{有:boolean, 证据:string}}
 */
export function 找人数表达(文本) {
  const s = String(文本 == null ? '' : 文本)
  if (!s) return { 有: false, 证据: '' }

  // 位置 i 之后是不是人类单位；是就返回单位词
  const 后接单位 = (i, 长) => {
    const 后 = s.slice(i + 长, i + 长 + 3)
    for (const u of 人数单位) {
      if (!后.startsWith(u)) continue
      // 「位」要排除「位置/位数」
      if (u === '位' && 非人后缀.includes(后.slice(1, 2))) continue
      return u
    }
    return ''
  }

  // ① 数量词整体（三个、几个、一些、一群…）—— 一律必须紧跟人类单位
  for (const q of 数量词) {
    let i = s.indexOf(q)
    while (i >= 0) {
      const 单位 = 后接单位(i, q.length)
      if (单位) return { 有: true, 证据: q + 单位 }
      i = s.indexOf(q, i + 1)
    }
  }

  // ② 阿拉伯数字 + 人类单位（3个人 / 5位 / 12个朋友）
  const 单位模式 = 人数单位.map((u) => u).join('|')
  const 阿 = s.match(new RegExp('(\\d+)\\s*个?\\s*(' + 单位模式 + ')'))
  if (阿 && !(阿[2] === '位' && 非人后缀.includes(s.slice(阿.index + 阿[0].length, 阿.index + 阿[0].length + 1)))) {
    return { 有: true, 证据: 阿[0] }
  }

  // ②b 中文多位数字（几十、十几、一百、一千…）+ 人类单位
  const 多 = s.match(new RegExp('([一二两三四五六七八九十百千万几]+)\\s*个?\\s*(' + 单位模式 + ')'))
  if (多 && !(多[2] === '位' && 非人后缀.includes(s.slice(多.index + 多[0].length, 多.index + 多[0].length + 1)))) {
    return { 有: true, 证据: 多[0] }
  }

  // ③ 单个中文数字 + 人类单位（三人、俩人、五个人）
  for (const d of 个数数字) {
    let i = s.indexOf(d)
    while (i >= 0) {
      const 单位 = 后接单位(i, d.length)
      if (单位) return { 有: true, 证据: d + 单位 }
      i = s.indexOf(d, i + 1)
    }
  }

  return { 有: false, 证据: '' }
}

/** 时长单位与表达 */
const 时长单位 = Object.freeze(['小时', '分钟', '钟头', '刻钟', '秒'])
const 时长词 = Object.freeze(['半天', '一整天', '整晚', '通宵', '好一会', '一会儿', '一阵'])

/** 时段表达（自包含，不依赖文件后部的 时间词） */
const 时段词表 = Object.freeze([
  '早上', '上午', '中午', '下午', '晚上', '傍晚', '凌晨', '半夜', '深夜',
  '今晚', '明晚', '昨晚', '白天', '夜里', '早晨', '清早', '午后',
  '周末', '工作日', '放学', '下班', '睡前', '饭后',
  '今天', '明天', '昨天', '后天', '前天', '现在',
])

/** 找时长表达 */
export function 找时长表达(文本) {
  const s = String(文本 == null ? '' : 文本)
  if (!s) return { 有: false, 证据: '' }
  const m = s.match(/(\d+|[一二两三四五六七八九十半几两])\s*个?\s*(小时|分钟|钟头|刻钟)/)
  if (m) return { 有: true, 证据: m[0] }
  for (const w of 时长词) if (s.includes(w)) return { 有: true, 证据: w }
  for (const w of 时长单位) if (s.includes(w)) return { 有: true, 证据: w }
  return { 有: false, 证据: '' }
}

/** 找时间表达 */
export function 找时间表达(文本) {
  const s = String(文本 == null ? '' : 文本)
  if (!s) return { 有: false, 证据: '' }
  const m = s.match(/(\d+|[一二两三四五六七八九十]+)\s*点(半|钟)?/)
  if (m) return { 有: true, 证据: m[0] }
  for (const w of 时段词表) if (s.includes(w)) return { 有: true, 证据: w }
  return { 有: false, 证据: '' }
}

/**
 * 抽查询**主题锚点** —— 去掉答案槽问法、稳定性词、结构词之后剩下的真正话题。
 *
 * ⚠⚠ 2026-11-08 第三次收紧（当前用户点出来的「跨 highlight 拼接」）：
 *
 *   现场：查「那次有几个人一起玩」，事件有两条要点
 *     · 一起玩游戏      ← 有话题，没人数
 *     · 三个人一起吃饭  ← 有人数，没话题
 *   两条各得 35 分都进了 候.text，拼成「一起玩游戏；三个人一起吃饭」。
 *   人数来自「吃饭」，玩的主题来自另一句 —— **答案被拼出来了**。
 *
 *   修法：查询要槽位时，槽证据和话题必须在**同一条 highlight 里**成立。
 *   所以先得把「话题」从查询里剥干净。
 *
 * ⚠ 剥的顺序：
 *   ① 先剥槽位问法（几个人、多久、什么时候）—— 这些是「要什么」，不是「关于什么」
 *   ② 再剥稳定性词（固定、通常）—— 这些是「什么性质」，不是话题
 *   ③ 再剥结构/场景词（一起、那次、当时）—— 这些不指向任何具体事
 *   ④ 剩下才是主题
 *
 * ⚠ 剥完如果什么都不剩（例如用户只问「有几个人」），
 *   那就没有主题可锚 —— 这时只按槽证据处理（见 判要点能否独立回答）。
 *
 * @param {string} 查询原文
 * @returns {{锚点:string[], 剥离后文本:string, 只有槽:boolean}}
 */
export function 抽主题锚点(查询原文) {
  let s = String(查询原文 == null ? '' : 查询原文)

  // ① 剥槽位问法（含同义问法）
  for (const 定 of Object.values(答案槽)) {
    for (const w of 定.问法) s = s.split(w).join(' ')
  }
  for (const w of ['多少', '几个', '几位', '几人', '几小时', '多久', '多长时间',
    '什么时候', '几点', '什么时间', '哪一次', '哪回']) {
    s = s.split(w).join(' ')
  }

  // ② 剥稳定性词
  for (const w of 稳定性词) s = s.split(w).join(' ')

  // ③ 剥结构 / 场景词 —— 这些不指向任何具体事
  //
  //   ⚠ 「那次」「当时」这类是**弱指代**，正是它们把「吃饭」和「玩」
  //     连在一起的桥梁，必须剥掉。
  //   ⚠⚠ 只剥「一起」，**不能剥「一起玩」** —— 那样会把主题字「玩」一起吃掉，
  //     于是锚点变空，判据退化成「只按槽证据」，「三个人一起吃饭」就混进来了。
  for (const w of ['那次', '这次', '当时', '那天', '哪次', '一回',
    '一起', '我们', '他们', '你们', '大家']) {
    s = s.split(w).join(' ')
  }

  s = s.replace(/\s+/g, ' ').trim()

  // ④ 切词 + 同义扩展，再剔掉不该当锚点的东西
  const 扩 = 扩展同义(切词(s))

  const 不该当锚 = (t) => {
    if (!t) return true
    if (弱互动词(t)) return true
    if (稳定性词.has(t)) return true
    if (/^\d+$/.test(t)) return true
    if (个数数字.has(t)) return true
    // 单字 token 太弱（「人」「三」都会混进来）
    if (Array.from(t).length < 2) return true
    // 回答槽本身形成的 token
    for (const 定 of Object.values(答案槽)) {
      if (定.问法.some((w) => t.includes(w) || w.includes(t))) return true
    }
    // 人数单位里的纯度量词不能当主题
    if (t === '个人' || t === '位') return true
    return false
  }

  const 锚点 = [...扩].filter((t) => !不该当锚(t))

  // ⭐⭐ 2026-11-08：**单字主题补捞**
  //
  // ⚠ 为什么需要这一步（实测出来的）：
  //   查「那次有几个人一起玩」，剥掉「那次」「几个人」「一起」之后只剩「有」。
  //   切词把「有」当停用字扔掉 → 锚点为空 → 判据退化成「只按槽证据」，
  //   于是「三个人一起吃饭」会被判成能独立回答人数问题 —— **又串回去了**。
  //
  //   病根：查询里的主题词「玩」只有一个字，切词规则要求二元组，
  //   「玩」单独出现时抓不到。
  //
  //   做法：在**剥离后的原文**里，找出那些「不是停用字、不是数字、
  //   不是槽位词」的单字，把它们也当锚点候选。
  //   ⚠ 这些单字必须是**查询原文里真的有的字**，不是猜出来的。
  for (const ch of Array.from(s)) {
    if (!/[\u4e00-\u9fff]/.test(ch)) continue
    if (锚点.includes(ch)) continue
    if (停用词.has(ch)) continue
    if (稳定性词.has(ch)) continue
    if (个数数字.has(ch)) continue
    // 槽位词里的字（人、久、候…）不能当主题
    let 是槽字 = false
    for (const 定 of Object.values(答案槽)) {
      if (定.问法.some((w) => w.includes(ch))) { 是槽字 = true; break }
    }
    if (是槽字) continue
    锚点.push(ch)
  }

  return { 锚点, 剥离后文本: s, 只有槽: 锚点.length === 0 }
}

/**
 * 逐条 highlight 判「这条自己能不能独立回答」。
 *
 * ⭐ 规则（当前用户的原话）：
 *   「该 highlight 是否含查询要求的答案槽证据」
 *   「该 highlight 是否同时匹配查询的非槽位主题」
 *   「两项必须在同一条 highlight 中成立」
 *   「不允许从一条 highlight 取话题、另一条取人数/时间/时长」
 *   「不允许标题提供话题、无主题的 highlight 只提供答案后拼接通过」
 *
 * @param {string} 要点   单条 highlight 原文
 * @param {string[]} 槽们 查询要求的槽
 * @param {string[]} 锚点 查询的主题锚点
 * @returns {{独立可答:boolean, 有槽证据:boolean, 命中锚点:string[], 缺什么:string}}
 */
export function 判要点能否独立回答(要点, 槽们, 锚点) {
  const 文 = String(要点 == null ? '' : 要点)
  if (!文) return { 独立可答: false, 有槽证据: false, 命中锚点: [], 缺什么: '空要点' }

  // ① 槽证据
  let 有槽证据 = true
  let 缺槽 = ''
  for (const 槽 of 槽们) {
    let 有 = false
    if (槽 === 'participant_count') 有 = 找人数表达(文).有
    else if (槽 === 'duration') 有 = 找时长表达(文).有
    else if (槽 === 'time') 有 = 找时间表达(文).有
    if (!有) { 有槽证据 = false; 缺槽 = 槽; break }
  }

  // ② 主题锚点
  //
  //   ⚠ 没有锚点（用户只问「有几个人」）→ 不做主题要求，只按槽证据判。
  //     当前用户明确允许这个回退，但要求有明确测试。
  if (!锚点.length) {
    return {
      独立可答: 有槽证据, 有槽证据, 命中锚点: [],
      缺什么: 有槽证据 ? '' : '这条要点没有「' + 缺槽 + '」的证据',
    }
  }

  const 原始token = 切词(文)
  const 命中锚点 = 锚点.filter((a) => {
    if (文.includes(a)) return true            // 锚点原文就在要点里
    if (原始token.has(a)) return true          // 或作为 token 命中
    const a键 = 概念键(a)                       // 或同概念组里有词命中
    if (a键.startsWith('组:')) {
      for (const t of 原始token) if (概念键(t) === a键) return true
    }
    return false
  })

  const 有主题 = 命中锚点.length > 0
  if (!有槽证据 && !有主题) {
    return {
      独立可答: false, 有槽证据, 命中锚点,
      缺什么: '既没有「' + 缺槽 + '」的证据，话题也不是查询问的那件事',
    }
  }
  if (!有槽证据) {
    return {
      独立可答: false, 有槽证据, 命中锚点,
      缺什么: '话题对得上，但没有「' + 缺槽 + '」的证据',
    }
  }
  if (!有主题) {
    return {
      独立可答: false, 有槽证据, 命中锚点,
      缺什么: '有「' + 槽们.join('/') + '」的证据，但话题不是查询问的那件事'
        + '（查询话题：' + 锚点.join('、') + '）',
    }
  }
  return { 独立可答: true, 有槽证据, 命中锚点, 缺什么: '' }
}

/**
 * 抽出查询**要求**的答案槽。
 * @returns {{槽们:string[], 要稳定:boolean, 稳定词:string, 命中问法:object}}
 */
export function 抽查询答案槽(查询原文) {
  const q = String(查询原文 == null ? '' : 查询原文)
  const 槽们 = []
  const 命中问法 = {}
  for (const [名, 定] of Object.entries(答案槽)) {
    for (const w of 定.问法) {
      if (q.includes(w)) {
        槽们.push(名)
        命中问法[名] = w
        break
      }
    }
  }
  let 要稳定 = false
  let 稳定词 = ''
  for (const w of 稳定性词) {
    if (q.includes(w)) { 要稳定 = true; 稳定词 = w; break }
  }
  return { 槽们, 要稳定, 稳定词, 命中问法 }
}

/**
 * ⭐⭐ 核心：判断候选能不能回答查询要求的槽。
 *
 * ⚠ 对 fact 和 event 走**同一个函数**，不按类型分叉。
 *   两者字段不同，所以调用方先取一份「真正会展示的文本」
 *   （事实用 value，事件用 title+summary），取不到就是答不上。
 *
 * @param {object} 参 { 查询原文, 候选文本, 候选类型, 候选类目 }
 * @returns {{可答:boolean, 缺槽:string, 诊断:object|null}}
 */
export function 查答案槽(参 = {}) {
  const 查询原文 = String(参.查询原文 == null ? '' : 参.查询原文)
  const 候选文本 = String(参.候选文本 == null ? '' : 参.候选文本)
  const 候选类型 = String(参.候选类型 || '')
  const 候选类目 = String(参.候选类目 || '')

  const 求 = 抽查询答案槽(查询原文)
  if (!求.槽们.length) return { 可答: true, 缺槽: '', 诊断: null }

  for (const 槽 of 求.槽们) {
    let 有 = false
    let 缺什么 = ''

    if (槽 === 'participant_count') {
      有 = 找人数表达(候选文本).有
      缺什么 = '候选没有可回答人数的信息（需要数字/数量词**紧跟**人类单位，'
        + '例如「三个人」「两个朋友」「一群同学」；'
        + '「一些游戏」「三个小时」「两个问题」都不算人数）'
    } else if (槽 === 'duration') {
      有 = 找时长表达(候选文本).有
      缺什么 = '候选没有可回答时长的信息（需要小时/分钟/钟头这类时长表达）'
    } else if (槽 === 'time') {
      有 = 找时间表达(候选文本).有
      缺什么 = '候选没有可回答时间的信息（需要时段词或几点这种时间表达）'
    }

    if (!有) {
      return {
        可答: false,
        缺槽: 槽,
        诊断: {
          reason: 'answerability_slot_missing',
          requestedSlot: 槽,
          candidateType: 候选类型,
          candidateCategory: 候选类目,
          askedBy: 求.命中问法[槽] || '',
          // ⚠ 必须是**实际参与检查的完整文本**，不许截断 ——
          //   截断会让诊断与判定依据不一致（人数字段可能在 60 字之后）。
          candidateText: 候选文本,
          missing: 缺什么,
          // ⚠ 只记录对候选文本**当场算出来**的事实，不写任何推测
          candidateHasNumber: 槽 === 'participant_count' ? 找人数表达(候选文本).有 : undefined,
        },
      }
    }
  }

  // ⭐ 稳定性边界：查询要「固定」时，单次记录不能当长期答案
  //
  // 当前用户的原话：
  //   「单次事件中的『三个人一起玩』不能回答『固定几个人』」
  //   「只有候选本身含稳定性表达和明确人数时才允许回答」
  //   「episodic 事件不能仅凭一次人数记录推导长期固定人数」
  if (求.要稳定 && 求.槽们.includes('participant_count')) {
    const 人数证据 = 找人数表达(候选文本).有
    if (候选类型 === 'event') {
      return {
        可答: false,
        缺槽: 'stability',
        诊断: {
          reason: 'answerability_slot_missing',
          requestedSlot: 'participant_count',
          candidateType: 候选类型,
          candidateCategory: 候选类目,
          askedBy: 求.命中问法.participant_count || '',
          stabilityAskedBy: 求.稳定词,
          candidateText: 候选文本,
          missing: '查询要求「' + 求.稳定词 + '」这种长期稳定性；'
            + '事件卡记录的是某一次的情况，不能由一次人数推出长期固定人数',
          candidateHasNumber: 人数证据,
        },
      }
    }
    // fact 侧：必须**自己**含稳定性表达，不能只靠查询带
    if (!抽查询答案槽(候选文本).要稳定) {
      return {
        可答: false,
        缺槽: 'stability',
        诊断: {
          reason: 'answerability_slot_missing',
          requestedSlot: 'participant_count',
          candidateType: 候选类型,
          candidateCategory: 候选类目,
          askedBy: 求.命中问法.participant_count || '',
          stabilityAskedBy: 求.稳定词,
          candidateText: 候选文本,
          missing: '查询要求「' + 求.稳定词 + '」这种长期稳定性，'
            + '但候选本身没有任何稳定性表达（通常/固定/一般…），不能当作长期答案',
          candidateHasNumber: 人数证据,
        },
      }
    }
  }

  return { 可答: true, 缺槽: '', 诊断: null }
}

// ══════════════════════════════════════════════════════════════════
// 诊断真实性：命中词必须真的出现在原文里
// ══════════════════════════════════════════════════════════════════

/**
 * ⭐⭐ 2026-11-08：reasonSelected 曾经显示「匹配『明日方舟』」，
 *   而「明日方舟」既不在查询里也不在候选里 —— 它只存在于同义扩展表内部。
 *
 * 这等于**伪造原文命中证据**。当前用户的原话：
 *   「不得再显示只存在于同义扩展表中的『明日方舟』等词」
 *   「同义扩展词可以参与内部算分，但不得冒充原文命中证据」
 *
 * ⚠ 第一次实现时我给这类词加了 `≈` 前缀想「明确标记成概念」，
 *   但那仍然把「明日方舟」这四个字摆在了人眼前 —— 当前用户要的是**不显示**。
 *   「明确标记后的规范概念名」指的是 `组:游戏` 这种**规范概念名**，
 *   不是把组里的某个成员词拎出来加个前缀冒充。
 *
 * 三类处理：
 *   · 原文命中：查询原文或候选原文里**真的有这个词** → 显示
 *   · 规范概念：两边原文都没有，但同义组里有真实成员被命中
 *               → 只显示规范概念名（`组:xxx` 形式），不显示成员词
 *   · 丢弃：两边原文都没有、同义组里也没有真实成员的 → 绝不显示
 */
export function 过滤真实命中(命中们, 查询原文, 候选原文) {
  const 查 = String(查询原文 == null ? '' : 查询原文)
  const 候 = String(候选原文 == null ? '' : 候选原文)
  const 原文命中 = []
  const 规范概念 = []
  const 丢弃 = []

  for (const t of (Array.isArray(命中们) ? 命中们 : [])) {
    const 词 = String(t == null ? '' : t)
    if (!词) continue
    if (查.includes(词) || 候.includes(词)) {
      原文命中.push(词)
      continue
    }
    // 不在任何原文里 → 找它所属的同义组。
    // 只有当该组在**查询或候选原文里确实有一个成员词**时，
    // 才承认「这个概念被命中了」—— 但对外只给规范概念名，不给成员词。
    const 键 = 概念键(词)
    let 有真实成员 = false
    for (const [标准, 们] of Object.entries(同义)) {
      if ('组:' + 标准 !== 键) continue
      for (const w of [标准, ...们]) {
        if (查.includes(w) || 候.includes(w)) { 有真实成员 = true; break }
      }
      break
    }
    if (有真实成员 && 键.startsWith('组:')) {
      // 只留规范概念名，且去重
      if (!规范概念.includes(键)) 规范概念.push(键)
    } else {
      丢弃.push(词)
    }
  }

  return {
    // 展示用：原文命中优先；概念用 `概念:xxx` 这种规范名，绝不含成员词
    显示: [...原文命中, ...规范概念.map((k) => '概念:' + k.slice(2))],
    原文命中,
    规范概念,
    丢弃,
  }
}

/**
 * 把一组命中 token 按概念折叠，返回：
 *   · 加权：折叠后的权重和（同一概念只算一次，取该组里命中词的最长权重）
 *   · 命中：折叠后的代表词（同一概念只留一个，不会再同时列出整组）
 *
 * ⚠ 为什么权重取「组里命中的最长词」而不是固定值：
 *   命中「不喜欢」比命中「喜欢」更有信息量，不能因为折叠就一律按 1.0 算。
 */
export function 折叠概念(命中们, 词权) {
  const 每组 = new Map() // 概念键 -> { 词, 权 }
  for (const t of 命中们) {
    const 键 = 概念键(t)
    const 权 = 词权(t)
    const 旧 = 每组.get(键)
    // 同一概念里保留权重最高的那个词当代表
    if (!旧 || 权 > 旧.权) 每组.set(键, { 词: t, 权 })
  }
  let 加权 = 0
  const 命中 = []
  for (const { 词, 权 } of 每组.values()) {
    加权 += 权
    命中.push(词)
  }
  return { 加权, 命中, 概念数: 每组.size }
}

/** 中文数字/相对时间词 —— 用来给「今天」「明天」这类做匹配 */
const 时间词 = new Set([
  '今天', '明天', '昨天', '后天', '前天', '现在', '今晚', '明晚', '昨晚',
  '早上', '上午', '中午', '下午', '晚上', '凌晨', '半夜',
  '这周', '下周', '上周', '周末', '周一', '周二', '周三', '周四', '周五', '周六', '周日',
])

// ── 相关性（确定性） ──────────────────────────────────────────────

/**
 * 算相关性分（0 ~ relevanceMax=60）。
 *
 * 思路（按可信度加权，不数个数）：
 *   · 命中的 token **越长越可信** —— 「马原」命中比「课」命中值钱得多
 *   · 覆盖率：命中占查询全部 token 的比例，越高越相关
 *   · 时间词命中单独加一点
 *
 * ⚠ 完全没交集 → 0 分。这是「无关问题返回空结果」的地基。
 * ⚠ 不许因为别的加分项把 0 相关的记忆凑进来 —— 上层还有一道硬闸。
 *
 * @returns {{score:number, 命中:string[], semanticScore:number}}
 */
export function 算相关性(查询token集, 记忆token集, 选 = {}) {
  // ⭐⭐⭐ 2026-11-03 修复：这里要**同时**看两套 token
  //
  //   · 查询/记忆（可能已扩展）：用来找「同义概念命中」
  //   · 原始 token 交集：用来找「原词精确命中」
  //
  // ⚠ 两套必须分开。拿扩展后的集合去判「精确命中」，
  //   「喜欢」和「爱」就又变成两个精确证据了 —— 正是要修的那个 bug。
  const 查询 = 查询token集 instanceof Set ? 查询token集 : 扩展同义(切词(查询token集))
  const 记忆 = 记忆token集 instanceof Set ? 记忆token集 : 扩展同义(切词(记忆token集))

  // 原始（未扩展）token：精确命中只在它们之间比
  const 原始查询 = 选.原始查询 instanceof Set ? 选.原始查询 : null
  const 原始记忆 = 选.原始记忆 instanceof Set ? 选.原始记忆 : null

  if (!查询.size) return { score: 0, 命中: [], semanticScore: 0 }

  const 交集 = []
  for (const t of 查询) {
    if (记忆.has(t)) 交集.push(t)
  }

  // ⚠ 没有交集就是 0
  if (!交集.length) return { score: 0, 命中: [], semanticScore: 0 }

  // ── 加权命中量 ──
  // 每个命中 token 的权重：二字词 1.0，三字 1.5，四字及以上 2.0
  // 单字 0.4（中文单字歧义太大，值钱有限）
  const 词权 = (t) => {
    const n = Array.from(t).length
    if (n <= 1) return 0.4
    if (n === 2) return 1.0
    if (n === 3) return 1.5
    return 2.0
  }

  // ⭐⭐⭐ 2026-11-03 修复：**先按概念折叠，再算加权**
  //
  // 原来这里直接 `for (const t of 交集) 加权 += 词权(t)`，
  // 于是「喜欢/爱/中意/偏好」四个词各加一次 = 4 份独立证据 —— 一个概念被算四遍。
  // 现在同一同义词组只保留一次命中（取组内权重最高的那个词代表）。
  //
  // ⚠ 这不是放宽也不是收紧全局，是把「同一个概念」还原成一次证据。
  //
  // ⭐ 折叠加了之后出现一个新问题，这里一并解决：
  //   「晚课」这种**查询词和候选词一模一样**的硬匹配，折完也只剩 1 份分，
  //   跟「喜欢 → 爱」这种靠同义表牵线的软匹配一样多。可信度差得远，不该等价。
  //
  //   所以对**属于同义词组的概念**区分两类命中：
  //     · 原词实打实命中 → 原权重 + 一点加分
  //     · 只有同义改写对上 → 原权重 × 同义折扣
  //
  //   ⚠ 为什么只对「词组概念」加这个分：
  //     不在任何同义词组里的词（「马原」「随口」这种），
  //     本来就只有「原词命中」一条路，没有同义改写来跟它抢，
  //     再加分就是白白抬高所有命中 —— 那是变相降阈值。
  //     实测反例：「随口」如果不是词组概念，加分会把一条本该
  //     42 分（< 45）的低分事实顶到 48 分入选，等于用加分绕过门槛。
  //
  // ⚠ 四条硬约束：
  //   1. 只在**原始 token 交集**上判「原词」，绝不用扩展后的集合（否则又重复计分）
  //   2. 只认长度 ≥ 2 的原词（单字歧义太大，不值钱）
  //   3. 同一概念组**最多算一次** —— 组里再多别名也不累加
  //   4. 折扣和加分只打在该概念的权重上，不改变命中集合本身
  const 同义折扣 = 0.8
  const 精确加权 = 14     // 词组概念里「原词真的命中」时，每个概念加这么多
  let 加权 = 0
  const 精确命中 = []
  const 折叠命中 = []
  {
    // 概念键 -> { 词, 权, 原词, 词组 }
    const 组权 = new Map()
    for (const t of 交集) {
      const 键 = 概念键(t)
      const 权 = 词权(t)
      const 词组 = 键.startsWith('组:')
      const 原词 = !!(词组 && 原始查询 && 原始记忆
        && 原始查询.has(t) && 原始记忆.has(t)
        && Array.from(t).length >= 2)
      const 旧 = 组权.get(键)
      // 同组只留一个代表词。三级优先：
      //   1. 权重更高（词更长）的替换
      //   2. ⚠ 权重相同时，**原词精确命中优先** ——
      //      否则「课程」这种同义别名先出现就把「晚课」这个原词顶掉，
      //      精确加权跟着一起没了：查询里明明写着「晚课」，却被判成纯同义命中。
      //   3. 其余情况保持先到者的稳定顺序
      if (!旧 || 权 > 旧.权 || (权 === 旧.权 && 原词 && !旧.原词)) {
        组权.set(键, { 词: t, 权, 原词, 词组 })
      }
    }
    for (const v of 组权.values()) {
      折叠命中.push(v.词)
      if (v.原词) {
        精确命中.push(v.词)
        加权 += v.权
      } else if (v.词组) {
        加权 += v.权 * 同义折扣
      } else {
        加权 += v.权
      }
    }
  }
  const 精确分 = Math.min(精确命中.length * 精确加权, 24)

  // ⭐⭐⭐ 单词主题锚点（2026-11-04 灰度实测补）
  //
  // 现场：53 条真实消息里召不回来的几个，病根是同一个 ——
  //   「你的爱好是什么」只命中「爱好」一个概念；
  //   「爱好」不在任何同义词组里，所以拿不到上面那个精确加权；
  //   1 个概念 × 12 = 基础 12 + 覆盖 16 = relevance 28，
  //   加 importance 4 + confidence 5 + recency 8 = 45，**正好压在门槛线上**。
  //   recency 稍有浮动（时间差一点点）就掉下去 → 时准时不准。
  //
  // ⚠ 这不是「优惠」，是原本就该有的一档：
  //   当**整个查询的有效主题就只有一个词**、而且这个词在记忆里
  //   **原样出现**时，这是极强证据 —— 用户就是在问这一件东西。
  //   把它算成和「一句话里随便沾到个词」一样重，才是错的。
  //
  // ⚠ 四条硬约束，防止变成「随便什么词都放行」：
  //   1. 查询**折叠后只有 1 个概念**（多个概念就不用这条，走正常算法）
  //   2. 这个词必须**原词精确命中**（查询里有、记忆里也有，同字同序）
  //   3. 长度 ≥ 2（单字不放行 —— 「爱」「好」这种绝不能靠这条进来）
  //   4. ⚠ **这个词必须是「已知的完整词」** —— 在保护词白名单里，或在同义词组里。
  //
  //      为什么需要 4：试过两个更"聪明"的判据，都不成立 ——
  //        · 「记忆里没有更长前缀词」→ 不成立。bigram 把「自拍照」
  //          切成 `自拍`+`拍照`，根本没有 3 字词，判据永远放行。
  //        · 「查询里除单字外只有它一个」→ 不成立。「自拍」和「爱好」
  //          切词结构一模一样（二字词 + 单字），区分不了。
  //
  //      老实承认：机器判断不出「这是个完整的名词还是个碎片」。
  //      所以只认**白名单里明确列出的词**（保护词 + 同义词组标准词）。
  //      这是可审计的：想知道哪些词有这待遇，看两个表就行。
  //
  //      效果：
  //        「爱好」在保护词表 → 12 分 ✅
  //        「泡水」走短语规范 → 算完整词 ⚠ 见下
  //        「抽纸」在保护词表 → 12 分 ✅
  //        「自拍」不在任何表里 → 0 分，守住第四阶段 A 边界 ✅
  //        「随口」不在任何表里 → 0 分，守住测试 16 ✅
  const 单词主题分 = (() => {
    if (折叠命中.length !== 1) return 0
    if (!原始查询 || !原始记忆) return 0
    const 词 = 折叠命中[0]
    if (Array.from(词).length < 2) return 0
    if (!原始查询.has(词) || !原始记忆.has(词)) return 0
    // 约束 4：必须是已知完整词
    const 算完整词 = 保护词.has(词)
      || 概念键(词).startsWith('组:')
      || 短语规范.some((x) => x.规范 === 词)
    if (!算完整词) return 0
    return 12
  })()

  // 加权命中量 → 基础分。1 个二字词 ≈ 12 分；3 个 ≈ 36 分；封顶 38
  const 基础 = Math.min(Math.round(加权 * 12), 38)

  // ── 覆盖率 ──
  // 查询自己的加权总量（分母）；命中占多少
  //
  // ⚠ 分母也要折叠 —— 否则「喜欢」这个概念的 4 个词会被算进分母 4 次，
  //   分子却只算 1 次，覆盖率凭空腰斩，反向把真该命中的也压死。
  //   分子分母同口径，覆盖率才有意义。
  //
  // ⭐ 2026-11-04：分母里**剔除泛化互动词**。
  //   现场：「你当时怎么调侃我看错抽纸的」→ 5 个 token 里，
  //   「当时」「调侃」都是弱互动词，真正的主题只有「抽纸」。
  //   把它们算进分母，覆盖率被摊成 1/5，覆盖分只剩 3 —— 差 2 分够不到门槛。
  //   这跟弱词防火墙是同一个道理：它们本来就不是主题，不该参与「占了主题的几成」。
  //   ⚠ 只影响覆盖率分母，**不影响命中判定**（弱词照样能匹配上）。
  let 查询加权 = 0
  {
    const 分母词 = [...查询].filter((t) => !弱互动词(t))
    const { 加权: 查询折叠权 } = 折叠概念(分母词.length ? 分母词 : [...查询], 词权)
    查询加权 = 查询折叠权
  }
  const 覆盖 = 查询加权 > 0 ? 加权 / 查询加权 : 0
  const 覆盖分 = Math.round(Math.min(覆盖, 1) * 16)   // 最多 16

  // ── 时间词命中 ──
  // ⚠ 也要走折叠后的命中集合，不然同组里两个时间词会重复加
  let 时间分 = 0
  for (const t of 折叠命中) {
    if (时间词.has(t)) 时间分 += 3
  }
  const 时间封顶 = Math.min(时间分, 6)

  let 总 = 基础 + 覆盖分 + 时间封顶 + 精确分 + 单词主题分
  总 = Math.min(总, 权重.relevanceMax)

  return {
    score: 总,
    // ⚠ 诊断里也只列折叠后的代表词 ——
    //   绝不出现「喜欢、爱、中意、偏好」四个同时列出来（那会让人以为命中了四件事）
    命中: 折叠命中.slice(0, 12),
    精确命中,
    精确分,
    单词主题分,
    概念数: 折叠命中.length,
    // ⭐ 架构预留：以后接语义向量的话放这儿。当前恒 0。
    semanticScore: 0,
  }
}

/** 预留接口：语义分。当前一律返回 0，绝不偷偷调模型。 */
export function semanticScore(/* 查询, 记忆 */) {
  return 0
}

// ── 元话题判定（复用第三层的思路，但独立实现，不 import fact-builder） ──
//
// ⭐ 为什么独立实现而不是 import：召回层不该依赖事实层的内部函数，
//   两边判定标准可以各自演进。代价是有一小段重复，值得。

const 元话题强标记 = [
  '线上验收', '记忆系统验收', '测试标记', '边界测试', 'speakerName 清洗验收',
  'speakername 清洗验收', '记忆系统', '事件层', '事实层', '长期事实层', '召回层',
  '影子召回', '上下文预算', '第二阶段', '第三阶段', '第四阶段', '第五阶段',
  '第一阶段',
]
const 测试编号 = /第[一二三四五1-5]阶段[^\n]{0,20}?-\s*\d{6,8}\s*-\s*[A-Za-z]\b/
const 带阶段验收 = /第[一二三四五1-5]阶段/
const 测试类词 = /(验收|测试|回归|冒烟)/
const 系统类词 = /(记忆系统|事件层|事实层|人格包|提示词|prompt|schema|消息ID|sourceMessageIds|eventId)/i

/** 这段文字是不是「系统开发 / 验收」的元话题 */
export function 是元话题(文) {
  const s = String(文 || '')
  if (!s) return { 是: false, 命中: '' }
  const 低 = s.toLowerCase()
  for (const 词 of 元话题强标记) {
    if (低.includes(词.toLowerCase())) return { 是: true, 命中: '标记词「' + 词 + '」' }
  }
  const 编 = s.match(测试编号)
  if (编) return { 是: true, 命中: '测试编号「' + 编[0] + '」' }
  if (带阶段验收.test(s) && 测试类词.test(s)) return { 是: true, 命中: '阶段标记 + 验收类词' }
  if (测试类词.test(s) && 系统类词.test(s)) return { 是: true, 命中: '验收类词 + 系统类词' }
  return { 是: false, 命中: '' }
}

// ── 读数据（只读） ────────────────────────────────────────────────

/** 读某个会话的事实（按 factId 折叠，最后一行赢） */
export function 读事实(事实根, session) {
  const 干净 = 干净会话(session)
  if (!干净) return []
  const p = join(事实根, 干净 + '.jsonl')
  if (!existsSync(p)) return []
  let 原 = ''
  try {
    原 = readFileSync(p, 'utf8')
  } catch (error) {
    return []
  }
  const 顺序 = []
  const 表 = new Map()
  for (const 行 of 原.split('\n')) {
    const s = 行.trim()
    if (!s) continue
    let o = null
    try {
      o = JSON.parse(s)
    } catch (error) {
      continue
    }
    if (!o || typeof o !== 'object' || !o.factId) continue
    const id = String(o.factId)
    if (!表.has(id)) 顺序.push(id)
    表.set(id, o)
  }
  return 顺序.map((id) => 表.get(id))
}

/** 读某个会话已关闭的事件卡（只认有 eventId + endAt + sourceMessageIds 的） */
export function 读事件(事件根, session) {
  const 干净 = 干净会话(session)
  if (!干净) return []
  const 目录 = join(事件根, 干净)
  if (!existsSync(目录)) return []
  let 文件们 = []
  try {
    文件们 = readdirSync(目录).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()
  } catch (error) {
    return []
  }
  const 出 = []
  for (const f of 文件们) {
    let 原 = ''
    try {
      原 = readFileSync(join(目录, f), 'utf8')
    } catch (error) {
      continue
    }
    for (const 行 of 原.split('\n')) {
      const s = 行.trim()
      if (!s) continue
      let 卡 = null
      try {
        卡 = JSON.parse(s)
      } catch (error) {
        continue
      }
      if (!卡 || typeof 卡 !== 'object' || !卡.eventId) continue
      // ⚠ 没有 endAt 的事件禁止召回（还没关闭）
      if (!卡.endAt || !Number.isFinite(Date.parse(卡.endAt))) continue
      if (!Array.isArray(卡.sourceMessageIds) || !卡.sourceMessageIds.length) continue
      出.push({ ...卡, eventId: String(卡.eventId), 文件: f })
    }
  }
  return 出
}

// ── 硬过滤 ────────────────────────────────────────────────────────

/**
 * 事实硬过滤。返回 null 表示通过，否则返回淘汰原因。
 *
 * ⭐ 当前用户定的规则，一条都不许松：
 *   status !== active / expired / contradicted / superseded / resolved → 拒
 *   subject === fish → 拒
 *   validUntil 已过期 → 拒（**哪怕 status 还是 active**）
 *   confidence < 60 → 拒
 *   元话题 / 系统验收 / 测试标记 → 拒
 *
 * ⭐⭐⭐ 2026-11-04 群聊主体隔离：user 事实必须过 subjectId 这道门。
 *
 * 规则：
 *   · 事实带 subjectId（群聊事实）→ 必须和「当前说话人」的 subjectId **完全相等**
 *   · 事实不带 subjectId（私聊旧事实）→ 只要当前不在群聊语境就放行（见下）
 *
 * ⚠ fail closed：群聊语境下**没有 speakerId** 或事实**没有 subjectId** 的 user 事实，
 *   一律不召回。宁可这一轮没有记忆，也不能把群友乙的偏好当成当前用户的。
 *
 * @param {object} f
 * @param {number} 现在
 * @param {{speakerId?:string, 群聊?:boolean}} 选
 *   speakerId —— 当前是谁在说话（群聊必须给）
 *   群聊      —— 这个会话是不是群聊
 */
export function 过滤事实(f, 现在 = Date.now(), 选 = {}) {
  if (!f || typeof f !== 'object') return 'not_a_fact'

  const st = String(f.status || '')
  if (st !== 'active') {
    // 分开报，诊断能看清
    if (['expired', 'contradicted', 'superseded', 'resolved'].includes(st)) return st
    return 'not_active'
  }

  // ⭐ 助手自我事实当前一律不召回（人格包才是权威，事实层也在暂缓）
  if (String(f.subject || '') === 'fish') return 'fish_subject'

  // ⭐ status 还是 active 但有效期已过 —— 这是真实库里存在的情况
  if (f.validUntil) {
    const 到 = Date.parse(String(f.validUntil))
    if (Number.isFinite(到) && 到 <= 现在) return 'valid_until_passed'
  }

  const conf = Number(f.confidence)
  if (!Number.isFinite(conf) || conf < 60) return 'low_confidence'

  // ⭐⭐⭐ 第四阶段 E1：显式 scope 双向隔离
  //
  // ⚠⚠ 这里修的是一个真实漏洞。原来的判断只有两行：
  //     事实身 = f.subjectId
  //     if (事实身) { 必须有 speakerId && 必须相等 }
  //     else if (是群聊) { 拒 }
  //
  //   缺口在**第一支**：事实带 subjectId 时只比了 speakerId，
  //   却**没有同时要求当前是群聊**。于是私聊调用里，
  //   只要调用方误传了一个和 fact.subjectId 相同的 speakerId，
  //   群聊事实就直接进了私聊上下文 —— 群聊事实回流私聊。
  //
  //   而且「带 subjectId 就是群聊事实」本身是在**猜**。当前用户的规则：
  //   必须以显式 scope 为准，subjectId 存在不代表任何事。
  //
  // ── 现在的判定顺序 ──────────────────────────────────────────
  //   先看事实自己声明的 scope（fact.scope）：
  //     · 'group'  → 群聊事实
  //     · 'private'→ 私聊事实（本阶段不主动写，但老数据可能出现）
  //     · 缺失     → 看 subjectId：
  //                   有 subjectId → **结构矛盾**（有身份却没 scope）→ 双向 fail closed
  //                   无 subjectId → 旧私聊事实
  //     · 其他脏值 → fail closed
  //
  //   再看调用场景（是群聊），两边必须**同类**才放行。
  if (String(f.subject || '') === 'user' || String(f.subject || '') === 'relationship') {
    const 事实身 = String(f.subjectId == null ? '' : f.subjectId).trim()
    const 说话人 = String((选 && 选.speakerId) == null ? '' : 选.speakerId).trim()
    const 是群聊 = !!(选 && 选.群聊)
    const 声明scope = String(f.scope == null ? '' : f.scope).trim()

    // ── 判定这条事实属于哪个语境 ──
    let 事实侧 = ''
    if (声明scope === 'group') {
      事实侧 = 'group'
    } else if (声明scope === 'private') {
      事实侧 = 'private'
    } else if (声明scope) {
      // ⚠ 认不出的 scope 值：不许当成私聊放行，宁可少召回
      return 'bad_scope'
    } else if (事实身) {
      // ⚠⚠ 结构矛盾：带身份却没有 scope。
      //   这正是 E1 之前落盘的老群聊事实的形态，
      //   也是「靠 subjectId 猜群聊」这套旧逻辑的产物。
      //   当前用户的规则：这种**私聊和群聊都 fail closed** ——
      //   群聊侧不敢认（不知道是不是本群的），
      //   私聊侧更不敢收（可能是别人的群聊记忆）。
      return 'fact_with_subject_but_no_scope'
    } else {
      事实侧 = 'private'   // 旧私聊事实：无 scope、无 subjectId
    }

    // ── 双向隔离：调用场景和事实语境必须同类 ──
    if (是群聊) {
      // 群聊调用：只要群聊事实，且必须主体匹配
      if (事实侧 !== 'group') return 'private_fact_in_group_recall'
      // 群聊没给 speakerId → fail closed（不许从正文/昵称/群号补）
      if (!说话人) return 'no_speaker_id'
      // ⚠ 群聊事实必须带 subjectId；scope=group 但没身份 → 结构矛盾
      if (!事实身) return 'group_fact_without_subject_id'
      if (事实身 === 'fish') return 'fish_subject_id'
      if (事实身 !== 说话人) return 'other_speaker'
    } else {
      // 私聊调用：只要私聊事实。
      // ⚠ 即使调用方误传了与 fact.subjectId 相同的 speakerId，
      //   群聊事实也**不许**进私聊 —— 判据是 scope，不是 speakerId。
      if (事实侧 !== 'private') return 'group_fact_in_private_recall'
    }
  }

  // 元话题
  const 搜 = [f.predicate, f.value, f.reason,
    ...(Array.isArray(f.tags) ? f.tags : [])].filter(Boolean).join('\n')
  if (是元话题(搜).是) return 'meta_topic'

  return null
}

/**
 * 事件硬过滤。返回 null 表示通过。
 *
 * ⭐⭐ 第四阶段 E1：事件卡也必须过 **scope 双向隔离**。
 *
 * ⚠⚠ 这是影子验收抓出来的真漏洞：
 *   我只给事实做了 scope 隔离，事件侧漏了。结果私聊查询时，
 *   一张 scope='group' 的群事件卡（同时含当前用户和群友乙说的话）被注入进私聊上下文，
 *   摘要里带着别人的内容。这正是「把别人的经历当成你的回忆」。
 *
 * ⚠ 判据跟事实侧一致：
 *   · 群聊调用 → 只收 scope==='group' 的卡
 *   · 私聊调用 → 只收 scope!=='group' 的卡
 *   · scope 认不出的脏值 → 双向都不收（保守）
 *
 * @param {object} 卡
 * @param {{群聊?:boolean}} 选
 */
export function 过滤事件(卡, 选 = {}) {
  if (!卡 || typeof 卡 !== 'object') return 'not_event'
  // 没有 endAt 已经在上层读的时候挡掉了，这里再挡一次
  if (!卡.endAt || !Number.isFinite(Date.parse(卡.endAt))) return 'not_closed'

  // ⭐ E1 scope 隔离（放在最前面：语境不对就不必再算别的）
  const 是群聊 = !!(选 && 选.群聊)
  const 卡scope = String(卡.scope == null ? '' : 卡.scope).trim()
  const 卡是群 = 卡scope === 'group'
  if (卡scope && 卡scope !== 'group' && 卡scope !== 'private') return 'bad_scope'
  if (是群聊 && !卡是群) return 'private_event_in_group_recall'
  if (!是群聊 && 卡是群) return 'group_event_in_private_recall'

  // importance 太低不召回
  const imp = Number(卡.importance)
  if (!Number.isFinite(imp) || imp < 20) return 'low_importance'

  // 元话题
  const 搜 = [卡.title, 卡.summary,
    ...(Array.isArray(卡.highlights) ? 卡.highlights : []),
    ...(Array.isArray(卡.tags) ? 卡.tags : [])].filter(Boolean).join('\n')
  if (是元话题(搜).是) return 'meta_topic'

  return null
}

// ── 各分项打分 ────────────────────────────────────────────────────

/** 重要度分（0 ~ 15） */
export function 算重要度(item) {
  // 事实用 category + confidence 推；事件用 importance 字段
  const imp = Number(item.importance)
  if (Number.isFinite(imp)) {
    return Math.round(Math.max(0, Math.min(imp, 100)) / 100 * 权重.importanceMax)
  }
  const 类 = String(item.category || '')
  const 底 = {
    identity: 12, relationship: 12, preference: 10, routine: 9,
    commitment: 11, open_loop: 10, correction: 11, temporary_state: 5,
  }[类]
  return 底 == null ? 6 : 底
}

/** 置信度分（0 ~ 10） */
export function 算置信度(item) {
  const c = Number(item.confidence)
  if (!Number.isFinite(c)) return 5
  return Math.round(Math.max(0, Math.min(c, 100)) / 100 * 权重.confidenceMax)
}

/** 新鲜度分（0 ~ 10）—— 按 lastSeenAt/endAt 距今多久，7 天内线性衰减 */
export function 算新鲜度(item, 现在 = Date.now()) {
  const t = Date.parse(String(item.lastSeenAt || item.endAt || item.updatedAt || ''))
  if (!Number.isFinite(t)) return 0
  const 天 = (现在 - t) / (24 * 3600 * 1000)
  if (天 <= 0) return 权重.recencyMax
  if (天 >= 7) return 0
  return Math.round((1 - 天 / 7) * 权重.recencyMax)
}

/** 重复度分（0 ~ 5）—— occurrenceCount 高说明反复出现 */
export function 算重复(item) {
  const n = Number(item.occurrenceCount)
  if (!Number.isFinite(n) || n <= 1) return 0
  return Math.min(Math.round(Math.log2(n) * 2), 权重.repetitionMax)
}

/**
 * 陈旧惩罚（0 ~ 20）—— 注意这和 recencyScore 不同：
 *   recency 奖励「新」，agePenalty **惩罚「老」**，两头夹住，避免新近度主导排序。
 *   超过 30 天的记忆开始罚，90 天罚满。
 */
export function 算陈旧惩罚(item, 现在 = Date.now()) {
  const t = Date.parse(String(item.lastSeenAt || item.endAt || item.updatedAt || ''))
  if (!Number.isFinite(t)) return 0
  const 天 = (现在 - t) / (24 * 3600 * 1000)
  if (天 <= 30) return 0
  if (天 >= 90) return 权重.agePenaltyMax
  return Math.round((天 - 30) / 60 * 权重.agePenaltyMax)
}

// ── 候选构建 ──────────────────────────────────────────────────────

/**
 * ⭐ 第四阶段 E3.1：把事实的 value 渲染成**给人 / 给模型看的人话**。
 *
 * ⚠⚠ 为什么改：原来注入行是「predicate：value」，例如
 *     - user.preference.communication_style：希望回答带主观感受，不要保持中立
 *   predicate 是受控词表里的**内部标识符**（英文点分），塞进上下文里
 *   既不像人话，也把内部结构漏给了模型。现在只渲染 value。
 *
 * ⚠ 这里是**纯格式化**：不改写、不总结、不调模型、不碰打分。
 *   相关性 token 仍然用 predicate + value（见下面 记忆原文），
 *   所以召回筛选和排序**一个字都没变**。
 *
 * @returns {string} 渲染文本；返回 '' 表示「无法安全渲染」，由调用方整条跳过
 *
 * ⚠ 导出只为让展示层测试能直接喂各种脏 value（对象 / 数组 / null），
 *   不改变任何运行时行为。
 */
export function 渲染事实值(v) {
  // 空 → 空串（调用方会跳过整条，绝不回退去显示 predicate）
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? '是' : '否'

  // 数组：逐项递归，用顿号连。⚠ 绝不用 String(数组) —— 对象项会变成 [object Object]
  if (Array.isArray(v)) {
    const 们 = []
    for (const 项 of v) {
      const 一 = 渲染事实值(项)
      if (一) 们.push(一)
    }
    return 们.join('、')
  }

  // 对象：只认**少量明确的文本字段**，绝不整块 dump JSON。
  //   ⚠ 白名单而不是黑名单：黑名单防不住以后新增的字段（predicate / factId / subjectId…）。
  if (typeof v === 'object') {
    for (const 键 of ['文本', 'text', '值', 'value', '名称', 'name', '标题', 'title', 'label']) {
      if (Object.prototype.hasOwnProperty.call(v, 键)) {
        const 一 = 渲染事实值(v[键])
        if (一) return 一
      }
    }
    return ''   // 认不出来 → 宁可整条跳过，也不泄内部结构
  }

  // 函数 / symbol 之类：渲染不出有意义的东西
  return ''
}

/** 事实 → 候选项 */
function 造事实候选(f, 查询token, 选 = {}) {
  // ⭐ E3.1：注入行只显示 value，predicate 不进正文
  const 文本 = 渲染事实值(f.value)
  const 记忆原文 = [
    f.predicate, f.value, f.reason,
    ...(Array.isArray(f.tags) ? f.tags : []),
  ].filter(Boolean).join(' ')
  const 记忆token = 扩展同义(切词(记忆原文))

  const 相 = 算相关性(查询token, 记忆token, {
    原始查询: 选.原始查询,
    原始记忆: 切词(记忆原文),
  })
  return {
    id: String(f.factId || ''),
    type: 'fact',
    category: String(f.category || ''),
    text: 文本,
    raw: f,
    // ⭐ E3.1：value 渲染不出东西的事实，整条不参与召回（见 事实候选 那里的过滤）
    //   ⚠ 标记而不是当场丢掉，是为了让上层能统一记诊断。
    可渲染: 文本.length > 0,
    命中: 相.命中,
    semanticScore: 相.semanticScore,
    relevanceScore: 相.score,
  }
}

/**
 * highlight 进入文本的最低强度。
 *
 * ⭐ 2026-11-03 边界修复（当前用户复现的线上问题）：
 *   原来只要求 `分 > 0`，于是「马原课」这个查询会把
 *   「对方说晚上有职业规划晚课，8点40下课」也选进去 ——
 *   它只靠单字「课」拿到约 7 分，和「马原课」根本不是同一件事。
 *   渲染出来就是两件事粘在一起，违反「只渲染与当前问题直接相关的那一句」。
 *
 * 现在要求：分数 ≥ 12，且 ≥ 最高分 × 0.6。
 */
export const 要点最低分 = 12
export const 要点相对门槛 = 0.6
export const 要点最多 = 2

/**
 * 从「带分的要点」里挑出真正够强的，最多 要点最多 条。
 *
 * ⭐ 抽成导出的纯函数：这样测试能**直接喂精确分数**，
 *   不用去凑真实词表碰运气 —— 门槛本身的行为才测得住。
 *
 * @param {{h:string, 分:number}[]} 带分要点  已按分数从高到低排序
 * @returns {{h:string, 分:number}[]}
 */
export function 选要点(带分要点) {
  if (!Array.isArray(带分要点) || !带分要点.length) return []
  // ⚠ 这里不需要单独判「最高分 > 0」：
  //   下面的 filter 要求 分 >= 要点最低分(12)，全 0 或负分的组自然被滤空。
  //   写一句冗余判断只会让人以为它在起作用。
  const 最高分 = 带分要点[0].分
  return 带分要点
    .filter((x) => x.分 >= 要点最低分 && x.分 >= 最高分 * 要点相对门槛)
    .slice(0, 要点最多)
}

/**
 * 事件 → 候选项。
 *
 * ⭐ 事件卡里有 highlights（一条条完整分句）。用**真正命中的 highlight** 来组装文本，
 *   而不是把整段 summary 塞进去 —— 这样才叫「与当前话题直接相关」。
 *   highlight 本身就是完整的短句，所以这么拼不算把句子截断成残句。
 *
 * ⭐ 2026-11-03 修复要点：
 *   1. highlight 必须达到最低强度（≥12 分）才算命中，不能再 `分 > 0` 就收
 *   2. 保留第二条时还要达到最高分的 60% —— 防止一条强、一条只沾个边
 *   3. **事件相关性 = 标题和「最相关的那条 highlight」取最大**，
 *      不再把整段 summary 摊进来抬高分数（summary 会把多个话题混在一起）
 *   4. 有 highlights 但一条都没达到强匹配时，**不回退输出整段 summary**
 *   5. 只有**没有 highlights 的旧事件**才允许安全回退到 title/summary
 */
export function 造事件候选(卡, 查询token, 选 = {}) {
  const 标题 = String(卡.title || '')
  const 摘要 = String(卡.summary || '')
  const 要点们 = Array.isArray(卡.highlights) ? 卡.highlights.map(String).filter(Boolean) : []

  // ⭐ 原始（未扩展）token：只用来判「原词精确命中」。
  //   ⚠ 绝不能拿扩展后的集合判精确 —— 那等于把同义词又变回多个证据。
  const 原查 = 选.原始查询 instanceof Set ? 选.原始查询 : null
  const 精参 = (原文) => ({ 原始查询: 原查, 原始记忆: 切词(原文) })

  // ── 每条 highlight 各自算分 ──
  //
  // ⭐ 2026-11-04：**只靠泛化互动词命中的要点，一律不给分**。
  //
  //   现场：「你当时怎么调侃我看错抽纸的」本该只命中抽纸卡，
  //   结果把泡水卡里「对方调侃助手『眼神不行』」也拉进来了 ——
  //   两条都是 45 分，纯粹因为查询里那个「调侃」。
  //   用户问的是「我看错抽纸」那件事，不是「调侃」这个词本身。
  //
  //   ⚠ 判据：这条要点里必须有**至少一个非弱互动词的命中**。
  //     只有弱词命中的要点 → 分归零，不参与竞争。
  //   ⚠ 不是把弱词删掉 —— 弱词仍然参与算分，只是它**不能单独撑起一条要点**。
  //   ⚠ 用**扩展后**的 token 判，不用原始 token：
  //     猫查询是靠「喜欢」→「爱」这条同义链才沾到泡水卡的。
  //     只查原始词会把这种命中全灭掉，事件正文变成空（真卡-3 当场红）。
  //   ⚠ 没传原始查询时（比如单元测试直接喂 token）→ 不做这个过滤。
  const 要点有主题 = (h) => {
    if (!原查) return true // 没给原词就不过滤，行为与以前一致
    const 记扩展 = 扩展同义(切词(h))
    for (const t of 记扩展) {
      if (!查询token.has(t)) continue
      if (弱互动词(t)) continue
      return true
    }
    return false
  }

  const 带分要点 = 要点们
    .map((h) => ({
      h,
      分: 要点有主题(h)
        ? 算相关性(查询token, 扩展同义(切词(h)), 精参(h)).score
        : 0,
    }))
    .sort((a, b) => b.分 - a.分)

  const 最高要点分 = 带分要点.length ? 带分要点[0].分 : 0

  // ── 挑出真正够强的要点（门槛见 选要点）──
  let 命中要点 = 选要点(带分要点).map((x) => x.h)

  // ⭐⭐⭐ 2026-11-08 答案槽同句边界：**槽证据和话题必须在同一条 highlight 里**
  //
  // 当前用户的原话：
  //   「查询所问的答案槽和话题内容必须在同一条实际选中 highlight 中成立」
  //   「不允许从一条 highlight 取话题、另一条取人数/时间/时长」
  //   「不允许标题提供话题、无主题的 highlight 只提供答案后拼接通过」
  //
  // 现场：查「那次有几个人一起玩」，「一起玩游戏」和「三个人一起吃饭」
  //   各得 35 分都进展示文本，拼成「一起玩游戏；三个人一起吃饭」——
  //   人数来自吃饭，玩的主题来自另一句。答案是被**拼**出来的。
  //
  // ⚠ 这里只对**带答案槽的查询**生效。
  //   普通查询（不含槽位问法）完全走原来的路径，行为不变。
  //   ⚠ 不提高 要点最低分 / 要点相对门槛 —— 那是掩盖问题。
  const 槽求 = 抽查询答案槽(String(选.查询原文 == null ? '' : 选.查询原文))
  const 用槽边界 = 槽求.槽们.length > 0
  let 槽诊断 = null

  if (用槽边界) {
    const 锚 = 抽主题锚点(String(选.查询原文 || ''))
    const 逐条 = 要点们.map((h) => {
      const 判 = 判要点能否独立回答(h, 槽求.槽们, 锚.锚点)
      const 分 = (带分要点.find((x) => x.h === h) || {}).分 || 0
      return { h, 分, ...判 }
    })

    // 只留下「自己就能独立回答」且分数够强的
    const 合格 = 逐条.filter((x) => x.独立可答 && x.分 >= 要点最低分)
    const 合格分 = 合格.map((x) => x.分)
    const 合格最高 = 合格分.length ? Math.max(...合格分) : 0
    // 用**原有关键门槛**在这批合格要点里挑，不新设门槛
    const 合格h = new Set(合格
      .filter((x) => x.分 >= 要点最低分 && x.分 >= 合格最高 * 要点相对门槛)
      .map((x) => x.h))

    if (合格h.size) {
      命中要点 = 命中要点.filter((h) => 合格h.has(h))
    } else {
      命中要点 = []
    }

    槽诊断 = {
      requestedSlots: 槽求.槽们,
      queryTopicAnchors: 锚.锚点,
      queryOnlySlot: 锚.只有槽,
      strippedQuery: 锚.剥离后文本,
      // ⚠ 只记录真实文本和真实匹配，不做任何推测
      highlightSlotEvidence: 逐条.map((x) => ({
        highlight: x.h,
        score: x.分,
        hasSlotEvidence: x.有槽证据,
        matchedAnchors: x.命中锚点,
      })),
      highlightTopicMatches: 逐条.map((x) => ({
        highlight: x.h,
        topicMatched: x.命中锚点.length > 0 || 锚.锚点.length === 0,
      })),
      independentHighlights: 合格.map((x) => x.h),
      缺什么: 合格.length
        ? ''
        : '没有任何一条 highlight 能同时提供答案证据和查询话题',
    }
  }

  // ── 事件相关性：标题 和 最强 highlight 取最大 ──
  //
  // ⚠ 不把 summary 摊进来。summary 天然会把一个事件里多个话题混在一起，
  //   用它算相关分就会「因为摘要里什么都提了一嘴」而被选中。
  const 标题相 = 算相关性(查询token, 扩展同义(切词(标题)), 精参(标题))
  let 相关 = Math.max(标题相.score, 最高要点分)

  // 没有 highlights 的旧事件：才允许用 summary 兜底
  const 有要点 = 要点们.length > 0
  let 摘要相 = { score: 0, 命中: [] }
  if (!有要点) {
    摘要相 = 算相关性(查询token, 扩展同义(切词(摘要)), 精参(摘要))
    相关 = Math.max(相关, 摘要相.score)
  }

  // 命中词（给诊断用）取标题和最强要点里那个分数高的
  const 命中 = 最高要点分 > 标题相.score
    ? (带分要点[0] ? 算相关性(查询token, 扩展同义(切词(带分要点[0].h)), 精参(带分要点[0].h)).命中 : [])
    : 标题相.命中
  const 命中词 = 命中.length ? 命中 : (摘要相.命中 || [])

  // ── 组装文本 ──
  let 文本 = ''
  if (命中要点.length) {
    // 正常情况：标题 + 命中要点
    文本 = 标题 ? 标题 + '：' + 命中要点.join('；') : 命中要点.join('；')
  } else if (有要点) {
    // ⚠ 有 highlights 但没有一条够强 → **不回退到 summary**（那就成混话题了）
    //   标题自己够相关就只给标题；标题也不相关就留空，让上层按分数淘汰。
    //
    // ⚠⚠ 2026-11-08：带答案槽的查询**不许走标题回退**。
    //   当前用户的原话：「不允许标题提供话题、无主题的 highlight 只提供答案后拼接通过」。
    //   标题只是「这件事叫什么」，它没有经过逐条要点校验，
    //   拿它当展示文本等于绕过同句边界。
    文本 = (标题相.score >= 要点最低分 && !用槽边界) ? 标题 : ''
  } else {
    // 没有 highlights 的旧事件：安全回退
    //
    // ⚠ 同样：带答案槽的查询不许用 title：summary 拼一段长文本 ——
    //   那种拼接和「两条 highlight 拼起来」是同一个毛病。
    //   只有**单独一个字段**能独立回答时，才把它当展示文本。
    if (用槽边界) {
      const 候选段 = [标题, 摘要].filter(Boolean)
      const 合格段 = 候选段.filter((x) => 判要点能否独立回答(
        x, 槽求.槽们, 抽主题锚点(String(选.查询原文 || '')).锚点,
      ).独立可答)
      文本 = 合格段.length === 1 ? 合格段[0] : ''
    } else {
      文本 = [标题, 摘要].filter(Boolean).join('：')
    }
  }

  return {
    id: String(卡.eventId || ''),
    type: 'event',
    category: 'episodic',
    text: 文本,
    raw: 卡,
    命中: 命中词,
    semanticScore: 0,
    relevanceScore: 相关,
    命中要点,
    最高要点分,
    无强要点: 有要点 && !命中要点.length,
    // ⭐ 槽边界诊断（只在带答案槽的查询下非 null），供上层生成拒绝理由
    槽诊断,
  }
}

// ── 主流程 ────────────────────────────────────────────────────────

/**
 * 跑一次召回。
 *
 * 顺序（当前用户定的）：**硬过滤 → 评分 → 去重 → 装入预算**
 *
 * ⚠ 纯只读 + 纯确定性。不写盘、不调模型。
 *
 * @param {object} 参
 *   { 事实根, 事件根, session, q, 现在, 预算, 最低分 }
 * @returns 召回结果结构（见报告 §召回结果结构）
 */
export function 召回(参 = {}) {
  const {
    事实根, 事件根, session = '', q = '', 现在 = Date.now(),
    预算 = 默认预算, 最低分 = 默认最低分,
    // ⭐ 2026-11-04 群聊主体隔离：
    //   speakerId —— 当前说话人（群聊必传，不传则 user 事实 fail closed）
    //   群聊      —— 这个会话是不是群聊
    说话人 = '', 群聊 = false,
  } = 参

  const 查询原文 = String(q == null ? '' : q).trim()
  const 生成时刻 = 时刻ISO(现在)

  const 拒们 = []
  const 诊断 = []
  const 选 = { facts: [], episodes: [], openLoops: [] }

  const 空结果 = () => ({
    schemaVersion: 1,
    session: String(session || ''),
    query: 查询原文,
    generatedAt: 生成时刻,
    budget: {
      maxChars: 预算.maxChars,
      usedChars: 0,
      remainingChars: 预算.maxChars,
    },
    selected: 选,
    rejected: 拒们,
    diagnostics: 诊断,
  })

  // ⭐ q 为空 → 直接空结果，绝不瞎召回
  if (!查询原文) {
    诊断.push('查询为空，不召回（这是合法结果，不是错误）')
    return 空结果()
  }

  // ⭐ 查询本身是元话题 → 也直接空（不拿系统开发的话去捞记忆）
  const 查询元 = 是元话题(查询原文)
  if (查询元.是) {
    诊断.push('查询本身是系统开发/验收元话题（' + 查询元.命中 + '），不召回')
    return 空结果()
  }

  // ⭐ 同时留两份：原始（精确命中用）和扩展（同义概念用）
  const 查询原始token = 切词(查询原文)
  const 查询token = 扩展同义(查询原始token)
  const 精参 = { 原始查询: 查询原始token, 查询原文 }
  if (!查询token.size) {
    诊断.push('查询切不出有效词，不召回')
    return 空结果()
  }

  // ⭐⭐⭐ 弱互动词防火墙（2026-11-04 灰度误召回修复）
  //
  // 线上现场：53 条真实消息里唯一一次非空召回是查「还在调侃我」，
  //   命中了「鲸鱼娘泡水与下课等候」—— 只因为那张卡的文本里有「调侃」两个字，
  //   加上实时 recency 加成刚好越过 45 分。这是隐性误召回。
  //
  // 病根：「调侃」这类词是**泛化的互动词**，它描述的是「怎么说话」，
  //   不是「在说哪件事」。它不承载任何主题，
  //   却因为是个正常二字词而拿到了完整主题词的待遇。
  //
  // ⚠ 修法**不是**把这些词从词表里删掉 ——
  //   「你怎么调侃我看错抽纸的」里「调侃」是真在用的，删了就丢信息。
  //   做法是：**看查询里除了弱词还剩什么**。
  //     · 只剩弱词 → 没有主题，不召回（返回空）
  //     · 还有别的词 → 正常召回，弱词照常参与
  //   ⚠ 也不动 45 这个全局门槛 —— 那是掩盖问题，不是修问题。
  const 强token = new Set([...查询原始token].filter((t) => !弱互动词(t)))
  if (!强token.size) {
    诊断.push('查询只剩泛化互动词（' + [...查询原始token].join('、') + '），'
      + '没有具体对象/事件/内容词，不召回')
    return 空结果()
  }

  // ── 1) 读 + 硬过滤 ──
  const 全部事实 = 事实根 ? 读事实(事实根, session) : []
  const 全部事件 = 事件根 ? 读事件(事件根, session) : []

  诊断.push('读取：事实 ' + 全部事实.length + ' 条，事件 ' + 全部事件.length + ' 条')

  const 过事实 = []
  const 事实筛参 = {
    speakerId: String(说话人 == null ? '' : 说话人).trim(),
    群聊: !!群聊,
  }
  for (const f of 全部事实) {
    const 原因 = 过滤事实(f, 现在, 事实筛参)
    if (原因) {
      拒们.push({ id: String(f.factId || ''), type: 'fact', reason: 原因, score: 0 })
      continue
    }
    过事实.push(f)
  }
  const 过事件 = []
  for (const 卡 of 全部事件) {
    const 原因 = 过滤事件(卡, { 群聊: !!群聊 })
    if (原因) {
      拒们.push({ id: String(卡.eventId || ''), type: 'event', reason: 原因, score: 0 })
      continue
    }
    过事件.push(卡)
  }
  诊断.push('硬过滤后：事实 ' + 过事实.length + ' 条，事件 ' + 过事件.length + ' 条')

  // ⭐ 2026-11-04 群聊主体隔离：fail closed 要说清楚，不然「为什么没召回」查不出来
  if (事实筛参.群聊 && !事实筛参.speakerId) {
    诊断.push('群聊未提供当前说话人 speakerId → 所有 user 事实一律不召回（fail closed）')
  }

  // ── 2) 评分 ──
  const 全部事实候选 = 过事实.map((f) => 造事实候选(f, 查询token, 精参))

  // ⭐ 第四阶段 E3.1：value 渲染不出文本的事实，**整条跳过**。
  //
  // ⚠ 三条硬要求：
  //   ① 不许输出只有「-」的空项目符号；
  //   ② 不许拿 predicate 兜底（那正是这一阶段要消灭的东西）；
  //   ③ selected.facts 要统计**真正渲染成功**的条数，跳过的不能算进去。
  //
  // ⚠ 为什么不在 装() 那里靠「文本为空」拦：
  //   装() 对空文本给的理由是 `low_relevance`（相关性不够）——
  //   可这里是「值本身没法渲染」，跟相关性无关，报那个理由会误导排查。
  //   所以在候选阶段就滤掉，**不动任何既有的拒因码**，只记一条诊断。
  const 事实候选 = 全部事实候选.filter((c) => c.可渲染)
  const 跳过的空值数 = 全部事实候选.length - 事实候选.length
  if (跳过的空值数 > 0) {
    诊断.push('展示层：' + 跳过的空值数 + ' 条事实的 value 无法安全渲染，整条跳过'
      + '（不输出空项目符号，也不用 predicate 兜底）')
  }

  // ⭐⭐ 第四阶段 E1：群聊**不注入事件卡**。
  //
  // ⚠ 为什么：
  //   群事件卡通常包含多个参与者（A、B 都在说话），而当前**没有逐条的主体归属**。
  //   把「A 和 B 聊了什么」的摘要当成 A 的个人回忆注入，等于替 A 认领了
  //   别人的经历 —— 这就是群里「你怎么什么都知道」的来源。
  //
  // ⚠ 所以 E1 灰度阶段：
  //   · 群聊只召回通过主体隔离的**长期事实**
  //   · 事件卡一律不进群聊上下文，记诊断 group_events_disabled_pending_subject_attribution
  //   · 私聊的事件召回**一个字不改**
  //
  // ⚠ 这不是「暂时关掉」，是**等主体归属做出来之前不许开**。
  //   谁要开，先解决「这张卡里哪句话是 A 说的」。
  // ⚠ 用调用参数里的 群聊，不是 选（选 是结果容器，没有这个字段）。
  const 群聊禁事件 = !!群聊
  const 事件候选 = 群聊禁事件
    ? []
    : 过事件.map((卡) => 造事件候选(卡, 查询token, 精参))

  if (群聊禁事件 && 过事件.length) {
    诊断.push('group_events_disabled_pending_subject_attribution：群聊不注入事件卡 '
      + '（' + 过事件.length + ' 张被拦下）—— 事件卡当前没有逐条主体归属，'
      + '注入了就会把别人的经历当成当前说话人的回忆')
    for (const 卡 of 过事件) {
      拒们.push({
        id: String(卡.eventId || ''), type: 'event',
        reason: 'group_events_disabled_pending_subject_attribution', score: 0,
        说: '群聊阶段不注入事件卡（缺逐条主体归属），与相关性无关',
      })
    }
  } else if (群聊禁事件) {
    诊断.push('group_events_disabled_pending_subject_attribution：群聊不注入事件卡')
  }

  const 打分 = (候, 额外罚 = 0) => {
    const 相关 = 候.relevanceScore
    const 重要 = 算重要度(候.raw)
    const 置信 = 算置信度(候.raw)
    const 新近 = 算新鲜度(候.raw, 现在)
    const 重复 = 算重复(候.raw)
    const 陈旧 = 算陈旧惩罚(候.raw, 现在)
    const 冗余 = Math.min(额外罚, 权重.redundancyPenaltyMax)

    const 总 = 相关 + 重要 + 置信 + 新近 + 重复 - 陈旧 - 冗余
    return {
      totalScore: Math.round(总),
      scoreBreakdown: {
        relevanceScore: Math.round(相关),
        importanceScore: 重要,
        confidenceScore: 置信,
        recencyScore: 新近,
        repetitionScore: 重复,
        agePenalty: 陈旧,
        redundancyPenalty: 冗余,
        semanticScore: 候.semanticScore,
      },
    }
  }

  for (const 候 of 事实候选) Object.assign(候, 打分(候))
  for (const 候 of 事件候选) Object.assign(候, 打分(候))

  // ── 3) 去重 ──

  // 3a) 同 subject + predicate 只留最高分
  const 按谓词 = new Map()
  for (const 候 of 事实候选) {
    const 键 = String(候.raw.subject || '') + '\u0000' + String(候.raw.predicate || '')
    const 旧 = 按谓词.get(键)
    if (!旧) { 按谓词.set(键, 候); continue }
    const 留 = 候.totalScore > 旧.totalScore ? 候 : 旧
    const 弃 = 留 === 候 ? 旧 : 候
    按谓词.set(键, 留)
    拒们.push({
      id: 弃.id, type: 'fact', reason: 'duplicate', score: 弃.totalScore,
      说: '同 subject+predicate 已有更高分的那条',
    })
  }
  let 事实去重后 = [...按谓词.values()]

  // 3b) 事实已经完整表达了某个事件 → 事件降冗余分（不是直接丢）
  for (const 事 of 事件候选) {
    const 事token = 扩展同义(切词([事.raw.title, 事.raw.summary].filter(Boolean).join(' ')))
    let 最高 = 0
    for (const f of 事实去重后) {
      const 共 = 算相关性(事token, 扩展同义(切词([
        f.raw.predicate, f.raw.value,
      ].filter(Boolean).join(' ')))).score
      if (共 > 最高) 最高 = 共
    }
    if (最高 > 0) {
      // 相似度越高，冗余罚越重（最多 30）
      const 罚 = Math.min(Math.round(最高 / 权重.relevanceMax * 权重.redundancyPenaltyMax),
        权重.redundancyPenaltyMax)
      Object.assign(事, 打分(事, 罚))
    }
  }

  // 3c) 多条事件说同一件事 → 只留最相关的
  //
  // ⚠ 判「同一件事」必须看**两个事件彼此**有多像，不能拿查询当桥。
  //   而且只有**都跟当前查询有关**的事件才谈得上重复 ——
  //   两个都不相关的事件不能因为互相像就免掉一个再报 duplicate，
  //   那样会把本该报 low_relevance 的混成 duplicate，诊断就骗人了。
  const 事件排序 = [...事件候选].sort((a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id))
  const 事件留 = []
  for (const 候 of 事件排序) {
    let 重了 = false
    for (const 已 of 事件留) {
      const a = 扩展同义(切词([候.raw.title, 候.raw.summary].filter(Boolean).join(' ')))
      const b = 扩展同义(切词([已.raw.title, 已.raw.summary].filter(Boolean).join(' ')))
      // 互相覆盖的比例：交集 / 较小集合的大小
      const 交 = []
      for (const t of a) if (b.has(t)) 交.push(t)
      const 小 = Math.min(a.size, b.size)
      const 相似 = 小 ? 交.length / 小 : 0
      // 要真像（>60% 重叠）才算同一件事
      if (相似 > 0.6) {
        重了 = true
        拒们.push({
          id: 候.id, type: 'event', reason: 'duplicate', score: 候.totalScore,
          说: '和更高分的事件内容重合 ' + Math.round(相似 * 100) + '%，当成同一件事',
        })
        break
      }
    }
    if (!重了) 事件留.push(候)
  }

  // ── 4) 最低分门槛 ──
  const 过线 = (候, 类型) => {
    // ⭐⭐ 2026-11-08 答案槽边界：**在最低分门槛之前**判「答不答得上」。
    //
    // ⚠ 为什么放在门槛前：
    //   门槛是「够不够相关」，答案槽是「有没有那个信息」—— 两件事。
    //   一个候选可以既相关又答不上（N4 就是：51 分、话题相同、没有人数）。
    //   如果放在门槛后，它得先过线再被踢，诊断里会出现两条矛盾理由。
    //
    // ⚠ 为什么走同一个函数：
    //   fact 和 event 都从这过。规则只有这一处，不散成多套补丁。
    //
    // ⚠⚠ 2026-11-08 第二次修正 —— **只用 候.text，不许读整张卡**：
    //   上一版事件侧取的是 `title + summary + 全部 highlights`。
    //   那是错的：整张卡里可能有一堆跟当前问题无关的要点，
    //   于是「一起玩游戏」这条展示文本能从同卡的「三个人一起吃饭」里
    //   借到人数，把不该过的候选放过去 —— 这叫**证据串线**。
    //
    //   正确的判据：**答案信息必须出现在实际会展示给用户的那段文字里**。
    //   候.text 正好就是那段（「标题：命中要点；命中要点…」），
    //   由 造事件候选() 按相关性挑出来的，不含无关要点。
    //
    //   如果人数只在别的 highlight 里，用户就看不到它 ——
    //   那这个候选答不了这个问题，必须拒。
    //
    // ⚠⚠ 2026-11-08 第三次修正 —— **同句边界**：
    //   只读 候.text 还不够，因为 候.text 本身可能是拼出来的：
    //     查「那次有几个人一起玩」，两条 highlight 各得 35 分都进文本，
    //     拼成「一起玩游戏；三个人一起吃饭」—— 人数来自吃饭，
    //     玩的主题来自另一句。答案被**拼**出来了。
    //   所以 造事件候选() 已经在**源头**逐条 highlight 校验过
    //   （槽证据 + 主题锚点必须同句），不合格的要点根本不进 候.text。
    //   走到这里如果 候.text 为空，就说明没有任何一条要点能独立回答。
    //
    //   这种情况报 answerability_evidence_split 而不是 answerability_slot_missing，
    //   因为「缺槽」和「槽和话题被拆在两句里」是两种不同的失败，诊断要分清。
    if (类型 === 'event' && 候.槽诊断 && !候.槽诊断.independentHighlights.length) {
      拒们.push({
        id: 候.id, type: 类型,
        reason: 'answerability_evidence_split',
        score: 候.totalScore,
        说: 候.槽诊断.缺什么,
        槽: {
          reason: 'answerability_evidence_split',
          requestedSlot: 候.槽诊断.requestedSlots.join('+'),
          candidateType: 类型,
          candidateCategory: String((候.raw && 候.raw.category) || ''),
          queryTopicAnchors: 候.槽诊断.queryTopicAnchors,
          queryOnlySlot: 候.槽诊断.queryOnlySlot,
          strippedQuery: 候.槽诊断.strippedQuery,
          highlightSlotEvidence: 候.槽诊断.highlightSlotEvidence,
          highlightTopicMatches: 候.槽诊断.highlightTopicMatches,
          candidateText: String(候.text || ''),
          missing: 候.槽诊断.缺什么,
        },
      })
      return false
    }

    const 槽判 = 查答案槽({
      查询原文,
      候选文本: String(候.text || ''),
      候选类型: 类型,
      候选类目: String((候.raw && 候.raw.category) || ''),
    })
    if (!槽判.可答) {
      拒们.push({
        id: 候.id, type: 类型,
        reason: 'answerability_slot_missing',
        score: 候.totalScore,
        说: 槽判.诊断.missing,
        槽: 槽判.诊断,
      })
      return false
    }

    if (候.totalScore < 最低分) {
      拒们.push({
        id: 候.id, type: 类型,
        reason: 候.relevanceScore === 0 ? 'low_relevance' : 'below_threshold',
        score: 候.totalScore,
        说: 候.relevanceScore === 0
          ? '和当前问题完全没有相关性'
          : '总分 ' + 候.totalScore + ' 低于门槛 ' + 最低分,
      })
      return false
    }
    // ⭐ 硬要求：相关性为 0 的一律不要，哪怕别的分凑够了
    if (候.relevanceScore === 0) {
      拒们.push({
        id: 候.id, type: 类型, reason: 'low_relevance', score: 候.totalScore,
        说: '相关性为 0 —— 不能因为别的加分项混进来',
      })
      return false
    }
    return true
  }

  const 事实过线 = 事实去重后.filter((c) => 过线(c, 'fact'))
  const 事件过线 = 事件留.filter((c) => 过线(c, 'event'))

  // ── 5) 装入预算 ──
  //
  // ⭐ 按「单位字符的信息价值」排，不是简单截断列表：
  //   价值 = totalScore / 文本长度。同样分数，短的更划算。
  const 价值 = (c) => {
    const 长 = Math.max(1, 算字数(c.text))
    return c.totalScore / 长
  }

  let 已用 = 0
  const 装 = (候, 类别, 上限条, 单条上限) => {
    const 收 = []
    for (const c of 候) {
      // ⚠ 文本为空的不许占名额。
      //   什么时候会空：事件有 highlights，但没有一条达到强匹配，
      //   标题自己也不够相关 —— 这种事件不该用一段无关的摘要硬凑一条记忆。
      if (!算字数(c.text)) {
        拒们.push({
          id: c.id, type: c.type, reason: 'low_relevance', score: c.totalScore,
          说: '所引事件没有与当前问题直接相关的内容，不占名额',
        })
        continue
      }
      if (收.length >= 上限条) {
        拒们.push({
          id: c.id, type: c.type, reason: 'over_budget', score: c.totalScore,
          说: 类别 + ' 条数已满（' + 上限条 + '）',
        })
        continue
      }
      const 长 = 算字数(c.text)
      // ⭐ 单条太长：安全淘汰，**绝不从中间截断成残句**
      if (长 > 单条上限) {
        拒们.push({
          id: c.id, type: c.type, reason: 'over_budget', score: c.totalScore,
          说: '单条 ' + 长 + ' 字超过上限 ' + 单条上限 + '，整条不选（不截断）',
        })
        continue
      }
      // 总预算
      if (已用 + 长 > 预算.maxChars) {
        拒们.push({
          id: c.id, type: c.type, reason: 'over_budget', score: c.totalScore,
          说: '总预算不够（已用 ' + 已用 + ' / ' + 预算.maxChars + '）',
        })
        continue
      }
      已用 += 长
      收.push(c)
    }
    return 收
  }

  // 事实里把 open_loop 挑出来单独归到 openLoops
  const openLoop候选 = 事实过线.filter((c) => String(c.raw.category) === 'open_loop')
    .sort((a, b) => 价值(b) - 价值(a) || a.id.localeCompare(b.id))
  const 普通事实候选 = 事实过线.filter((c) => String(c.raw.category) !== 'open_loop')
    .sort((a, b) => 价值(b) - 价值(a) || a.id.localeCompare(b.id))
  const 事件有序 = [...事件过线].sort((a, b) => 价值(b) - 价值(a) || a.id.localeCompare(b.id))

  const 事实收 = 装(普通事实候选, 'facts', 预算.maxFacts, 预算.factMaxChars)
  const 事件收 = 装(事件有序, 'episodes', 预算.maxEpisodes, 预算.episodeMaxChars)
  const 环收 = 装(openLoop候选, 'openLoops', 预算.maxOpenLoops, 预算.factMaxChars)

  // ── 6) 组装输出 ──
  const 造选中 = (c, 类型) => {
    // ⭐⭐ 2026-11-08 诊断真实性：
    //   reasonSelected 只允许出现**查询原文或候选原文里真实存在**的词；
    //   只在同义扩展表里的词（明日方舟/卫戍协议…）不得冒充命中证据。
    //   同义扩展词仍然参与内部算分（relevanceScore 不变），只是不再被展示。
    const 原文 = 类型 === 'fact'
      ? [c.raw.predicate, c.raw.value, c.raw.reason,
        ...(Array.isArray(c.raw.tags) ? c.raw.tags : [])].filter(Boolean).join(' ')
      : [c.raw.title, c.raw.summary,
        ...(Array.isArray(c.raw.highlights) ? c.raw.highlights : [])].filter(Boolean).join(' ')
    const 真 = 过滤真实命中(c.命中, 查询原文, 原文)
    const 词们 = 真.显示.slice(0, 5).join('、')

    return {
      id: c.id,
      type: 类型,
      text: c.text,
      totalScore: c.totalScore,
      scoreBreakdown: c.scoreBreakdown,
      sourceAt: String(c.raw.endAt || c.raw.lastSeenAt || c.raw.updatedAt || c.raw.createdAt || ''),
      // ⚠ 事件一律标 episodic —— 事件卡不能被当成长期事实
      category: 类型 === 'episode'
        ? 'episodic'
        : String(c.raw.category || ''),
      reasonSelected: 类型 === 'fact'
        ? (词们
          ? ('匹配「' + 词们 + '」，相关 ' + c.scoreBreakdown.relevanceScore + ' 分')
          : ('相关 ' + c.scoreBreakdown.relevanceScore + ' 分'
            + '（无可展示的原文命中词：内部分数来自同义扩展，未作为原文证据列出）'))
        : (词们
          ? ('共同经历匹配「' + 词们 + '」')
          : '共同经历匹配（无可展示的原文命中词）'),
      // ⚠ 把被丢弃的扩展词留在结构里，方便排查「为什么分数是 24 但只显示一个词」
      命中诊断: {
        原文命中: 真.原文命中,
        规范概念: 真.规范概念,
        仅扩展未展示: 真.丢弃,
      },
    }
  }

  选.facts = 事实收.map((c) => 造选中(c, 'fact'))
  选.episodes = 事件收.map((c) => 造选中(c, 'episode'))
  选.openLoops = 环收.map((c) => 造选中(c, 'open_loop'))

  const 结果 = {
    schemaVersion: 1,
    session: String(session || ''),
    query: 查询原文,
    generatedAt: 生成时刻,
    budget: {
      maxChars: 预算.maxChars,
      usedChars: 已用,
      remainingChars: Math.max(0, 预算.maxChars - 已用),
    },
    selected: 选,
    rejected: 拒们,
    diagnostics: 诊断,
  }

  const 总 = 选.facts.length + 选.episodes.length + 选.openLoops.length
  if (!总) 诊断.push('没有足够相关的记忆，返回空结果（这是合法且常见的结果）')

  return 结果
}

/** 算字数（中文按字符，一个汉字 = 1） */
export function 算字数(文) {
  // 用 Array.from 而不是 .length —— emoji 等代理对算一个字
  return Array.from(String(文 == null ? '' : 文)).length
}



// 影子召回层（shadow recall）—— 五层记忆的**第四层 A**
//
// ⭐ 2026-11-02 当前用户定的第四阶段 A：根据「当前用户输入」，从长期事实和事件卡里
//   筛选真正相关的记忆，生成一份**受预算约束**的召回预览。
//
// ⚠ 本阶段只做 shadow preview：
//   · 计算召回结果、记录评分与淘汰原因、提供诊断接口
//   · **不接 systemPrompt、不修改模型输入、不影响助手回复**
//   · 不参与 QQ 回复门槛、不调用主动会话
//   · 不改 raw / events / facts / 旧记忆库 / 人格包 / QQ 桥
//   · 不开启任何自动扫描
//
// ⚠ 硬约束：
//   1. **只读** facts 和 events。绝不读 raw、event-state/open、DSH session 历史、
//      assistant/message、压缩摘要、旧记忆库、诊断日志、人格包、QQ 桥。
//   2. **不调用模型**。纯确定性计算，同样输入必得同样输出。
//   3. **不写任何文件**。这个模块连写函数都不引入。
//
// ⭐ 相关性第一版用可测试、可解释的确定性方法：中文 n-gram + 关键词交集 +
//   同义词小词表 + 时间词/实体匹配。绝不引入向量库，绝不为召回再调大模型
//   —— 那样成本、延迟、非确定性都不可控。
//
// ⭐ 架构上预留 semanticScore 接口，当前恒返回 0。