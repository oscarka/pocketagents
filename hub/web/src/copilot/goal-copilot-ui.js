/**
 * 独立可插拔的通用「对话下方插件展示栏」前端控制器（与 controller.js 主逻辑完全隔离）
 *
 * 设计原则：
 * 1. 关闭时：对话界面 0 额外元素、0 网络请求、0 视觉打扰。
 * 2. 开启后：仅在 AI 回复正下方提供一个通用展示栏，内容与快捷选项按钮（填入输入框 / 复制 / 发送 / 回调）
 *    100% 由外部插件服务返回的数据驱动，主项目不耦合任何具体业务策略。
 */

export function createGoalCopilotUi(deps) {
  let pluginConfig = {
    enabled: false,
    pluginUrl: '',
    hasAuthToken: false,
    authTokenPreview: '',
    brainTarget: 'none',
    connected: false,
    detail: null,
    error: '',
    loaded: false,
  }
  let panelByKey = {}
  let streamingByKey = {}
  let thinkingCollapsedByKey = {}
  let inlineInputByKey = {} // { [key]: { optIndex, placeholder, label } }
  let activeAbortByKey = {}
  let lastSessionStatusByKey = {}
  let pendingSyncTimers = {}

  function makeKey(hostId, agentId) {
    return `${String(hostId || 'local')}::${String(agentId || '')}`
  }

  function getAuthHeaders(extra = {}) {
    const token = deps.getToken?.() || ''
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    }
  }

  function esc(s) {
    return typeof deps.esc === 'function' ? deps.esc(s) : String(s ?? '')
  }

  async function refreshConfig({ probeHealth = true } = {}) {
    try {
      const cfgRes = await fetch('/api/copilot/config', { headers: getAuthHeaders() })
      if (!cfgRes.ok) {
        pluginConfig = { ...pluginConfig, loaded: true }
        renderForActiveSession()
        return pluginConfig
      }
      const cfgData = await cfgRes.json().catch(() => ({}))
      const base = cfgData.config || { enabled: false, pluginUrl: '', brainTarget: 'none' }
      let connected = false
      let detail = null
      let error = ''
      if (probeHealth && base.pluginUrl) {
        const hRes = await fetch('/api/copilot/health', { headers: getAuthHeaders() }).catch(() => null)
        const hData = hRes ? await hRes.json().catch(() => ({})) : {}
        connected = Boolean(hData.connected)
        detail = hData.detail || null
        error = hData.error || ''
      }
      pluginConfig = {
        enabled: Boolean(base.enabled),
        pluginUrl: base.pluginUrl || '',
        hasAuthToken: Boolean(base.hasAuthToken),
        authTokenPreview: base.authTokenPreview || '',
        brainTarget: base.brainTarget || 'none',
        connected,
        detail,
        error,
        loaded: true,
      }
      renderForActiveSession()
      deps.onPluginConfigChanged?.(pluginConfig)
      if (pluginConfig.enabled) {
        const active = deps.getActiveSession?.()
        if (active) void syncSessionPanel(active)
      }
      return pluginConfig
    } catch {
      pluginConfig = { ...pluginConfig, loaded: true }
      return pluginConfig
    }
  }

  function getPluginSummaryText() {
    if (!pluginConfig.enabled || !pluginConfig.pluginUrl) return '未启用'
    if (pluginConfig.connected) {
      return pluginConfig.detail?.name ? `已连接 · ${pluginConfig.detail.name}` : '已连接'
    }
    return '未连接'
  }

  function getPluginConfig() {
    return pluginConfig
  }

  async function savePluginConfig({ enabled, pluginUrl, authToken, brainTarget }) {
    const body = { enabled, pluginUrl, brainTarget }
    if (authToken !== undefined) body.authToken = authToken
    const res = await fetch('/api/copilot/config', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      deps.showToast?.(`⚠️ ${data.error || '保存失败'}`)
      return { ok: false, error: data.error || '保存失败' }
    }
    await refreshConfig({ probeHealth: true })
    deps.showToast?.(
      pluginConfig.enabled
        ? pluginConfig.connected
          ? `✅ 插件已连接（${pluginConfig.detail?.name || '外部服务'}）`
          : '⚠️ 已保存，但外部插件服务暂不可达'
        : '已关闭外部插件',
    )
    return { ok: true, config: pluginConfig }
  }

  async function testPluginUrl(candidateUrl) {
    const q = new URLSearchParams({ url: String(candidateUrl || '').trim() })
    const res = await fetch(`/api/copilot/health?${q.toString()}`, { headers: getAuthHeaders() })
    const data = await res.json().catch(() => ({}))
    if (data.connected) {
      const name = data.detail?.name || '外部插件'
      const ver = data.detail?.version ? ` v${data.detail.version}` : ''
      const status = data.detail?.statusText ? ` · ${data.detail.statusText}` : ''
      deps.showToast?.(`✅ 已连通：${name}${ver}${status}`)
    } else {
      deps.showToast?.(`⚠️ ${data.error || '无法连接外部插件服务'}`)
    }
    return data
  }

  async function syncSessionPanel(session) {
    if (!session || !pluginConfig.enabled) return
    const key = makeKey(session.hostId, session.id)
    try {
      const q = new URLSearchParams({ hostId: session.hostId || 'local', agentId: session.id })
      const res = await fetch(`/api/copilot/panel?${q.toString()}`, { headers: getAuthHeaders() })
      const data = await res.json().catch(() => ({}))
      if (data.ok && data.panel && !streamingByKey[key]?.active) {
        panelByKey[key] = data.panel
      }
    } catch { }
    renderForActiveSession()
  }

  function handleSessionUpdate(session) {
    if (!session || !pluginConfig.enabled) return
    const key = makeKey(session.hostId, session.id)
    const prevStatus = lastSessionStatusByKey[key] || ''
    const nextStatus = String(session.status || '')
    lastSessionStatusByKey[key] = nextStatus
    if (
      prevStatus === 'running' &&
      (nextStatus === 'completed' || nextStatus === 'approval') &&
      !streamingByKey[key]?.active
    ) {
      if (pendingSyncTimers[key]) clearTimeout(pendingSyncTimers[key])
      // Give Hub background handleTaskCompleted a moment to cache the plugin panel, then pull it
      pendingSyncTimers[key] = setTimeout(() => {
        void syncSessionPanel(session)
      }, 1500)
    }
  }

  async function requestPanel(session, eventName = 'manual_trigger') {
    if (!session) return
    const key = makeKey(session.hostId, session.id)
    if (activeAbortByKey[key]) {
      try { activeAbortByKey[key].abort() } catch { }
    }
    const ac = new AbortController()
    activeAbortByKey[key] = ac
    inlineInputByKey[key] = null

    streamingByKey[key] = {
      active: true,
      statusText: '插件处理中…',
      thinking: '',
      error: '',
      startedAt: Date.now(),
    }
    thinkingCollapsedByKey[key] = false
    renderForActiveSession()

    try {
      const resp = await fetch('/api/copilot/panel/stream', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          hostId: session.hostId || 'local',
          agentId: session.id,
          event: eventName,
        }),
        signal: ac.signal,
      })

      const ct = String(resp.headers.get('content-type') || '').toLowerCase()
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        streamingByKey[key] = {
          ...streamingByKey[key],
          active: false,
          error: errData.error || `插件请求失败 (HTTP ${resp.status})`,
        }
        renderForActiveSession()
        return
      }

      if (ct.includes('application/json') || !resp.body) {
        const data = await resp.json().catch(() => ({}))
        streamingByKey[key] = { ...streamingByKey[key], active: false, error: data.ok === false ? (data.error || '插件返回异常') : '' }
        if (data.panel) {
          panelByKey[key] = data.panel
          thinkingCollapsedByKey[key] = Boolean(data.panel.thinkingCollapsed)
        }
        renderForActiveSession()
        return
      }

      // SSE stream consumer: supports `status`, `thinking` (or `delta`), `result`, `error`
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let curEvent = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const rawLine of lines) {
          const line = rawLine.trimEnd()
          if (line.startsWith('event:')) {
            curEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const payloadStr = line.slice(5).trim()
            if (!payloadStr) continue
            try {
              const obj = JSON.parse(payloadStr)
              if (curEvent === 'status' && obj.text) {
                streamingByKey[key] = { ...streamingByKey[key], statusText: String(obj.text) }
              } else if (curEvent === 'thinking' || curEvent === 'delta') {
                const delta = String(obj.delta ?? obj.text ?? '')
                streamingByKey[key] = {
                  ...streamingByKey[key],
                  thinking: (streamingByKey[key]?.thinking || '') + delta,
                }
              } else if (curEvent === 'result') {
                const nextPanel = obj.panel || obj
                panelByKey[key] = nextPanel
                if (typeof nextPanel?.thinkingCollapsed === 'boolean') {
                  thinkingCollapsedByKey[key] = nextPanel.thinkingCollapsed
                }
                streamingByKey[key] = { ...streamingByKey[key], active: false, error: '' }
              } else if (curEvent === 'error') {
                streamingByKey[key] = {
                  ...streamingByKey[key],
                  active: false,
                  error: String(obj.error || '插件执行失败'),
                }
              }
              renderForActiveSession()
            } catch { }
          } else if (line === '') {
            curEvent = ''
          }
        }
      }
      if (streamingByKey[key]?.active) {
        streamingByKey[key] = { ...streamingByKey[key], active: false }
        renderForActiveSession()
      }
    } catch (err) {
      if (err?.name === 'AbortError') return
      streamingByKey[key] = {
        ...streamingByKey[key],
        active: false,
        error: err?.message || '连接插件失败',
      }
      renderForActiveSession()
    }
  }

  function getComposerInputEl() {
    return document.getElementById('globalPromptInput') || document.getElementById('chatInput')
  }

  function fillComposerInput(text) {
    const clean = String(text || '').trim()
    if (!clean) return
    const input = getComposerInputEl()
    if (!input) return
    input.value = clean
    try { input.dispatchEvent(new Event('input', { bubbles: true })) } catch { }
    deps.autoGrowComposer?.({ target: input })
    input.focus()
    deps.showToast?.('已填入输入框，可修改后发送')
  }

  async function executeCallbackOption(session, opt, inputText = '') {
    const key = makeKey(session.hostId, session.id)
    inlineInputByKey[key] = null
    renderForActiveSession()
    try {
      const res = await fetch('/api/copilot/action', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          hostId: session.hostId || 'local',
          agentId: session.id,
          actionId: opt.actionId || opt.id,
          payload: opt.payload,
          inputText,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        deps.showToast?.(`⚠️ ${data.error || '插件动作执行失败'}`)
        return
      }
      if ('panel' in data) {
        panelByKey[key] = data.panel || null
      }
      if (data.fillText) {
        fillComposerInput(data.fillText)
      }
      if (data.toast) {
        deps.showToast?.(data.toast)
      }
      renderForActiveSession()
    } catch (err) {
      deps.showToast?.(`⚠️ ${err?.message || '请求插件失败'}`)
    }
  }

  async function handleOptionClick(optIndex) {
    const session = deps.getActiveSession?.()
    if (!session) return
    const key = makeKey(session.hostId, session.id)
    const panel = panelByKey[key]
    const opt = Array.isArray(panel?.options) ? panel.options[optIndex] : null
    if (!opt) return

    if (opt.kind === 'fill') {
      fillComposerInput(opt.text)
      return
    }
    if (opt.kind === 'copy') {
      if (typeof deps.copyText === 'function') {
        deps.copyText(opt.text, null, '已复制选项内容')
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(opt.text).catch(() => { })
        deps.showToast?.('已复制选项内容')
      }
      return
    }
    if (opt.kind === 'send') {
      const input = getComposerInputEl()
      if (!input || !opt.text) return
      input.value = opt.text
      try { input.dispatchEvent(new Event('input', { bubbles: true })) } catch { }
      deps.autoGrowComposer?.({ target: input })
      await deps.sendPromptToActiveSession?.()
      return
    }
    if (opt.kind === 'callback') {
      if (opt.inputPlaceholder) {
        inlineInputByKey[key] = {
          optIndex,
          placeholder: opt.inputPlaceholder,
          label: opt.label,
        }
        renderForActiveSession()
        setTimeout(() => document.getElementById('copilotInlineActionInput')?.focus(), 40)
        return
      }
      await executeCallbackOption(session, opt, '')
    }
  }

  function renderForActiveSession() {
    const toggleBtn = document.getElementById('chatCopilotBtn')
    const cardEl = document.getElementById('copilotReviewCard')
    if (!toggleBtn && !cardEl) return

    const session = deps.getActiveSession?.()
    if (!pluginConfig.enabled || !session) {
      if (toggleBtn) toggleBtn.style.display = 'none'
      if (cardEl) {
        cardEl.style.display = 'none'
        cardEl.innerHTML = ''
      }
      return
    }

    const key = makeKey(session.hostId, session.id)
    const panel = panelByKey[key] || null
    const st = streamingByKey[key] || null
    const inlineInput = inlineInputByKey[key] || null

    if (toggleBtn) {
      toggleBtn.style.display = 'inline-flex'
      toggleBtn.textContent = pluginConfig.detail?.shortLabel || '🎯 副驾'
      toggleBtn.classList.toggle('is-active', Boolean(panel || st?.active))
    }

    if (!cardEl) return
    const shouldShow = Boolean(st?.active || st?.error || panel)
    if (!shouldShow) {
      cardEl.style.display = 'none'
      cardEl.innerHTML = ''
      return
    }

    const thinkingText = st?.active ? (st.thinking || '') : (panel?.thinking || st?.thinking || '')
    const collapsed = Boolean(thinkingCollapsedByKey[key])
    const toneClass = panel?.tone || (st?.error ? 'danger' : st?.active ? 'info' : 'neutral')
    const titleText = panel?.title || pluginConfig.detail?.name || '🎯 外部插件'
    const badgeText = st?.active ? (st.statusText || '处理中…') : (panel?.badge || '')
    const options = Array.isArray(panel?.options) ? panel.options : []
    const tags = Array.isArray(panel?.tags) ? panel.tags : []

    cardEl.style.display = 'block'
    cardEl.innerHTML = `
      <div class="copilot-card-inner tone-${esc(toneClass)}">
        <div class="copilot-card-head">
          <div class="copilot-card-head-left">
            <span class="copilot-mode-tag">${esc(titleText)}</span>
            ${badgeText ? `<span class="copilot-status-badge tone-${esc(toneClass)}">${esc(badgeText)}</span>` : ''}
            ${panel?.subtitle ? `<span class="copilot-latency">${esc(panel.subtitle)}</span>` : ''}
          </div>
          <div class="copilot-card-head-right">
            ${thinkingText ? `<button type="button" class="copilot-link-btn" onclick="copilotToggleThinking()">${collapsed ? '展开详情 ⌄' : '收起详情 ⌃'}</button>` : ''}
            <button type="button" class="copilot-btn ghost" title="重新请求插件" onclick="copilotRefreshPanel()">↻</button>
            <button type="button" class="copilot-btn ghost" title="收起" onclick="copilotDismissCard()">✕</button>
          </div>
        </div>
        ${st?.error ? `<div class="copilot-error-box">${esc(st.error)}</div>` : ''}
        ${thinkingText && !collapsed ? `
          <div class="copilot-thinking-box">
            <pre class="copilot-thinking-pre">${esc(thinkingText)}${st?.active ? ' ▌' : ''}</pre>
          </div>
        ` : ''}
        ${panel?.body ? `<div class="copilot-brief-line">${esc(panel.body)}</div>` : ''}
        ${tags.length > 0 ? `
          <div class="copilot-rules-row">
            ${tags.map(t => `<span class="copilot-rule-pill">${esc(t)}</span>`).join('')}
          </div>
        ` : ''}
        ${!st?.active && options.length > 0 ? `
          <div class="copilot-card-actions">
            ${options.map((opt, idx) => `
              <button
                type="button"
                class="copilot-btn ${esc(opt.style || 'default')}"
                onclick="copilotTriggerOption(${idx})"
                title="${esc(opt.kind === 'fill' ? '一键填入输入框' : opt.kind === 'copy' ? '复制到剪贴板' : opt.label)}"
              >${esc(opt.label)}</button>
            `).join('')}
          </div>
        ` : ''}
        ${inlineInput ? `
          <div class="copilot-feedback-box">
            <input
              id="copilotInlineActionInput"
              type="text"
              class="copilot-goal-input"
              placeholder="${esc(inlineInput.placeholder)}"
              onkeydown="if(event.key==='Enter'){event.preventDefault();copilotSubmitInlineAction();}"
            />
            <div class="copilot-card-actions">
              <button type="button" class="copilot-btn primary" onclick="copilotSubmitInlineAction()">发送给插件</button>
              <button type="button" class="copilot-btn ghost" onclick="copilotCancelInlineAction()">取消</button>
            </div>
          </div>
        ` : ''}
      </div>
    `
  }

  function renderSettingsSubpageHtml() {
    const enabled = pluginConfig.enabled
    const url = esc(pluginConfig.pluginUrl || 'http://127.0.0.1:8789')
    const connected = pluginConfig.connected
    const detail = pluginConfig.detail
    const brainCreds = (
      typeof window !== 'undefined' && Array.isArray(window.__dshVoiceConfig?.credentials)
        ? window.__dshVoiceConfig.credentials
        : []
    ).filter(c => c && (c.provider === 'gemini' || c.provider === 'openai_compat') && c.enabled !== false)
    const curBrain = pluginConfig.brainTarget || 'none'

    return `
      <div class="ios-card">
        <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div class="settings-item-title">启用外部辅助插件</div>
              <div class="settings-item-desc">关闭时对话界面零痕迹；开启后在 AI 回复下方显示插件返回的展示栏与快捷选项</div>
            </div>
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0;margin-left:10px;">
              <input type="checkbox" id="copilotEnableCheckbox" ${enabled ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0;" />
              <span>${enabled ? '已开启' : '已关闭'}</span>
            </label>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <label style="font-size:12px;color:var(--muted);">插件服务地址（需你的 Hub 服务端可直接访问，如本机 127.0.0.1:8789 或 HTTPS 域名）</label>
            <input id="copilotPluginUrlInput" type="text" class="copilot-goal-input" value="${url}" placeholder="http://127.0.0.1:8789" />
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <label style="font-size:12px;color:var(--muted);">访问密钥（可选 · ${pluginConfig.hasAuthToken ? `已保存 ${esc(pluginConfig.authTokenPreview)}，留空保持不变` : '远程 HTTPS 服务建议填写 Bearer Token'}）</label>
            <input id="copilotPluginTokenInput" type="password" class="copilot-goal-input" value="" placeholder="${pluginConfig.hasAuthToken ? '留空保持已保存密钥' : '可选，未设置认证可留空'}" />
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <label style="font-size:12px;color:var(--muted);">可选：复用全局模型池（仅 127.0.0.1 本机回环时透传，与「边走边听」互不影响）</label>
            <select id="copilotBrainTargetSelect" class="copilot-goal-input">
              <option value="none"${curBrain === 'none' ? ' selected' : ''}>由插件自行管理（不透传密钥）</option>
              ${brainCreds.map(c => `<option value="cred:${esc(c.id)}"${curBrain === `cred:${c.id}` ? ' selected' : ''}>${esc(c.label)}${c.defaultModel ? ` (${esc(c.defaultModel)})` : ''}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="pill-action-btn primary" onclick="copilotSaveSettingsFromSubpage()">保存并连接</button>
            <button type="button" class="pill-action-btn" onclick="copilotTestSettingsFromSubpage()">测试连通性</button>
          </div>
        </div>
        <div class="settings-item">
          <div>
            <div class="settings-item-title">当前插件状态</div>
            <div class="settings-item-desc">
              ${connected
                ? `🟢 已连接 · ${esc(detail?.name || '外部插件')}${detail?.version ? ` v${esc(detail.version)}` : ''}${detail?.statusText ? ` · ${esc(detail.statusText)}` : ''}`
                : `⚪ ${esc(pluginConfig.error || '未连接（按协议启动你的独立插件服务后点「保存并连接」）')}`}
            </div>
          </div>
        </div>
      </div>
    `
  }

  if (typeof window !== 'undefined') {
    window.copilotOpenOrReview = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      void requestPanel(s, 'manual_trigger')
    }
    window.copilotRefreshPanel = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      void requestPanel(s, 'manual_trigger')
    }
    window.copilotToggleThinking = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      const key = makeKey(s.hostId, s.id)
      thinkingCollapsedByKey[key] = !thinkingCollapsedByKey[key]
      renderForActiveSession()
    }
    window.copilotDismissCard = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      const key = makeKey(s.hostId, s.id)
      panelByKey[key] = null
      streamingByKey[key] = null
      inlineInputByKey[key] = null
      renderForActiveSession()
    }
    window.copilotTriggerOption = idx => {
      void handleOptionClick(Number(idx))
    }
    window.copilotSubmitInlineAction = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      const key = makeKey(s.hostId, s.id)
      const pending = inlineInputByKey[key]
      const panel = panelByKey[key]
      const opt = pending && Array.isArray(panel?.options) ? panel.options[pending.optIndex] : null
      if (!opt) return
      const inputVal = document.getElementById('copilotInlineActionInput')?.value || ''
      void executeCallbackOption(s, opt, inputVal)
    }
    window.copilotCancelInlineAction = () => {
      const s = deps.getActiveSession?.()
      if (!s) return
      inlineInputByKey[makeKey(s.hostId, s.id)] = null
      renderForActiveSession()
    }
    window.copilotSaveSettingsFromSubpage = () => {
      const enabled = Boolean(document.getElementById('copilotEnableCheckbox')?.checked)
      const pluginUrl = document.getElementById('copilotPluginUrlInput')?.value || ''
      const rawToken = document.getElementById('copilotPluginTokenInput')?.value || ''
      const brainTarget = document.getElementById('copilotBrainTargetSelect')?.value || 'none'
      void savePluginConfig({
        enabled,
        pluginUrl,
        ...(rawToken.trim() ? { authToken: rawToken.trim() } : {}),
        brainTarget,
      }).then(() => {
        deps.rerenderSettings?.()
      })
    }
    window.copilotTestSettingsFromSubpage = () => {
      const pluginUrl = document.getElementById('copilotPluginUrlInput')?.value || ''
      void testPluginUrl(pluginUrl)
    }
  }

  return {
    refreshConfig,
    getPluginConfig,
    getPluginSummaryText,
    syncSessionPanel,
    syncSessionGoal: syncSessionPanel,
    handleSessionUpdate,
    renderForActiveSession,
    renderSettingsSubpageHtml,
  }
}
