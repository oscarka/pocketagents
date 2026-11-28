import { randomBytes } from 'node:crypto'
import { basename, dirname, posix as posixPath } from 'node:path'

const DRAFT_TTL_MS = 5 * 60_000

// ── 1. 口语确认 / 拒绝 / 含糊分类器（借鉴 Mini Health voiceWrite.ts 实战防误触规则） ──
const NO_RE =
  /不对|不是|错了|别建|不用建|不要建|不建|算了|先不建|先不|取消|不用了|不要了|不行|不创建|别创建|^(?:不+|不要|别+|不用|没有|否)[，,。！!\s]*$/i
const YES_SEQ =
  /^(?:(?:嗯|哦)[，,\s]*)?(?:(?:对|对的|对啊|对呀|是|是的|是啊|好|好的|好吧|好啊|好呀|行|行的|行吧|可以|可以的|没错|没问题|没啥问题|正确|就这样|就这么建|建吧|创建|创建吧|确认|确定|确认创建|确定创建|开始吧|跑吧|来吧|好啦|好哦|行啊|可以啊|好嘞|ok|okay|yes|yep|sure|confirm)[，,。.！!~～\s]*)+$/i
const HEDGE_RE =
  /可能|大概|好像|应该|不一定|不确定|不太确定|不太清楚|没把握|拿不准|不知道|不清楚|等等|等一下|等下|我想想|想想|没听清|听不清|再说一遍|重复|再念|再读|嗯\.\.\.|嗯…|呃|额|吧[?？]$|是吗|对吗|是不是|行吗|可以吗/i
const HEDGE_ONLY = /^(?:啥|什么|啊+|哈+|嗯+|哦+)[?？。！!\s]*$/
// 只要包含转折、修改、疑问或额外新条件，绝不能走宽松肯定
const LOOSE_BLOCK =
  /不过|但是|但|可是|然而|改|换|问|吗|怎么|什么|为什么|还有|还想|别|没|等|再|不对|不是|\?|？/
const YES_FILLER = /[就这样啊呀哦嘛呢那]/g

/**
 * Classify a user's spoken reply to a confirmation readback.
 * Returns `'yes' | 'no' | 'ambiguous' | 'other'`.
 */
export function classifyVoiceReply(utter = '') {
  const u = String(utter || '').replace(/\s+/g, '').trim()
  if (!u) return 'ambiguous'
  if (HEDGE_ONLY.test(u)) return 'ambiguous'
  if (YES_SEQ.test(u)) return 'yes'
  const core0 = u.replace(YES_FILLER, '')
  const core = core0.replace(/^(.+?)吧[，,。.！!]*$/, (m, a) => (/^[对是]$/.test(a) ? m : a))
  if (core && core !== u && /[对是好行可建确]/.test(core) && YES_SEQ.test(core)) return 'yes'
  if (NO_RE.test(u)) return 'no'
  if (HEDGE_RE.test(u)) return 'ambiguous'
  if (
    u.length <= 18
    && /(?:对|是的|是啊|好的|好吧|好啊|行|可以|没错|确认|确定|创建|建吧|就这样|没问题|ok|yes)/i.test(u)
    && !LOOSE_BLOCK.test(u)
  ) {
    return 'yes'
  }
  return 'other'
}

// ── 2. Tier 0：0ms 确定性播报控速与队列控制快轨（不走大模型） ────────────────────
function clampRate(val) {
  const n = Math.round(Number(val) * 20) / 20
  return Math.max(0.75, Math.min(2.0, Number.isFinite(n) ? n : 1.0))
}

const SPEED_CN_MAP = {
  一倍: 1.0,
  一点二五倍: 1.25,
  一点五倍: 1.5,
  一点七五倍: 1.75,
  两倍: 2.0,
  二倍: 2.0,
  零点七五倍: 0.75,
  零点八倍: 0.8,
}

export function parsePlaybackControlFastPath(utter = '', currentRate = 1.0) {
  const raw = String(utter || '').trim()
  const compact = raw
    .replace(/[，,。！!？?~～\s]+/g, '')
    .replace(/(?<!\d)\.|\.(?!\d)/g, '')
  if (!compact || compact.length > 22) return null

  const cur = clampRate(currentRate)

  // Explicit numeric speed: "1.5倍速", "调到1.25倍", "2倍速"
  const numRate = /(?:调到|设成|设为|换成|语速)?([0-2](?:\.\d{1,2})?)倍(?:速)?$/.exec(compact)
  if (numRate && /^(?:调到|设成|设为|换成|语速|播报|语音)?[0-2](?:\.\d{1,2})?倍(?:速)?$/.test(compact)) {
    const nextRate = clampRate(parseFloat(numRate[1]))
    return {
      kind: 'set_speed',
      speechRate: nextRate,
      spokenReply: `已调到 ${nextRate} 倍速。`,
    }
  }

  for (const [cnWord, rateVal] of Object.entries(SPEED_CN_MAP)) {
    if (new RegExp(`^(?:调到|设成|设为|换成|语速)?${cnWord}速?$`).test(compact)) {
      return {
        kind: 'set_speed',
        speechRate: rateVal,
        spokenReply: `已调到 ${rateVal} 倍速。`,
      }
    }
  }

  // Faster / Slower / Normal
  if (/^(?:再)?(?:加速|快一点|快点|说快点|说快一点|念快点|念快一点|播快点|播快一点|提速|快些|太慢了|太慢了快点|faster|speedup)[吧啊呀啦哦]*$/i.test(compact)) {
    const nextRate = clampRate(cur + 0.25)
    return {
      kind: 'set_speed',
      speechRate: nextRate,
      spokenReply: nextRate >= 2.0 && cur >= 2.0 ? '已经是最快 2 倍速了。' : `已加速到 ${nextRate} 倍速。`,
    }
  }
  if (/^(?:再)?(?:减速|慢一点|慢点|说慢点|说慢一点|念慢点|念慢一点|播慢点|播慢一点|放慢|慢些|太快了|太快了慢点|slower|slowdown)[吧啊呀啦哦]*$/i.test(compact)) {
    const nextRate = clampRate(cur - 0.25)
    return {
      kind: 'set_speed',
      speechRate: nextRate,
      spokenReply: nextRate <= 0.75 && cur <= 0.75 ? '已经是最慢 0.75 倍速了。' : `已放慢到 ${nextRate} 倍速。`,
    }
  }
  if (/^(?:恢复原速|正常语速|原速|默认语速|正常速度|恢复正常语速|normalspeed)[吧啊呀啦哦]*$/i.test(compact)) {
    return {
      kind: 'set_speed',
      speechRate: 1.0,
      spokenReply: '已恢复正常 1 倍速。',
    }
  }

  // Queue navigation
  if (/^(?:下一条|下一个|跳过|跳过这条|换下一条|继续下一条|播下一条|next|skip)[吧啊呀啦哦]*$/i.test(compact)) {
    return { kind: 'queue_next', spokenReply: '好的，切到下一条。' }
  }
  if (/^(?:上一条|上一个|回到上一条|前一条|播上一条|prev|previous)[吧啊呀啦哦]*$/i.test(compact)) {
    return { kind: 'queue_prev', spokenReply: '好的，回到上一条。' }
  }
  if (/^(?:再念一遍|重播|再说一遍|重复一遍|没听清再说一遍|再读一遍|重听|repeat|replay)[吧啊呀啦哦]*$/i.test(compact)) {
    return { kind: 'queue_repeat', spokenReply: '好的，再为你念一遍。' }
  }
  if (/^(?:暂停播报|先暂停|暂停一下|暂停队列|先别念了|闭嘴|别念了|pause)[吧啊呀啦哦]*$/i.test(compact)) {
    return { kind: 'queue_pause', spokenReply: '好的，已暂停播报。' }
  }
  if (/^(?:继续播报|恢复播报|继续念|接着念|开始播报|播报队列|resume)[吧啊呀啦哦]*$/i.test(compact)) {
    return { kind: 'queue_resume', spokenReply: '好的，继续为你播报。' }
  }

  return null
}

// ── 3. 工作区、电脑、工具解析与新建目录校验辅助函数 ──────────────────────────
const HARNESS_LABELS = {
  'antigravity-ide': 'Antigravity',
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'DSH',
  workbuddy: 'WorkBuddy',
}

export function getHarnessLabel(id = '') {
  const key = String(id || '').trim().toLowerCase()
  return HARNESS_LABELS[key] || (key ? key : '默认工具')
}

export function sanitizeWorkspaceFolderName(raw = '') {
  let s = String(raw || '').trim()
  s = s
    .replace(/^[“"「『'‘(（\s]+|[”"」』'’)）\s。.！!？?，,]+$/g, '')
    .replace(/(?:这个|那个)?(?:工作区|项目目录|项目文件夹|文件夹|目录|项目)[吧啊呀啦呢]*$/g, '')
    .replace(/^(?:叫|叫做|叫作|名为|名字叫|名字是|起名叫|命名为)\s*/g, '')
    .trim()
  // Strip path separators & traversal characters strictly
  s = s.replace(/[\\/]+/g, '-').replace(/\.\.+/g, '').replace(/^\.+/, '').replace(/\s+/g, '-')
  s = s.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '')
  s = s.replace(/^-+|-+$/g, '').slice(0, 48)
  if (!s || /^(?:新建|新|空|随便|默认|工作区|目录|文件夹|项目)$/.test(s)) return ''
  return s
}

export function resolveNewWorkspacePath(hostWorkspaces = [], folderName = '') {
  const cleanName = sanitizeWorkspaceFolderName(folderName)
  if (!cleanName) return ''
  const validDirs = (Array.isArray(hostWorkspaces) ? hostWorkspaces : [])
    .map(w => String(w || '').trim())
    .filter(w => w.startsWith('/') && w.length > 2)
  if (validDirs.length > 0) {
    // Pick the most frequent parent directory (typically /Users/<name> or /Users/<name>/projects)
    const parentCounts = new Map()
    for (const d of validDirs) {
      const p = dirname(d)
      if (p && p !== '/' && p !== '.') {
        parentCounts.set(p, (parentCounts.get(p) || 0) + 1)
      }
    }
    let bestParent = ''
    let bestScore = -1
    for (const [p, count] of parentCounts.entries()) {
      if (count > bestScore) {
        bestParent = p
        bestScore = count
      }
    }
    if (bestParent) {
      return posixPath.join(bestParent, cleanName)
    }
  }
  return `~/${cleanName}`
}

const CN_INDEX_MAP = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

export function extractSpokenOrdinal(utter = '') {
  // Strip host aliases like "mini2", "no2mini", "mac1" so their digits are never misread as workspace ordinals
  const s = String(utter || '')
    .replace(/\b(?:mini|no|mac|air|studio)\s*\d+\b/gi, '')
    .trim()
  const m = /(?<![A-Za-z0-9])(?:第|选|用|就)?([1-6一二两三四五六])(?:号|个|台|项)(?![A-Za-z0-9])|(?<![A-Za-z0-9])(?:第|选)([1-6一二两三四五六])(?![A-Za-z0-9])/.exec(s)
  if (!m) return 0
  const raw = m[1] || m[2]
  return /^\d$/.test(raw) ? Number(raw) : (CN_INDEX_MAP[raw] || 0)
}

export function matchHostInText(utter = '', hosts = [], presentedHosts = []) {
  const list = Array.isArray(hosts) ? hosts : []
  if (!list.length) return null
  const text = String(utter || '').trim()
  const lower = text.toLowerCase()
  if (!lower) return null

  // 1. Direct alias matching against hostId / hostName
  const scored = []
  for (const h of list) {
    const id = String(h.hostId || '').toLowerCase()
    const name = String(h.hostName || '').toLowerCase()
    let score = 0
    if (id && lower.includes(id)) score = Math.max(score, 100)
    if (name && lower.includes(name)) score = Math.max(score, 95)
    // Short common tokens: "air", "macbook", "no2", "mini2", "mini1", "digtalhealthlink"
    if (/\bair\b|macbook\s*air|笔记本/.test(lower) && /air/.test(`${id} ${name}`)) {
      score = Math.max(score, 85)
    }
    if (/no2|mini\s*2|二号\s*mini|2号\s*mini|第二台\s*mini/.test(lower) && /no2/.test(`${id} ${name}`)) {
      score = Math.max(score, 85)
    }
    if (/mini\s*1|一号\s*mini|1号\s*mini|第一台\s*mini|health|健康/.test(lower) && /health|digtal/.test(`${id} ${name}`)) {
      score = Math.max(score, 80)
    }
    if (/studio/.test(lower) && /studio/.test(`${id} ${name}`)) {
      score = Math.max(score, 85)
    }
    if (score > 0) scored.push({ host: h, score })
  }
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score)
    if (scored.length === 1 || scored[0].score > scored[1].score) {
      return scored[0].host
    }
  }

  // 2. Ordinal matching from presented host list ("1号", "第一台")
  const ordPool = Array.isArray(presentedHosts) && presentedHosts.length > 0 ? presentedHosts : list
  if (/(?:电脑|台|号|机器|第[1-6一二两三四五六])/.test(text) || /^[1-6一二两三四五六](?:号|台|个)?[。！!\s]*$/.test(text)) {
    const ord = extractSpokenOrdinal(text)
    if (ord >= 1 && ord <= ordPool.length) {
      const targetId = ordPool[ord - 1]?.hostId || ordPool[ord - 1]
      return list.find(h => h.hostId === targetId) || null
    }
  }

  return null
}

export function matchHarnessInText(utter = '') {
  const lower = String(utter || '').toLowerCase()
  if (/antigravity|反重力|\bagy\b/.test(lower)) return 'antigravity-ide'
  if (/\bcodex\b|代码克斯/.test(lower)) return 'codex'
  if (/\bclaude\b|克劳德/.test(lower)) return 'claude'
  if (/workbuddy|工作伙伴/.test(lower)) return 'workbuddy'
  if (/\bdsh\b|deepseek\s*harness/.test(lower)) return 'dsh'
  return ''
}

export function pickDefaultHarnessForHost(hostId = '', tasks = []) {
  const hostTasks = (Array.isArray(tasks) ? tasks : []).filter(t => t.hostId === hostId)
  const controllable = hostTasks.find(t => t.harness && t.harness !== 'doubao')
  if (controllable?.harness) return String(controllable.harness)
  return 'antigravity-ide'
}

export function extractNewWorkspaceRequest(utter = '') {
  const text = String(utter || '').trim()
  if (!text) return null
  // Explicit new workspace with name: "新建工作区叫 my-app", "建个新目录叫 video-lab", "新工作区 travel-bot"
  const namedPatterns = [
    /(?:新建|新开|创建|建个|建一个|开个|开一个)(?:一个)?(?:新)?(?:工作区|项目目录|项目文件夹|文件夹|目录|项目)[，,：:\s]*(?:叫|叫做|叫作|名为|名字叫|名字是|起名叫|命名为)\s*[“"「『'‘]?([A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})[”"」』'’]?/i,
    /(?:新建|新开|创建|建个|建一个|开个|开一个)(?:一个)?(?:新)?(?:工作区|项目目录|项目文件夹|文件夹|目录)[：:\s]+[“"「『'‘]?([A-Za-z][A-Za-z0-9_\-]{1,39})[”"」』'’]?/i,
    /(?:新建|新开|创建|建个|建一个|开个|开一个)(?:一个)?(?:新)?(?:工作区|项目目录|项目文件夹|文件夹|目录)[，,：:\s]*[“"「『]([A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})[”"」』]/i,
    /(?:新工作区|新目录|新文件夹|新项目)[，,：:\s]*(?:叫|叫做|叫作|名为|名字叫|名字是|起名叫|命名为)\s*[“"「『'‘]?([A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})[”"」』'’]?/i,
    /(?:新工作区|新目录|新文件夹|新项目)[：:\s]+[“"「『'‘]?([A-Za-z][A-Za-z0-9_\-]{1,39})[”"」』'’]?/i,
    /(?:目录|工作区|文件夹|名字)(?:改叫|改成|改为|叫|起名叫|命名为)\s*[：:\s“"「『'‘]*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,40})[”"」』'’]?/i,
  ]
  for (const re of namedPatterns) {
    const m = re.exec(text)
    if (m && m[1]) {
      const cleaned = sanitizeWorkspaceFolderName(m[1])
      if (cleaned && !/^(?:帮我|然后|用来|去做|做|写|跑|查|看|修|任务|对话|会话|一个|吧|的)$/.test(cleaned)) {
        return { workspaceMode: 'new', newWorkspaceName: cleaned }
      }
    }
  }
  // Explicit new workspace WITHOUT a name yet: "新建工作区", "建一个新目录", "我要新建工作区"
  if (/(?:新建|新开|创建|建个|建一个|开个|开一个)(?:一个)?(?:新的?)?(?:工作区|项目目录|项目文件夹|目录|文件夹)|用新工作区|用新目录/.test(text)) {
    return { workspaceMode: 'new', newWorkspaceName: '' }
  }
  return null
}

export function matchExistingWorkspaceInText(utter = '', hostWorkspaces = [], presentedWorkspaces = []) {
  const text = String(utter || '').trim()
  const lower = text.toLowerCase()
  if (!lower) return null

  const pool = Array.isArray(presentedWorkspaces) && presentedWorkspaces.length > 0
    ? presentedWorkspaces
    : (Array.isArray(hostWorkspaces) ? hostWorkspaces : []).map(cwd => ({
        cwd: String(cwd || ''),
        label: basename(String(cwd || '')) || String(cwd || ''),
      }))

  // 1. Direct match by folder basename or alias
  let best = null
  let bestLen = 0
  for (const item of pool) {
    const cwd = String(item?.cwd || '')
    const label = String(item?.label || basename(cwd) || '')
    if (!cwd || !label) continue
    const lLower = label.toLowerCase()
    if (lower.includes(lLower) && lLower.length > bestLen) {
      best = { cwd, label }
      bestLen = lLower.length
      continue
    }
    // Common short aliases: pocketagents -> deepseekharness-remote
    if (/pocket\s*agents?|远控/.test(lower) && /deepseekharness|pocketagents/.test(lLower)) {
      best = { cwd, label }
      bestLen = Math.max(bestLen, 10)
    } else if (/mini\s*health|微健管|健康/.test(lower) && /mini-health/.test(lLower)) {
      best = { cwd, label }
      bestLen = Math.max(bestLen, 10)
    }
  }
  if (best) return best

  // 2. Ordinal match from presented workspace list ("1号", "第一个项目", "用2号")
  if (Array.isArray(presentedWorkspaces) && presentedWorkspaces.length > 0) {
    const ord = extractSpokenOrdinal(text)
    if (ord >= 1 && ord <= presentedWorkspaces.length) {
      const picked = presentedWorkspaces[ord - 1]
      if (picked?.cwd) return { cwd: picked.cwd, label: picked.label || basename(picked.cwd) }
    }
  }

  return null
}

export function detectNewTaskIntent(utter = '') {
  const s = String(utter || '').trim()
  if (!s) return false
  if (/[？?]$|吗[？?]?$/.test(s)) return false
  return /(?:^|(?:请|麻烦|帮我|给我|我要|我想|先|现在|去|在.{1,16}))(?:新建|新开|开个|开一个|创建|起一个|发起)(?:一个)?(?:新)?(?:任务|对话|会话)|(?:新建|新开|建一个)(?:一个)?(?:工作区|目录|文件夹).*(?:做|写|跑|查|开发|任务|项目)/i.test(s)
}

export function extractInitialTaskPrompt(utter = '') {
  let s = String(utter || '').trim()
  // Strip leading host/workspace/harness scaffolding to keep the clean task description
  s = s
    .replace(/^(?:请|麻烦|帮我|给我|我要|我想|先|现在)+/g, '')
    .replace(/^(?:在[^，。,；;]{1,20}?上?\s*)/, '')
    .replace(
      /(?:新建|新开|建个|建一个|开个|开一个)(?:一个)?(?:新)?(?:工作区|项目目录|项目文件夹|文件夹|目录)(?:[，,：:\s]*(?:叫|叫做|叫作|名为|名字叫|名字是|起名叫|命名为)\s*[“"「『'‘]?[A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}[”"」』'’]?|[：:\s]+[“"「『'‘]?[A-Za-z][A-Za-z0-9_\-]{1,32}[”"」』'’]?|[，,：:\s]*[“"「『][A-Za-z0-9_\-\u4e00-\u9fa5]{1,32}[”"」』])?/gi,
      ''
    )
    .replace(/(?:用|使用)(?:antigravity|反重力|agy|codex|claude(?:\s*code)?|dsh|workbuddy)/gi, '')
    .replace(/(?:新建|新开|开个|开一个|创建|起一个|发起)(?:一个)?(?:新)?(?:任务|对话|会话)/g, '')
    .replace(/^[，,：:\s]*(?:帮我|给我|去|来|用来|做|执行)?[，,：:\s]*/g, '')
    .replace(/[。！!]+$/g, '')
    .trim()
  if (s.length < 2) return ''
  // Avoid treating pure host/workspace answers as the prompt
  if (/^(?:在)?(?:air|macbook\s*air|mini\d?|no2mini|工作区|新工作区|目录)[。！!\s]*$/i.test(s)) return ''
  return s
}

// ── 4. 多轮新建任务槽位校验状态机（Draft -> Validate -> Readback -> 0ms Commit） ──
export class VoiceNewTaskDraftManager {
  constructor({ now = () => Date.now(), ttlMs = DRAFT_TTL_MS } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.drafts = new Map() // voiceSessionId -> draft
  }

  getActive(voiceSessionId = 'default') {
    const sid = String(voiceSessionId || 'default')
    const d = this.drafts.get(sid)
    if (!d) return null
    if (this.now() - d.updatedAt > this.ttlMs) {
      this.drafts.delete(sid)
      return null
    }
    return d
  }

  clear(voiceSessionId = 'default') {
    this.drafts.delete(String(voiceSessionId || 'default'))
  }

  toPublicCard(draft) {
    if (!draft) return null
    return {
      id: draft.id,
      status: draft.status, // 'collecting' | 'awaiting_confirm'
      hostId: draft.hostId || '',
      hostName: draft.hostName || '',
      workspaceMode: draft.workspaceMode || '', // 'existing' | 'new' | ''
      cwd: draft.cwd || '',
      workspaceLabel: draft.workspaceMode === 'new'
        ? (draft.newWorkspaceName ? `新建工作区：${draft.newWorkspaceName}` : '待命名新工作区')
        : (draft.workspaceLabel || ''),
      newWorkspaceName: draft.newWorkspaceName || '',
      createDir: Boolean(draft.createDir),
      harness: draft.harness || '',
      harnessLabel: draft.harness ? getHarnessLabel(draft.harness) : '',
      prompt: draft.prompt || '',
      missingFields: this._computeMissingFields(draft),
      presentedHosts: draft.presentedHosts || [],
      presentedWorkspaces: draft.presentedWorkspaces || [],
    }
  }

  _computeMissingFields(draft) {
    const missing = []
    if (!draft.hostId) missing.push('host')
    if (!draft.workspaceMode) {
      missing.push('workspace')
    } else if (draft.workspaceMode === 'new' && !draft.newWorkspaceName) {
      missing.push('new_workspace_name')
    } else if (draft.workspaceMode === 'existing' && !draft.cwd) {
      missing.push('workspace')
    }
    if (!draft.prompt) missing.push('prompt')
    return missing
  }

  _buildHostList(ctx) {
    const hosts = Array.isArray(ctx?.hosts) ? ctx.hosts : []
    const online = hosts.filter(h => h.online)
    return online.length > 0 ? online : hosts
  }

  _buildWorkspaceOptions(host) {
    const ws = Array.isArray(host?.workspaces) ? host.workspaces : []
    return ws
      .filter(Boolean)
      .slice(0, 4)
      .map((cwd, idx) => ({
        slot: idx + 1,
        cwd: String(cwd),
        label: basename(String(cwd)) || String(cwd),
      }))
  }

  _buildReadback(draft, again = false) {
    const pre = again ? '我再核对一下：' : '核对一下：'
    const wsDesc = draft.workspaceMode === 'new'
      ? `新建工作区「${draft.newWorkspaceName}」`
      : `「${draft.workspaceLabel || basename(draft.cwd)}」项目`
    const harnessDesc = getHarnessLabel(draft.harness)
    const promptShort = draft.prompt.length > 36 ? `${draft.prompt.slice(0, 36)}…` : draft.prompt
    return `${pre}在 ${draft.hostName} ${wsDesc}，用 ${harnessDesc} 执行「${promptShort}」，确认创建吗？`
  }

  _applyExtractedSlots(draft, utter, ctx, { allowBareWorkspaceName = false, allowBarePrompt = false } = {}) {
    const hosts = this._buildHostList(ctx)
    const matchedHost = matchHostInText(utter, hosts, draft.presentedHosts)
    let changed = false
    if (matchedHost && matchedHost.hostId !== draft.hostId) {
      draft.hostId = matchedHost.hostId
      draft.hostName = matchedHost.hostName || matchedHost.hostId
      draft.presentedWorkspaces = this._buildWorkspaceOptions(matchedHost)
      if (!draft.harness || draft.harnessAutoDefault) {
        draft.harness = pickDefaultHarnessForHost(draft.hostId, ctx?.tasks)
        draft.harnessAutoDefault = true
      }
      // If switching host while an existing cwd belonged to another host, clear cwd so we re-validate
      if (draft.workspaceMode === 'existing' && draft.cwd && !(matchedHost.workspaces || []).includes(draft.cwd)) {
        draft.cwd = ''
        draft.workspaceLabel = ''
        draft.workspaceMode = ''
      } else if (draft.workspaceMode === 'new' && draft.newWorkspaceName) {
        draft.cwd = resolveNewWorkspacePath(matchedHost.workspaces, draft.newWorkspaceName)
      }
      changed = true
    }

    // Auto-select sole online host if only 1 host exists
    if (!draft.hostId && hosts.length === 1) {
      draft.hostId = hosts[0].hostId
      draft.hostName = hosts[0].hostName || hosts[0].hostId
      draft.presentedWorkspaces = this._buildWorkspaceOptions(hosts[0])
      if (!draft.harness) {
        draft.harness = pickDefaultHarnessForHost(draft.hostId, ctx?.tasks)
        draft.harnessAutoDefault = true
      }
    }

    const hostObj = hosts.find(h => h.hostId === draft.hostId) || null
    const hostWorkspaces = hostObj?.workspaces || []
    if (hostObj && draft.presentedWorkspaces.length === 0) {
      draft.presentedWorkspaces = this._buildWorkspaceOptions(hostObj)
    }

    const matchedHarness = matchHarnessInText(utter)
    if (matchedHarness) {
      draft.harness = matchedHarness
      draft.harnessAutoDefault = false
      changed = true
    }

    const newWsReq = extractNewWorkspaceRequest(utter)
    if (newWsReq) {
      draft.workspaceMode = 'new'
      draft.createDir = true
      if (newWsReq.newWorkspaceName) {
        draft.newWorkspaceName = newWsReq.newWorkspaceName
        draft.workspaceLabel = newWsReq.newWorkspaceName
        draft.cwd = resolveNewWorkspacePath(hostWorkspaces, newWsReq.newWorkspaceName)
      }
      changed = true
    } else if (allowBareWorkspaceName && draft.workspaceMode === 'new' && !draft.newWorkspaceName) {
      const bareName = sanitizeWorkspaceFolderName(utter)
      if (bareName) {
        draft.newWorkspaceName = bareName
        draft.workspaceLabel = bareName
        draft.cwd = resolveNewWorkspacePath(hostWorkspaces, bareName)
        changed = true
      }
    } else {
      const existingWs = matchExistingWorkspaceInText(utter, hostWorkspaces, draft.presentedWorkspaces)
      if (existingWs) {
        draft.workspaceMode = 'existing'
        draft.createDir = false
        draft.newWorkspaceName = ''
        draft.cwd = existingWs.cwd
        draft.workspaceLabel = existingWs.label
        changed = true
      }
    }

    if (allowBarePrompt && !draft.prompt) {
      const cleanP = String(utter || '').trim().replace(/[。！!]+$/g, '')
      if (cleanP.length >= 2) {
        draft.prompt = cleanP
        changed = true
      }
    }

    if (draft.hostId && !draft.harness) {
      draft.harness = pickDefaultHarnessForHost(draft.hostId, ctx?.tasks)
      draft.harnessAutoDefault = true
    }

    draft.updatedAt = this.now()
    return changed
  }

  _promptForNextMissing(draft, ctx) {
    const hosts = this._buildHostList(ctx)
    const missing = this._computeMissingFields(draft)
    if (missing.length === 0) {
      draft.status = 'awaiting_confirm'
      draft.reaskCount = 0
      return {
        spokenReply: this._buildReadback(draft, false),
        expectReply: true,
        draftCard: this.toPublicCard(draft),
      }
    }

    draft.status = 'collecting'
    const firstMissing = missing[0]

    if (firstMissing === 'host') {
      draft.presentedHosts = hosts.slice(0, 4).map((h, i) => ({
        slot: i + 1,
        hostId: h.hostId,
        hostName: h.hostName || h.hostId,
      }))
      const hostChoices = draft.presentedHosts.map(h => `${h.slot}号 ${h.hostName}`).join('、')
      return {
        spokenReply: `好的，新建任务需要确认一下：要发到哪台电脑？现在在线的有 ${hostChoices}。你也可以顺便说用已有项目还是新建工作区。`,
        expectReply: true,
        draftCard: this.toPublicCard(draft),
      }
    }

    if (firstMissing === 'workspace') {
      const hostObj = hosts.find(h => h.hostId === draft.hostId)
      draft.presentedWorkspaces = this._buildWorkspaceOptions(hostObj)
      const wsList = draft.presentedWorkspaces.slice(0, 3).map(w => `${w.slot}号 ${w.label}`).join('、')
      const wsHint = wsList
        ? `常用项目有 ${wsList}；如果要建新目录，直接说「新建工作区叫某某」。`
        : '要新建一个工作区的话，直接告诉我新目录叫什么名字就行。'
      return {
        spokenReply: `在 ${draft.hostName} 上，是用已有项目还是新建工作区？${wsHint}`,
        expectReply: true,
        draftCard: this.toPublicCard(draft),
      }
    }

    if (firstMissing === 'new_workspace_name') {
      return {
        spokenReply: `好的，准备在 ${draft.hostName} 上新建工作区，新目录叫什么名字？`,
        expectReply: true,
        draftCard: this.toPublicCard(draft),
      }
    }

    return {
      spokenReply: '好的，这个新任务具体想让 AI 帮你做什么？',
      expectReply: true,
      draftCard: this.toPublicCard(draft),
    }
  }

  /**
   * Start or stage a new task draft (from deterministic trigger OR LLM `create_task` action).
   */
  startDraft(voiceSessionId, { userText = '', seedAction = null, ctx }) {
    const sid = String(voiceSessionId || 'default')
    const hosts = this._buildHostList(ctx)
    const draft = {
      id: `draft_${randomBytes(4).toString('hex')}`,
      status: 'collecting',
      hostId: '',
      hostName: '',
      workspaceMode: '',
      cwd: '',
      workspaceLabel: '',
      newWorkspaceName: '',
      createDir: false,
      harness: '',
      harnessAutoDefault: true,
      prompt: '',
      presentedHosts: [],
      presentedWorkspaces: [],
      askCount: 0,
      reaskCount: 0,
      updatedAt: this.now(),
    }

    // Seed from LLM structured action if present, then enrich from raw user utterance
    if (seedAction && typeof seedAction === 'object') {
      if (seedAction.hostId) {
        const h = hosts.find(x => x.hostId === seedAction.hostId)
        if (h) {
          draft.hostId = h.hostId
          draft.hostName = h.hostName || h.hostId
          draft.presentedWorkspaces = this._buildWorkspaceOptions(h)
        }
      }
      if (seedAction.harness) {
        draft.harness = String(seedAction.harness)
        draft.harnessAutoDefault = false
      }
      if (seedAction.prompt) {
        draft.prompt = String(seedAction.prompt).trim()
      }
      if (seedAction.createDir && seedAction.cwd) {
        const folder = sanitizeWorkspaceFolderName(basename(String(seedAction.cwd)))
        if (folder) {
          draft.workspaceMode = 'new'
          draft.createDir = true
          draft.newWorkspaceName = folder
          draft.workspaceLabel = folder
          draft.cwd = String(seedAction.cwd)
        }
      } else if (seedAction.cwd) {
        const hostObj = hosts.find(x => x.hostId === draft.hostId)
        const existingMatch = (hostObj?.workspaces || []).find(w => w === seedAction.cwd)
        if (existingMatch) {
          draft.workspaceMode = 'existing'
          draft.cwd = existingMatch
          draft.workspaceLabel = basename(existingMatch) || existingMatch
        }
      }
    }

    if (!draft.prompt) {
      draft.prompt = extractInitialTaskPrompt(userText)
    }

    this._applyExtractedSlots(draft, userText, ctx)
    this.drafts.set(sid, draft)
    return this._promptForNextMissing(draft, ctx)
  }

  /**
   * Handle a follow-up voice turn while a new-task draft is active.
   * Returns `{ handled: true, commit?: boolean, payload?, spokenReply, expectReply, draftCard }`
   * or `{ handled: false, preface }` if the user switched to an unrelated topic.
   */
  handleTurn(voiceSessionId, utter, ctx) {
    const sid = String(voiceSessionId || 'default')
    const draft = this.getActive(sid)
    if (!draft) return { handled: false }

    const text = String(utter || '').trim()
    const replyKind = classifyVoiceReply(text)

    // 1. Awaiting final confirmation (0ms deterministic commit / correction / cancel)
    if (draft.status === 'awaiting_confirm') {
      // Check if user wants to change host / workspace / harness before confirming
      const hasModificationCue = /(?:不对|不是|换|改|新工作区|新目录|目录叫|用\s*(?:codex|claude|dsh|antigravity|workbuddy))/i.test(text)
      if (hasModificationCue) {
        const changed = this._applyExtractedSlots(draft, text, ctx)
        if (changed) {
          const nextStep = this._promptForNextMissing(draft, ctx)
          return {
            handled: true,
            tag: 'draft_corrected',
            spokenReply: draft.status === 'awaiting_confirm'
              ? `已帮你改好。${this._buildReadback(draft, true)}`
              : nextStep.spokenReply,
            expectReply: true,
            draftCard: this.toPublicCard(draft),
          }
        }
      }

      if (replyKind === 'yes') {
        const payload = {
          type: 'new_session',
          prompt: draft.prompt,
          cwd: draft.cwd,
          createDir: Boolean(draft.createDir),
          harness: draft.harness || 'antigravity-ide',
        }
        const hostId = draft.hostId
        const hostName = draft.hostName
        const wsDesc = draft.createDir
          ? `新建「${draft.newWorkspaceName}」目录并`
          : `的「${draft.workspaceLabel}」项目里`
        this.clear(sid)
        return {
          handled: true,
          commit: true,
          tag: 'draft_confirmed',
          hostId,
          payload,
          spokenReply: `已创建！正在 ${hostName} ${wsDesc}启动任务，有审批或跑完我马上叫你。`,
          expectReply: false,
          draftCard: null,
        }
      }

      if (replyKind === 'no') {
        this.clear(sid)
        return {
          handled: true,
          tag: 'draft_cancelled',
          spokenReply: '好的，已取消新建任务，需要时再告诉我。',
          expectReply: false,
          draftCard: null,
        }
      }

      if (replyKind === 'ambiguous') {
        if (/再说一遍|重复|再念|再读|没听清|听不清/.test(text)) {
          return {
            handled: true,
            tag: 'draft_repeat',
            spokenReply: this._buildReadback(draft, true),
            expectReply: true,
            draftCard: this.toPublicCard(draft),
          }
        }
        if (draft.reaskCount >= 1) {
          this.clear(sid)
          return {
            handled: true,
            tag: 'draft_reask_limit',
            spokenReply: '好的，那我先不建了，想建的时候再告诉我。',
            expectReply: false,
            draftCard: null,
          }
        }
        draft.reaskCount += 1
        draft.updatedAt = this.now()
        return {
          handled: true,
          tag: 'draft_reask',
          spokenReply: this._buildReadback(draft, true),
          expectReply: true,
          draftCard: this.toPublicCard(draft),
        }
      }

      // Unrelated topic while awaiting confirmation -> safely discard draft & inform user (Mini Health pattern!)
      this.clear(sid)
      return {
        handled: false,
        preface: '刚才那条新建任务你还没确认，我先不建了。',
      }
    }

    // 2. Collecting missing slots
    if (replyKind === 'no' && !/(?:换|改|新建)/.test(text)) {
      this.clear(sid)
      return {
        handled: true,
        tag: 'draft_cancelled',
        spokenReply: '好的，已取消新建任务。',
        expectReply: false,
        draftCard: null,
      }
    }

    const missingBefore = this._computeMissingFields(draft)
    const expectingNewName = missingBefore[0] === 'new_workspace_name'
    const expectingPrompt = missingBefore[0] === 'prompt'
    const changed = this._applyExtractedSlots(draft, text, ctx, {
      allowBareWorkspaceName: expectingNewName,
      allowBarePrompt: expectingPrompt,
    })

    if (!changed) {
      draft.askCount += 1
      if (draft.askCount >= 2) {
        this.clear(sid)
        return {
          handled: false,
          preface: '刚才那条新建任务还没凑齐信息，我先取消了。',
        }
      }
    }

    const nextStep = this._promptForNextMissing(draft, ctx)
    return {
      handled: true,
      tag: draft.status === 'awaiting_confirm' ? 'draft_ready_confirm' : 'draft_collecting',
      spokenReply: nextStep.spokenReply,
      expectReply: true,
      draftCard: nextStep.draftCard,
    }
  }

  /**
   * Direct button confirmation / cancellation from the on-screen Draft Confirmation Card.
   */
  resolveCardAction(voiceSessionId, action = 'confirm') {
    const sid = String(voiceSessionId || 'default')
    const draft = this.getActive(sid)
    if (!draft) {
      return { ok: false, error: '当前没有待确认的新建任务草稿' }
    }
    if (action === 'cancel') {
      this.clear(sid)
      return {
        ok: true,
        cancelled: true,
        spokenReply: '好的，已取消新建任务。',
        draftCard: null,
      }
    }
    const missing = this._computeMissingFields(draft)
    if (missing.length > 0) {
      return { ok: false, error: '草稿信息尚未补全，请先确认电脑、工作区和任务内容', draftCard: this.toPublicCard(draft) }
    }
    const payload = {
      type: 'new_session',
      prompt: draft.prompt,
      cwd: draft.cwd,
      createDir: Boolean(draft.createDir),
      harness: draft.harness || 'antigravity-ide',
    }
    const hostId = draft.hostId
    const hostName = draft.hostName
    const wsDesc = draft.createDir
      ? `新建「${draft.newWorkspaceName}」目录并`
      : `的「${draft.workspaceLabel}」项目里`
    this.clear(sid)
    return {
      ok: true,
      commit: true,
      hostId,
      payload,
      spokenReply: `已创建！正在 ${hostName} ${wsDesc}启动任务，有审批或跑完我马上叫你。`,
      draftCard: null,
    }
  }
}
