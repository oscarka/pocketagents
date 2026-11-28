// Verified Voice Barge-In Gate: prevents ambient noise, coughs, brief fillers ("嗯/啊/哦"),
// and TTS speaker echo from falsely interrupting an in-progress Walk Mode briefing.

const PURE_VOCAL_FILLER_RE =
  /^(?:嗯+|啊+|哦+|喔+|噢+|呃+|额+|唉+|哎+|诶+|欸+|哈+|呵+|嘿+|喂+|唔+|啧+|咳+|呀+|嘛+|吧+|嗯哼|嗯嗯|啊啊|哦哦|哈哈|呵呵|那个|就是|什么|对对|是吗|uh+|um+|ah+|oh+|hmm+|huh+|mhm+)$/i

const CASUAL_NON_APPROVAL_FILLER_RE =
  /^(?:好吧|行吧|yeah|ok|okay)$/i

const SEMANTIC_APPROVAL_DECISION_RE =
  /^(?:嗯)?(?:可以[呀啊吧的啦]?|行[呀啊吧啦]?|好的|好吧|好[呀啊啦]|没问题|没啥问题|执行吧|跑吧|让它跑吧?|过吧?|准了?|ok|okay|yes|yep|sure|goahead|不行|不要|算了|先别|别跑|别执行|不让|不准|no|nope)$/i

const EXPLICIT_COMMAND_RE =
  /(放行|批准|同意|允许|通过|拒绝|驳回|不同意|别执行|不要执行|取消|跳过|停止|停一下|停下来|别说了|闭嘴|暂停|下一条|下一个|重说|再说一遍|继续|确认码|选第|第[一二三四1234]|一号|二号|三号|四号|帮我|查看|汇报|进度|待审批|修改|改成|不要|\b(?:approve|allow|deny|reject|stop|skip|cancel|next|pause|repeat)\b|\d{3})/i

const STOP_ONLY_RE =
  /^(?:停|停下|停止|停一下|停下来|别说了|闭嘴|先停|暂停|跳过|下一条|不用说了|知道了|stop|skip|pause)$/i

function normalizeForEchoCompare(raw = '') {
  return String(raw || '')
    .toLowerCase()
    .replace(/[\s`*_#>\-—~·.,，。！？!?：:;；、"'“”‘’()（）[\]【】]/g, '')
}

function computeBigramOverlap(candidateNorm, spokenNorm) {
  if (!candidateNorm || !spokenNorm) return 0
  if (candidateNorm.length < 2) {
    return spokenNorm.includes(candidateNorm) ? 1 : 0
  }
  const spokenBigrams = new Set()
  for (let i = 0; i < spokenNorm.length - 1; i += 1) {
    spokenBigrams.add(spokenNorm.slice(i, i + 2))
  }
  let hits = 0
  const total = candidateNorm.length - 1
  for (let i = 0; i < total; i += 1) {
    if (spokenBigrams.has(candidateNorm.slice(i, i + 2))) {
      hits += 1
    }
  }
  return total > 0 ? hits / total : 0
}

/**
 * Evaluate whether an STT transcript captured DURING Walk Mode TTS playback
 * represents a genuine, intentional user interruption rather than noise, backchannel, or TTS echo.
 *
 * Returns `{ accept: boolean, reason: string, stopOnly?: boolean, cleaned: string }`.
 */
export function evaluateBargeInUtterance(transcript = '', currentlySpokenText = '', opts = {}) {
  const cleaned = String(transcript || '').trim()
  const norm = normalizeForEchoCompare(cleaned)
  const hasPendingApproval = Boolean(opts?.hasPendingApproval)
  if (!norm) {
    return { accept: false, reason: 'empty', cleaned: '' }
  }

  // 1. Always reject pure meaningless vocal fillers ("嗯", "哦", "啊", "哈哈", "那个")
  if (PURE_VOCAL_FILLER_RE.test(norm)) {
    return { accept: false, reason: 'filler', cleaned }
  }

  // 2. When a pending approval is actively awaiting the user's decision, accept natural spoken
  //    semantic consent/refusal ("可以", "没问题", "好的", "行", "行吧", "好吧", "不要", "算了", "OK")
  //    unless it looks like a question ("可以吗", "行吗").
  if (hasPendingApproval && !/[吗呢？?]$/.test(cleaned) && SEMANTIC_APPROVAL_DECISION_RE.test(norm)) {
    return { accept: true, reason: 'semantic_approval_decision', stopOnly: false, cleaned }
  }

  // Outside active approval windows, casual backchannels ("好吧", "行吧", "ok") stay rejected.
  if (CASUAL_NON_APPROVAL_FILLER_RE.test(norm)) {
    return { accept: false, reason: 'filler', cleaned }
  }

  // 3. Direct stop/skip commands are ALWAYS accepted immediately (short and unambiguous)
  if (STOP_ONLY_RE.test(norm)) {
    return { accept: true, reason: 'stop_command', stopOnly: true, cleaned }
  }

  const isExplicitCommand = EXPLICIT_COMMAND_RE.test(cleaned)

  // 3. TTS acoustic self-echo rejection:
  //    If the speaker's own TTS text leaked into the mic, reject it!
  //    Exempt short explicit commands (<= 5 chars like "放行", "拒绝", "同意", "一号放行")
  //    because briefings often end with "请说放行或拒绝".
  const spokenNorm = normalizeForEchoCompare(currentlySpokenText)
  if (spokenNorm && norm.length >= 4 && !(isExplicitCommand && norm.length <= 5)) {
    if (spokenNorm.includes(norm)) {
      return { accept: false, reason: 'tts_echo_substring', cleaned }
    }
    const overlap = computeBigramOverlap(norm, spokenNorm)
    if (overlap >= 0.62) {
      return { accept: false, reason: 'tts_echo_overlap', cleaned }
    }
  }

  // 4. Explicit actionable command (approval, rejection, slot, PIN, task instruction)
  if (isExplicitCommand) {
    return { accept: true, reason: 'explicit_command', stopOnly: false, cleaned }
  }

  // 5. General natural-language follow-up must be at least 4 meaningful characters
  //    so stray 1-3 char ambient murmurs ("什么", "对", "好吧", "这里") never cut off a briefing!
  if (norm.length >= 4) {
    return { accept: true, reason: 'substantive_speech', stopOnly: false, cleaned }
  }

  return { accept: false, reason: 'too_short_non_command', cleaned }
}
