// 影子召回的上下文渲染器 —— 第四层 A
//
// ⭐ 2026-11-02 当前用户定的规则，一条都不许违反：
//   · 只写 selected 内容
//   · 空类别不输出标题
//   · 全部为空时返回**空字符串**
//   · 不输出分数、ID、来源文件、系统术语
//   · 不写「根据记忆库」
//   · 不要求模型主动提起
//   · 不改变人格和说话风格
//
// ⚠ **本阶段禁止接线。** 这个函数存在的意义是让人看见「如果接线，注入的会长什么样」，
//   但它不接 systemPrompt.section / systemPrompt.context，
//   也不被任何回复路径调用。测试会盯着这一点。

/** 渲染出的标题 —— 刻意平淡，不吓唬模型 */
const 标题们 = {
  facts: '事实',
  episodes: '共同经历',
  openLoops: '未完成事项',
}

const 总标题 = '【可用记忆｜仅在相关时自然参考，不要主动复述】'

/**
 * 把召回结果渲染成未来可能注入的文本。
 *
 * ⚠ 只吃 selected。rejected / diagnostics / 分数 / id 一律不出现。
 *
 * @param {object} 结果 召回() 的返回值
 * @returns {string} 全部为空时返回 ''
 */
export function 渲染(结果) {
  const 选 = (结果 && 结果.selected) || {}
  const 段们 = []

  for (const 键 of ['facts', 'episodes', 'openLoops']) {
    const 列 = Array.isArray(选[键]) ? 选[键] : []
    if (!列.length) continue   // ⭐ 空类别不输出标题

    const 行们 = []
    for (const 项 of 列) {
      const 文 = 清洗文本(项 && 项.text)
      if (!文) continue        // 空的项也不占位置
      行们.push('- ' + 文)
    }
    if (!行们.length) continue

    段们.push(标题们[键] + '：\n' + 行们.join('\n'))
  }

  // ⭐ 全部为空 → 空字符串（不是「（无记忆）」这种废话）
  if (!段们.length) return ''

  return 总标题 + '\n' + 段们.join('\n\n')
}

/**
 * 清洗一条要渲染的文本。
 *
 * ⚠ 防御性：就算上游不小心把 id / 分数 / 路径拼进了 text，
 *   这里也要把它剥掉。渲染器是最后一道闸。
 */
export function 清洗文本(文) {
  let s = String(文 == null ? '' : 文)

  // 去掉可能的 ID（fact-xxxx / ev-xxxx / session-xxxx）
  //
  // ⚠ 不能只剥前缀：`fact-9e145b49-930adfe1` 里 `fact-` 后面那段哈希
  //   剥掉前缀会剩下 `-930adfe1` —— 半截 ID 一样是泄漏。
  //   先把整串（含后续的字母数字和连字符）一起吃掉，再处理裸哈希。
  s = s.replace(/\b(?:fact|ev|session|cf)-[0-9a-z][0-9a-z-]*/gi, '')
  // 没前缀但长得像哈希的（8 位以上十六进制）
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, '')

  // 去掉文件路径。
  // ⚠ 必须同时覆盖：盘符路径、~/ 路径、.dsh 路径，
  //   以及**看着像数据文件的裸路径**（/fish-memory/facts/x.jsonl）。
  //   最后这种最容易漏 —— 它没有盘符，却明确泄漏了存哪里。
  s = s.replace(/[A-Za-z]:[\\/][^\s，。；、）)]*/g, '')
  s = s.replace(/~\/[^\s，。；、）)]*/g, '')
  s = s.replace(/\.dsh[\\/][^\s，。；、）)]*/g, '')
  // 带数据文件后缀的裸路径（可能带前导斜杠）
  s = s.replace(/\/?[\w.-]*(?:[\\/][\w.-]+)*[\\/][\w.-]+\.(?:jsonl|json|ndjson|log|db|sqlite|txt|md)\b/gi, '')
  // 剩下的、含记忆目录名的路径
  s = s.replace(/\/?(?:fish-memory[-\w]*|events|facts|raw|fact-state|fact-conflicts)(?:[\\/][\w.-]*)*/gi, '')

  // 去掉 JSON 尾巴、分数、括号里的分数
  s = s.replace(/\b(?:totalScore|scoreBreakdown|relevanceScore|confidence|schemaVersion)\b\s*[:=]\s*[-0-9.]+/gi, '')
  s = s.replace(/（?\s*(?:分数?|score)\s*[:=]\s*\d+\s*）?/gi, '')
  s = s.replace(/（?\s*分数\s*[:：]?\s*\d+\s*）?/g, '')

  // 去掉多余空白和残留的括号
  s = s.replace(/[（(]\s*[）)]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[-－—:：,，/\s]+|[-－—:：,，/\s]+$/g, '')
  s = s.replace(/（\s*）|\(\s*\)/g, '')
  s = s.replace(/\s+/g, ' ').trim()

  return s
}

/**
 * 渲染一个「空」的自检 —— 便于测试和诊断接口直接问。
 * @returns {{empty:boolean, text:string, chars:number}}
 */
export function 渲染自检(结果) {
  const t = 渲染(结果)
  return {
    empty: t === '',
    text: t,
    chars: Array.from(t).length,
  }
}
