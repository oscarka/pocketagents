// Standalone modular Settings Tab controller extracted from controller.js.
// Implements an iOS-Settings-style 4-group home screen with 7 clean drill-down sub-pages,
// keeping 100% of existing capabilities while isolating Settings UI from frozen core modules.

import { formatVoiceSummaryForSettings } from '../voice/provider-routing.js';

export const SETTINGS_SUBPAGE_TITLES = {
  host_detail: '电脑详情与控制',
  add_host: '添加电脑与手机扫码',
  push: '手机锁屏通知',
  security: '设备审批与安全防护',
  password: '密码与配对登录',
  shares: '加密分享记录',
  capabilities: '各 AI 工具能力说明',
};

export function computePushBadgeMeta(statusText = '') {
  const s = String(statusText || '');
  if (!s || s.includes('正在检测')) {
    return { text: '检测中…', tone: 'muted' };
  }
  if (s.includes('已开启')) {
    return { text: '✅ 已开启', tone: 'green' };
  }
  if (s.includes('被拒绝')) {
    return { text: '🚫 权限被拒', tone: 'red' };
  }
  if (s.includes('不支持')) {
    return { text: '需主屏幕', tone: 'amber' };
  }
  if (s.includes('未开启')) {
    return { text: '未开启', tone: 'amber' };
  }
  if (s.includes('失败')) {
    return { text: '状态异常', tone: 'red' };
  }
  return { text: '查看状态', tone: 'muted' };
}

export function createSettingsPanel(deps) {
  let activeSubpage = 'home';
  let activeHostId = '';
  let lastRenderedKey = '';
  let savedHomeScrollTop = 0;

  function getVoiceConfig() {
    if (typeof deps.getVoiceConfig === 'function') {
      return deps.getVoiceConfig();
    }
    return typeof window !== 'undefined' ? window.__dshVoiceConfig || null : null;
  }

  function invalidate() {
    lastRenderedKey = '';
  }

  function getActiveSubpage() {
    return activeSubpage;
  }

  function openSubpage(page, param = '') {
    const validPages = new Set(Object.keys(SETTINGS_SUBPAGE_TITLES));
    if (!validPages.has(page)) {
      closeSubpage();
      return;
    }
    const viewport = deps.getViewport?.();
    if (activeSubpage === 'home' && viewport) {
      savedHomeScrollTop = viewport.scrollTop || 0;
    }
    activeSubpage = page;
    activeHostId = page === 'host_detail' ? String(param || '') : '';
    lastRenderedKey = '';
    if (viewport) {
      render(viewport, { scrollToTop: true });
    }
  }

  function closeSubpage() {
    if (activeSubpage === 'home') return;
    activeSubpage = 'home';
    activeHostId = '';
    lastRenderedKey = '';
    const viewport = deps.getViewport?.();
    if (viewport) {
      render(viewport, { restoreHomeScroll: true });
    }
  }

  function syncPushSummaryBadge(statusText = '') {
    if (typeof document === 'undefined') return;
    const badge = document.getElementById('settingsPushSummaryBadge');
    if (!badge) return;
    const meta = computePushBadgeMeta(statusText);
    badge.textContent = meta.text;
    badge.className = `settings-status-pill tone-${meta.tone}`;
  }

  function buildSignature(state, voiceSummary) {
    const {
      hubState,
      themePref,
      langPref,
      cachedPushStatusText,
      upgradingHostMap,
      tokenTail,
    } = state;
    const hosts = hubState.hosts || [];
    const shares = hubState.shares || [];
    const buildInfo = hubState.build || {};
    const secSum = hubState.securitySummary || { total24h: 0, high24h: 0, uniqueIps24h: 0, recentEvents: [] };
    const ac = hubState.accessControl || { deviceApprovalEnabled: false, trustedDevices: [], pendingDeviceLogins: [], pendingHosts: [] };

    return JSON.stringify({
      subpage: activeSubpage,
      activeHostId,
      themePref,
      langPref,
      voiceSummary,
      pushBadge: computePushBadgeMeta(cachedPushStatusText).text,
      tokenTail,
      enrollmentCode: hubState.enrollment?.code || '',
      joinedCount: hubState.enrollment?.joinedCount || 0,
      pushCount: (hubState.pushSubscriptions || []).length,
      secSig: `${secSum.total24h}:${secSum.high24h}:${(secSum.recentEvents || []).length}:${secSum.recentEvents?.[0]?.id || ''}`,
      acSig: `${ac.deviceApprovalEnabled ? 1 : 0}:${(ac.trustedDevices || []).length}:${(ac.pendingDeviceLogins || []).map(x => x.id).join(',')}:${(ac.pendingHosts || []).map(x => x.hostId).join(',')}`,
      build: buildInfo.uiBuild || buildInfo.version || '',
      hosts: hosts.map(h => ({
        id: h.hostId,
        name: h.hostName,
        online: deps.isHostLiveOnline(h),
        trustStatus: h.trustStatus || h.trust?.status || '',
        hasDedicatedToken: Boolean(h.hasDedicatedToken),
        isFeishuActive: h.isFeishuActive,
        remoteActive: h.remoteActive,
        taskCount: (h.bridgeState?.tasks || []).length,
        runningCount: h.runningCount || 0,
        totalBytesBucket: activeSubpage === 'host_detail' && activeHostId === h.hostId
          ? Math.round((h.totalBytes || 0) / 10240)
          : 0,
        agentVersion: h.bridgeState?.agentVersion || '',
        upgrading: Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000),
        turbo: h.bridgeState?.turbo?.engineLabel || '',
        power: h.bridgeState?.systemTelemetry?.power?.shortLabel || '',
        net: h.bridgeState?.systemTelemetry?.network?.kindLabel || '',
        shareUrl: h.lastShareResult?.shareUrl || '',
      })),
      shares: shares.map(s => ({ id: s.id || s.shareId, at: s.createdAt })),
    });
  }

  function renderSubpageHeaderHtml(title) {
    return `
      <div class="settings-sub-header">
        <button
          type="button"
          class="settings-sub-back"
          id="settingsSubBackBtn"
          onclick="closeSettingsSubpage()"
        >
          ‹ 设置
        </button>
        <div class="settings-sub-title">${deps.esc(title)}</div>
        <div class="settings-sub-spacer"></div>
      </div>
    `;
  }

  function renderHomeHtml(state, voiceSummary) {
    const {
      hubState,
      themePref,
      langPref,
      cachedPushStatusText,
      upgradingHostMap,
    } = state;
    const hosts = hubState.hosts || [];
    const shares = hubState.shares || [];
    const buildInfo = hubState.build || {};
    const hubVer = String(buildInfo.version || '0.9.20');
    const secSum = hubState.securitySummary || { total24h: 0, high24h: 0, uniqueIps24h: 0, recentEvents: [] };
    const ac = hubState.accessControl || { deviceApprovalEnabled: false, trustedDevices: [], pendingDeviceLogins: [], pendingHosts: [] };
    const pendingCount = (ac.pendingDeviceLogins || []).length + (ac.pendingHosts || []).length;
    const onlineCount = hosts.filter(h => deps.isHostLiveOnline(h) && (h.trustStatus || h.trust?.status) !== 'revoked').length;
    const enrollmentCode = hubState.enrollment?.code || '';
    const pushBadge = computePushBadgeMeta(cachedPushStatusText);

    const securityBadge = secSum.total24h > 0
      ? { text: `🚨 ${secSum.total24h} 次拦截`, tone: 'red' }
      : pendingCount > 0
        ? { text: `⏳ ${pendingCount} 待审批`, tone: 'amber' }
        : ac.deviceApprovalEnabled
          ? { text: '🛡️ 已保护', tone: 'green' }
          : { text: '未开启', tone: 'amber' };

    const hostRowsHtml = hosts.length > 0
      ? hosts.map(h => {
        const isRevoked = (h.trustStatus || h.trust?.status) === 'revoked';
        const isHostLive = deps.isHostLiveOnline(h);
        const tm = deps.formatHostTelemetry(h);
        const sessCount = (h.bridgeState?.tasks || []).length;
        const runCount = h.runningCount || 0;
        const hostVer = String(h.bridgeState?.agentVersion || '');
        const isUpgradingHost = Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000);
        const isHostOutdated = Boolean(isHostLive && !isRevoked && (!hostVer || deps.compareSemver(hostVer, hubVer) < 0));

        const subLine = isHostLive
          ? `${tm.powerIcon} ${deps.esc(tm.powerShort)} · ${tm.netIcon} ${deps.esc(tm.netShort)} · ${sessCount} 会话${runCount > 0 ? ` · <strong style="color:var(--green);">${runCount} 运行中</strong>` : ''}`
          : `⚪ 已离线 (${deps.formatTime(h.lastSeen)}) · ${sessCount} 会话`;

        return `
          <div
            class="settings-nav-row settings-host-row"
            data-settings-host="${deps.esc(h.hostId)}"
            onclick="openSettingsSubpage('host_detail', '${deps.escJsStr(h.hostId)}')"
          >
            <div class="settings-nav-main">
              <div class="settings-nav-title-line">
                <span class="status-dot ${isHostLive && !isRevoked ? '' : 'offline'}"></span>
                <span class="settings-nav-title">${deps.esc(h.hostName)}</span>
                ${h.isFeishuActive ? `<span class="settings-mini-tag tone-blue">主控</span>` : ''}
                ${isRevoked ? `<span class="settings-mini-tag tone-red">已吊销</span>` : ''}
                ${isUpgradingHost ? `<span class="settings-mini-tag tone-amber">升级中…</span>` : ''}
              </div>
              <div class="settings-nav-sub">${subLine}</div>
            </div>
            <div class="settings-nav-right">
              ${isHostOutdated && !isUpgradingHost ? `
                <button
                  type="button"
                  class="pill-action-btn primary"
                  style="padding:4px 9px;font-size:11.5px;"
                  onclick="event.stopPropagation(); upgradeHostTurbo('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')"
                >⬆️ 升级</button>
              ` : ''}
              <span class="settings-chevron">›</span>
            </div>
          </div>
        `;
      }).join('')
      : `
        <div class="settings-nav-row" onclick="openSettingsSubpage('add_host')">
          <div class="settings-nav-main">
            <div class="settings-nav-title">暂未接入在线电脑</div>
            <div class="settings-nav-sub">点下方「添加新电脑」复制一行命令即可秒连</div>
          </div>
          <span class="settings-chevron">›</span>
        </div>
      `;

    const buildCopyPayload = `DSH Hub v${hubVer} (${buildInfo.uiBuild || 'dev'}) · started ${buildInfo.startedAt ? new Date(buildInfo.startedAt).toISOString() : ''}`;

    return `
      <div class="settings-wrap settings-grouped-home">
        <!-- 分组 1：电脑与连接 -->
        <section class="settings-group" data-settings-group="hosts">
          <div class="settings-group-header">
            <div class="settings-group-title">电脑与连接</div>
            <div class="settings-group-meta">${hosts.length ? `${onlineCount}/${hosts.length} 台在线` : '未连接'}</div>
          </div>
          <div class="settings-card">
            ${hostRowsHtml}
            <div
              class="settings-nav-row settings-add-host-row"
              data-settings-row="add_host"
              onclick="openSettingsSubpage('add_host')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title" style="color:var(--primary);">➕ 添加新电脑 / 手机扫码登录</div>
                <div class="settings-nav-sub">复制一行安装命令或生成新设备配对码</div>
              </div>
              <div class="settings-nav-right">
                ${enrollmentCode ? `<span class="settings-code-chip">${deps.esc(enrollmentCode)}</span>` : ''}
                <span class="settings-chevron">›</span>
              </div>
            </div>
          </div>

          <div class="settings-card" style="margin-top:10px;">
            <div
              class="settings-nav-row"
              data-settings-row="migrate"
              onclick="openMigrateWizard()"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">📦 多电脑协同与一键迁移</div>
                <div class="settings-nav-sub">将源电脑会话打包同步至目标电脑</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-nav-meta">${hosts.length >= 2 ? `${hosts.length} 台可用` : '需 ≥2 台'}</span>
                <span class="settings-chevron">›</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 分组 2：模型与偏好 -->
        <section class="settings-group" data-settings-group="model-prefs">
          <div class="settings-group-header">
            <div class="settings-group-title">模型与偏好</div>
          </div>
          <div class="settings-card">
            <div
              class="settings-nav-row"
              data-settings-row="voice"
              onclick="openVoiceLab('list')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title-line">
                  <span class="settings-nav-title">🎧 边走边听 · 语音总管</span>
                  <span class="settings-mini-tag tone-blue">试用</span>
                </div>
                <div class="settings-nav-sub" id="settingsVoiceSummaryText">${deps.esc(voiceSummary)}</div>
              </div>
              <div class="settings-nav-right">
                <button
                  type="button"
                  class="pill-action-btn primary"
                  style="padding:5px 10px;font-size:12px;"
                  onclick="event.stopPropagation(); openWalkMode()"
                >🎧 进入</button>
                <span class="settings-chevron">›</span>
              </div>
            </div>

            <div
              class="settings-nav-row"
              data-settings-row="push"
              onclick="openSettingsSubpage('push')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">🔔 手机锁屏通知</div>
                <div class="settings-nav-sub">待审批、任务完成与安全告警实时弹窗</div>
              </div>
              <div class="settings-nav-right">
                <span id="settingsPushSummaryBadge" class="settings-status-pill tone-${pushBadge.tone}">${deps.esc(pushBadge.text)}</span>
                <span class="settings-chevron">›</span>
              </div>
            </div>

            <div class="settings-item" style="gap:8px;">
              <div style="min-width:0;flex:1;">
                <div class="settings-item-title" style="white-space:nowrap;">🌐 界面语言</div>
              </div>
              <div class="theme-seg-group">
                <button type="button" class="theme-seg-btn ${langPref === 'zh' ? 'active' : ''}" onclick="setLangPreference('zh')">🇨🇳 中文</button>
                <button type="button" class="theme-seg-btn ${langPref === 'en' ? 'active' : ''}" onclick="setLangPreference('en')">🇺🇸 EN</button>
              </div>
            </div>

            <div class="settings-item" style="gap:8px;">
              <div style="min-width:0;flex:1;">
                <div class="settings-item-title" style="white-space:nowrap;">🎨 外观主题</div>
              </div>
              <div class="theme-seg-group">
                <button type="button" class="theme-seg-btn ${themePref === 'system' ? 'active' : ''}" onclick="setThemePreference('system')">跟随</button>
                <button type="button" class="theme-seg-btn ${themePref === 'light' ? 'active' : ''}" onclick="setThemePreference('light')">☀️ 浅</button>
                <button type="button" class="theme-seg-btn ${themePref === 'dark' ? 'active' : ''}" onclick="setThemePreference('dark')">🌙 深</button>
              </div>
            </div>
          </div>
        </section>

        <!-- 分组 3：安全与隐私 -->
        <section class="settings-group" data-settings-group="security">
          <div class="settings-group-header">
            <div class="settings-group-title">安全与隐私</div>
          </div>
          <div class="settings-card">
            <div
              class="settings-nav-row"
              data-settings-row="security"
              onclick="openSettingsSubpage('security')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">🛡️ 设备审批与安全防护</div>
                <div class="settings-nav-sub">已信任 ${(ac.trustedDevices || []).length} 台设备 · 异常探测实时拦截</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-status-pill tone-${securityBadge.tone}">${deps.esc(securityBadge.text)}</span>
                <span class="settings-chevron">›</span>
              </div>
            </div>

            <div
              class="settings-nav-row"
              data-settings-row="password"
              onclick="openSettingsSubpage('password')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">🔑 密码与配对登录</div>
                <div class="settings-nav-sub">6 位免密配对码 · 修改密码 · 锁定当前浏览器</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-chevron">›</span>
              </div>
            </div>

            <div
              class="settings-nav-row"
              data-settings-row="shares"
              onclick="openSettingsSubpage('shares')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">🔐 加密分享记录</div>
                <div class="settings-nav-sub">端到端加密回放链接管理与销毁</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-nav-meta">${shares.length} 条</span>
                <span class="settings-chevron">›</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 分组 4：关于与工具 -->
        <section class="settings-group" data-settings-group="about">
          <div class="settings-group-header">
            <div class="settings-group-title">关于与工具</div>
          </div>
          <div class="settings-card">
            <div
              class="settings-nav-row"
              data-settings-row="capabilities"
              onclick="openSettingsSubpage('capabilities')"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">📊 各 AI 工具能力说明</div>
                <div class="settings-nav-sub">查看各后端支持看会话、发指令、审批与插话范围</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-chevron">›</span>
              </div>
            </div>

            <div
              class="settings-nav-row"
              data-settings-row="reload"
              onclick="forceHardUpgradeReload()"
            >
              <div class="settings-nav-main">
                <div class="settings-nav-title">🔄 强制刷新前端版本</div>
                <div class="settings-nav-sub">清除本地缓存并拉取最新页面</div>
              </div>
              <div class="settings-nav-right">
                <span class="settings-nav-meta">v${deps.esc(hubVer)}</span>
                <span class="settings-chevron">›</span>
              </div>
            </div>
          </div>
        </section>

        <div class="settings-version-footer">
          <div
            style="cursor:pointer;user-select:none;"
            onclick="copyCodeText('${deps.escUriJsStr(buildCopyPayload)}', '📋 版本信息已复制')"
          >
            DSH 远控总控台 v${deps.esc(hubVer)} · 构建 <code>${deps.esc(buildInfo.uiBuild || 'dev')}</code>${buildInfo.startedAt ? ' · 云端启动于 ' + deps.formatTime(buildInfo.startedAt) : ''}
          </div>
        </div>
      </div>
    `;
  }

  function renderHostDetailSubpageHtml(state) {
    const { hubState, upgradingHostMap } = state;
    const hosts = hubState.hosts || [];
    const buildInfo = hubState.build || {};
    const hubVer = String(buildInfo.version || '0.9.20');
    const h = hosts.find(item => item.hostId === activeHostId) || hosts[0];
    if (!h) {
      return `
        <div class="settings-wrap settings-subpage-wrap">
          ${renderSubpageHeaderHtml('电脑详情')}
          <div class="settings-card" style="padding:20px;text-align:center;color:var(--muted);">
            该电脑当前已不在列表中，请返回设置首页查看。
          </div>
        </div>
      `;
    }

    const isRevoked = (h.trustStatus || h.trust?.status) === 'revoked';
    const isHostLive = deps.isHostLiveOnline(h);
    const tm = deps.formatHostTelemetry(h);
    const sessCount = (h.bridgeState?.tasks || []).length;
    const runCount = h.runningCount || 0;
    const turboShort = h.bridgeState?.turbo?.enabled ? '⚡ 极速' : '🐢 轮询';
    const shortFp = (h.fingerprint || '已锁定').slice(0, 14);
    const hostVer = String(h.bridgeState?.agentVersion || '');
    const isUpgradingHost = Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000);
    const isHostOutdated = Boolean(isHostLive && !isRevoked && (!hostVer || deps.compareSemver(hostVer, hubVer) < 0));
    const versionBadgeHtml = isUpgradingHost
      ? `<span class="settings-status-pill tone-amber">⏳ 正在升级重启…</span>`
      : isHostOutdated
        ? `<span class="settings-status-pill tone-amber">⬆️ 可升 v${deps.esc(hubVer)} (${hostVer ? '当前 v' + deps.esc(hostVer) : '旧版'})</span>`
        : hostVer
          ? `<span class="settings-status-pill tone-green">v${deps.esc(hostVer)} 最新</span>`
          : '';

    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="host_detail">
        ${renderSubpageHeaderHtml(h.hostName || '电脑详情')}

        <div class="host-visual-card ${h.isFeishuActive ? 'active-feishu' : ''}" style="padding:14px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <span class="status-dot ${isHostLive && !isRevoked ? '' : 'offline'}"></span>
            <span style="font-size:16px;font-weight:800;color:var(--text);">${deps.esc(h.hostName)}</span>
            ${h.isFeishuActive ? `<span class="settings-mini-tag tone-blue">🎯 飞书主控</span>` : ''}
            ${isRevoked ? `<span class="settings-mini-tag tone-red">🚫 已吊销</span>` : ''}
            ${versionBadgeHtml}
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;font-size:12px;">
            <div style="padding:9px 10px;border-radius:10px;background:${tm.lowBattery ? 'var(--amber-soft)' : 'var(--subtle)'};border:1px solid ${tm.lowBattery ? '#fde68a' : 'var(--border)'};">
              <div style="font-size:11px;color:var(--muted);">供电与电量</div>
              <div style="font-weight:700;color:var(--text);margin-top:2px;">${tm.powerIcon} ${deps.esc(tm.powerDetail)}${tm.lowBattery ? ' ⚠️' : ''}</div>
            </div>
            <div style="padding:9px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);">
              <div style="font-size:11px;color:var(--muted);">网络与延迟</div>
              <div style="font-weight:700;color:var(--text);margin-top:2px;">${tm.netIcon} ${deps.esc(tm.netDetail)}</div>
            </div>
            <div style="padding:9px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);">
              <div style="font-size:11px;color:var(--muted);">会话与存储</div>
              <div style="font-weight:700;color:var(--text);margin-top:2px;">${sessCount} 条 · ${runCount} 运行 · ${deps.formatBytes(h.totalBytes)}</div>
            </div>
            <div style="padding:9px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);">
              <div style="font-size:11px;color:var(--muted);">同步与系统</div>
              <div style="font-weight:700;color:var(--text);margin-top:2px;">${deps.esc(h.platform || 'macOS')} ${deps.esc(h.arch || '')} · ${turboShort}</div>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div style="font-size:11.5px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">已检测到的 AI 工具</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px;">
              <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--subtle);color:var(--text);">${deps.renderHarnessBadgeHtml('dsh', 'inline')} DSH · ✅ 远控+审批</span>
              <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--subtle);color:var(--text);">${deps.renderHarnessBadgeHtml('antigravity-ide', 'inline')} Antigravity · ✅ 远控+审批</span>
              ${(h.bridgeState?.harnesses || []).map(ad => {
                const canApproveNow = Boolean(ad.capabilities?.canApprove || ad.id === 'codex' || ad.id === 'workbuddy');
                const isObserveAdapter = ad.capabilities?.canPrompt === false || ad.id === 'doubao';
                const statusTag = !ad.installed && !ad.hasBinary
                  ? '⚪ 未安装'
                  : isObserveAdapter
                    ? '👀 仅观测'
                    : ad.hasBinary
                      ? (canApproveNow ? '✅ 远控+审批' : '🔵 看会话/发指令')
                      : '👀 观察模式';
                return `
                  <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--subtle);color:var(--text);">
                    ${deps.renderHarnessBadgeHtml(ad.id, 'inline')} ${deps.esc(ad.label || ad.id)} · ${statusTag}
                  </span>
                `;
              }).join('')}
            </div>
          </div>

          <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--hairline);font-size:11.5px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
            <span>🔒 指纹 <code>${deps.esc(shortFp)}</code> · ${h.hasDedicatedToken ? `🔑 独立凭证 (${deps.esc(h.hostTokenPreview)})` : '🔑 管理员凭证'}</span>
            <span>${h.syncMeta?.seq ? `同步序号 #${h.syncMeta.seq}` : ''}</span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">飞书主控电脑</div>
              <div class="settings-item-desc">指定飞书机器人指令默认发送到哪台电脑</div>
            </div>
            <button type="button" class="pill-action-btn ${h.isFeishuActive ? 'primary' : ''}" onclick="activateFeishuHost('${deps.escJsStr(h.hostId)}')">
              ${h.isFeishuActive ? '🎯 当前主控' : '设为主控'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">飞书实时通知</div>
              <div class="settings-item-desc">开启后 2 小时无操作自动关闭</div>
            </div>
            <button type="button" class="pill-action-btn ${h.remoteActive ? 'primary' : ''}" onclick="toggleHostRemoteMode('${deps.escJsStr(h.hostId)}', ${!h.remoteActive})">
              ${h.remoteActive ? '🔔 已开启' : '🔕 已关闭'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">极速同步引擎</div>
              <div class="settings-item-desc">查看 Rust 极速同步状态或一键开启提速</div>
            </div>
            <button type="button" class="pill-action-btn" onclick="openTurboGuideSheet()">
              ${h.bridgeState?.turbo?.enabled ? '⚡ 极速详情' : '🚀 一键提速'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">客户端版本更新</div>
              <div class="settings-item-desc">${hostVer ? `当前 v${deps.esc(hostVer)} · 云端 v${deps.esc(hubVer)}` : `云端最新 v${deps.esc(hubVer)}`}</div>
            </div>
            <button type="button" class="pill-action-btn ${isHostOutdated ? 'primary' : ''}" onclick="upgradeHostTurbo('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')" ${isUpgradingHost ? 'disabled' : ''}>
              ${isUpgradingHost ? '⏳ 升级中…' : (isHostOutdated ? `🔄 升级 v${deps.esc(hubVer)}` : '🔄 重装/更新')}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">独立访问凭证</div>
              <div class="settings-item-desc">吊销后该电脑将立即断开连接，不影响其他电脑</div>
            </div>
            ${isRevoked ? `
              <button type="button" class="pill-action-btn primary" onclick="unrevokeHostCredential('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')">恢复接入</button>
            ` : `
              <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="revokeHostCredential('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')">🚫 吊销凭证</button>
            `}
          </div>
        </div>
      </div>
    `;
  }

  function renderAddHostSubpageHtml() {
    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="add_host">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.add_host)}
        ${deps.renderAddHostPanelHtml({ isEmptyState: false, forceExpanded: true })}
      </div>
    `;
  }

  function renderPushSubpageHtml(state) {
    const { cachedPushStatusText, cachedPushStatusColor, cachedPushDeviceListText } = state;
    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="push">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.push)}
        <div class="settings-card">
          <div class="settings-item" style="display:block;">
            <div class="settings-item-title">启用 iPhone 锁屏实时推送</div>
            <div class="settings-item-desc">当任意电脑有待审批、任务完成或异常时直接弹窗提醒</div>
            <div id="pushLocalStatus" style="margin-top:10px;font-size:13px;font-weight:700;color:${deps.esc(cachedPushStatusColor || 'var(--primary)')};">
              ${deps.esc(cachedPushStatusText || '正在检测本机推送状态…')}
            </div>
            <div id="pushDeviceList" style="margin-top:5px;font-size:12px;color:var(--muted);line-height:1.55;">
              ${deps.esc(cachedPushDeviceListText || '')}
            </div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
              <button type="button" class="pill-action-btn primary" onclick="subscribeIphonePush()">📲 开启推送</button>
              <button type="button" class="pill-action-btn" onclick="sendTestPush()">🔔 发送测试</button>
              <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="disableIphonePush()">关闭本机推送</button>
            </div>
            <div class="settings-item-desc" style="margin-top:10px;">
              iPhone 需先在 Safari 点击「分享 → 添加到主屏幕」，再从桌面图标打开本页并开启推送，才能收到锁屏通知。
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderSecuritySubpageHtml(state) {
    const { hubState, currentDeviceId } = state;
    const secSum = hubState.securitySummary || { total24h: 0, high24h: 0, uniqueIps24h: 0, recentEvents: [] };
    const ac = hubState.accessControl || { deviceApprovalEnabled: false, trustedDevices: [], pendingDeviceLogins: [], pendingHosts: [] };

    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="security">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.security)}

        <div class="settings-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">
                🔐 新设备 / 新电脑接入需我手机审批
                <span class="settings-status-pill tone-${ac.deviceApprovalEnabled ? 'green' : 'amber'}" style="margin-left:6px;">
                  ${ac.deviceApprovalEnabled ? '已开启保护' : '未开启'}
                </span>
              </div>
              <div class="settings-item-desc">
                开启后，即使有人拿到管理密码，新浏览器登录或新电脑接入都必须先经你这台手机点击「允许」，否则一律拦截。
              </div>
            </div>
            <button
              type="button"
              class="pill-action-btn ${ac.deviceApprovalEnabled ? '' : 'primary'}"
              onclick="toggleDeviceApprovalGuard(${ac.deviceApprovalEnabled ? 'false' : 'true'})"
            >
              ${ac.deviceApprovalEnabled ? '关闭保护' : '立即开启'}
            </button>
          </div>

          ${(ac.trustedDevices || []).length > 0 ? `
            <div class="settings-item" style="display:block;">
              <div class="settings-item-title">📱 已信任的手机 / 浏览器 (${(ac.trustedDevices || []).length})</div>
              <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
                ${(ac.trustedDevices || []).map(dev => `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);font-size:12px;">
                    <div style="min-width:0;flex:1;">
                      <div style="font-weight:700;color:var(--text);">
                        ${deps.esc(dev.name || '已信任设备')}
                        ${(dev.isCurrent || dev.id === hubState.currentDeviceId || dev.id === currentDeviceId)
                          ? `<span class="settings-mini-tag tone-blue" style="margin-left:4px;">本机</span>`
                          : ''}
                      </div>
                      <div style="font-size:11px;color:var(--muted);margin-top:2px;">
                        IP: <code>${deps.esc(dev.ip || '-')}</code> · 最近活跃 ${deps.formatTime(dev.lastSeen || dev.approvedAt)}
                      </div>
                    </div>
                    <button type="button" class="pill-action-btn" style="color:var(--red);padding:4px 8px;font-size:11px;" onclick="revokeTrustedDeviceById('${deps.escJsStr(dev.id)}')">🚫 踢出</button>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="settings-item" style="display:block;">
            <div class="settings-item-title">
              ${secSum.total24h > 0
                ? `<span style="color:var(--red);">🚨 近 24 小时已拦截 ${secSum.total24h} 次异常探测（${secSum.uniqueIps24h} 个来源 IP）</span>`
                : `<span style="color:var(--green);">🟢 运行安全 · 近 24 小时 0 次攻击探测</span>`}
            </div>
            <div class="settings-item-desc" style="margin-top:4px;">
              监测伪造令牌、敏感路径探测（403）、密码爆破（429）与未审批设备直连，命中后立即推送到你的手机锁屏。
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button type="button" class="pill-action-btn" onclick="sendTestSecurityAlert()">🚨 演练告警</button>
              ${(secSum.recentEvents || []).length > 0
                ? `<button type="button" class="pill-action-btn" onclick="clearSecurityAlerts()">🧹 清空日志</button>`
                : ''}
            </div>
            ${(secSum.recentEvents || []).length > 0 ? `
              <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;">
                ${(secSum.recentEvents || []).slice(0, 12).map(ev => {
                  const kindLabelMap = {
                    forged_host_token: '伪造令牌',
                    sensitive_path_probe: '敏感路径',
                    auth_bruteforce: '密码爆破',
                    unauth_api_scan: '异常直连',
                  };
                  const badge = kindLabelMap[ev.kind] || ev.kind || '异常';
                  return `
                    <div style="padding:8px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);font-size:11.5px;line-height:1.45;">
                      <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;flex-wrap:wrap;">
                        <span>
                          <strong style="color:${ev.severity === 'high' ? 'var(--red)' : '#d97706'};">[${deps.esc(badge)} · ${deps.esc(String(ev.status || 401))}]</strong>
                          <code style="margin-left:4px;">${deps.esc(ev.ip || 'unknown')}</code>
                        </span>
                        <span style="color:var(--muted);">${deps.formatTime(ev.at)}</span>
                      </div>
                      <div style="color:var(--text-secondary);font-family:var(--mono);font-size:11px;margin-top:3px;word-break:break-all;">
                        ${deps.esc(ev.method || 'GET')} ${deps.esc(ev.path || '')}
                      </div>
                      ${ev.detail ? `<div style="color:var(--muted);margin-top:2px;">${deps.esc(ev.detail)}</div>` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function renderPasswordSubpageHtml() {
    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="password">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.password)}
        <div class="settings-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">添加新手机（6 位免密配对码）</div>
              <div class="settings-item-desc">生成 3 分钟有效的一次性 6 位字母/数字配对码，新手机免输长密码直接解锁</div>
            </div>
            <button type="button" class="pill-action-btn primary" onclick="openPairingCodeSheet()">📱 生成配对码</button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">修改总控台访问密码</div>
              <div class="settings-item-desc">随时更换访问密钥，防止未授权访问</div>
            </div>
            <button type="button" class="pill-action-btn" onclick="promptChangePassword()">🔑 修改密码</button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">锁定当前浏览器</div>
              <div class="settings-item-desc">清除本机浏览器缓存的登录凭证</div>
            </div>
            <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="lockAndLogout()">🔒 立即锁定</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderSharesSubpageHtml(state) {
    const { hubState } = state;
    const hosts = hubState.hosts || [];
    const shares = hubState.shares || [];
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const latestShareResults = hosts
      .filter(h => h.lastShareResult && h.lastShareResult.shareUrl)
      .map(h => {
        const rawUrl = h.lastShareResult.shareUrl;
        const fullUrl = rawUrl.startsWith('http') ? rawUrl : origin + rawUrl;
        return {
          hostName: h.hostName,
          shareId: h.lastShareResult.shareId || '',
          fullUrl,
          at: h.lastShareResult.at || 0,
        };
      });

    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="shares">
        ${renderSubpageHeaderHtml(`${SETTINGS_SUBPAGE_TITLES.shares} (${shares.length})`)}
        <div class="settings-card">
          ${latestShareResults.map(item => `
            <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="settings-item-title">🔐 最近生成（来自 ${deps.esc(item.hostName)}）</div>
                <span style="font-size:11.5px;color:var(--muted);">${deps.formatTime(item.at)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--muted);font-family:var(--mono);word-break:break-all;background:var(--subtle);padding:6px 8px;border-radius:8px;">
                ${deps.esc(item.fullUrl)}
              </div>
              <div style="display:flex;gap:8px;">
                <button type="button" class="pill-action-btn primary" onclick="copyCodeText('${deps.escUriJsStr(item.fullUrl)}', '🔗 加密分享链接已复制')">📋 复制完整解密链接</button>
                <a href="${deps.esc(item.fullUrl)}" target="_blank" rel="noopener" class="pill-action-btn" style="text-decoration:none;display:inline-flex;align-items:center;">🌐 打开</a>
              </div>
            </div>
          `).join('')}
          ${shares.length ? shares.slice(0, 20).map(s => `
            <div class="settings-item">
              <div>
                <div class="settings-item-title">${deps.esc(s.title || '加密会话回放')}</div>
                <div class="settings-item-desc">来自 ${deps.esc(s.hostName || s.hostId || '远端电脑')} · ${deps.formatTime(s.createdAt)} · ${deps.formatBytes(s.sizeBytes || 0)}</div>
              </div>
              <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="deleteShareRecord('${deps.escJsStr(s.id || s.shareId)}')">🗑️ 销毁</button>
            </div>
          `).join('') : `
            <div class="settings-item">
              <div class="settings-item-desc">暂无加密分享记录。可在任意会话右上角「⋯ → 生成 AES-256 端到端加密回放链接」创建。</div>
            </div>
          `}
        </div>
      </div>
    `;
  }

  function renderCapabilitiesSubpageHtml() {
    return `
      <div class="settings-wrap settings-subpage-wrap" data-settings-subpage="capabilities">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.capabilities)}
        <div class="settings-card" style="padding:12px 14px;overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;text-align:center;">
            <thead>
              <tr style="border-bottom:1px solid var(--border);color:var(--muted);">
                <th style="text-align:left;padding:6px 4px;">后端</th>
                <th style="padding:6px 3px;">看会话</th>
                <th style="padding:6px 3px;">发指令</th>
                <th style="padding:6px 3px;">停止</th>
                <th style="padding:6px 3px;">手机审批</th>
                <th style="padding:6px 3px;">实时插话</th>
              </tr>
            </thead>
            <tbody>
              ${deps.renderCapabilityMatrixRowsHtml()}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function render(viewport, opts = {}) {
    if (!viewport) return;
    const state = deps.getState();
    const voiceSummary = formatVoiceSummaryForSettings(getVoiceConfig());
    const signature = buildSignature(state, voiceSummary);

    if (signature === lastRenderedKey && viewport.querySelector('.settings-wrap')) {
      syncPushSummaryBadge(state.cachedPushStatusText);
      void deps.refreshPushStatus?.();
      return;
    }

    const prevScrollTop = viewport.scrollTop || 0;
    lastRenderedKey = signature;

    let html = '';
    if (activeSubpage === 'host_detail') {
      html = renderHostDetailSubpageHtml(state);
    } else if (activeSubpage === 'add_host') {
      html = renderAddHostSubpageHtml();
    } else if (activeSubpage === 'push') {
      html = renderPushSubpageHtml(state);
    } else if (activeSubpage === 'security') {
      html = renderSecuritySubpageHtml(state);
    } else if (activeSubpage === 'password') {
      html = renderPasswordSubpageHtml();
    } else if (activeSubpage === 'shares') {
      html = renderSharesSubpageHtml(state);
    } else if (activeSubpage === 'capabilities') {
      html = renderCapabilitiesSubpageHtml();
    } else {
      html = renderHomeHtml(state, voiceSummary);
    }

    viewport.innerHTML = html;

    if (opts.scrollToTop) {
      viewport.scrollTop = 0;
    } else if (opts.restoreHomeScroll) {
      viewport.scrollTop = savedHomeScrollTop;
    } else if (prevScrollTop > 0) {
      viewport.scrollTop = prevScrollTop;
    }

    if (state.langPref === 'en' && typeof deps.applyLangToDom === 'function') {
      deps.applyLangToDom(viewport, state.langPref);
    }

    void deps.refreshPushStatus?.();
  }

  return {
    render,
    invalidate,
    openSubpage,
    closeSubpage,
    getActiveSubpage,
    syncPushSummaryBadge,
  };
}
