// Standalone modular Settings Tab controller (Apple Native Minimalist — Design A).
// Clean single-line iOS grouped rows, crisp inline vector SVG icons, zero emoji clutter,
// compact top host strip, and smooth drill-down sub-pages — fully isolated from controller.js core.

import { formatVoiceCompactValue } from '../voice/provider-routing.js';

export const SETTINGS_SUBPAGE_TITLES = {
  hosts_list: '已接入电脑',
  host_detail: '电脑详情与控制',
  add_host: '添加电脑与手机扫码',
  push: '锁屏通知',
  security: '审批与安全防护',
  password: '密码与配对登录',
  shares: '加密分享记录',
  capabilities: '各 AI 工具能力说明',
};

const SVG_ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>',
  headphones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l-4 4 4 4"/><path d="M3 14h14"/><path d="M17 14l4-4-4-4"/><path d="M21 10H7"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
};

export function computePushBadgeMeta(statusText = '') {
  const s = String(statusText || '');
  if (!s || s.includes('正在检测')) {
    return { text: '检测中', tone: 'muted' };
  }
  if (s.includes('已开启')) {
    return { text: '已开启', tone: 'green' };
  }
  if (s.includes('被拒绝')) {
    return { text: '权限被拒', tone: 'red' };
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
  return { text: '查看', tone: 'muted' };
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
    badge.className = `ios-row-val tone-${meta.tone}`;
    const langPref = deps.getState?.()?.langPref;
    if (langPref === 'en' && typeof deps.applyLangToDom === 'function') {
      deps.applyLangToDom(badge, langPref);
    }
  }

  function buildSignature(state, voiceCompact) {
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
      voiceCompact,
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
      <div class="ios-sub-header">
        <button
          type="button"
          class="ios-sub-back"
          id="settingsSubBackBtn"
          onclick="closeSettingsSubpage()"
        >
          <span class="ios-back-ico">${SVG_ICONS.back}</span>
          <span>设置</span>
        </button>
        <div class="ios-sub-title">${deps.esc(title)}</div>
        <div class="ios-sub-spacer"></div>
      </div>
    `;
  }

  function renderHomeHtml(state, voiceCompact) {
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
    const hubVer = String(buildInfo.version || '0.9.21');
    const secSum = hubState.securitySummary || { total24h: 0, high24h: 0, uniqueIps24h: 0, recentEvents: [] };
    const ac = hubState.accessControl || { deviceApprovalEnabled: false, trustedDevices: [], pendingDeviceLogins: [], pendingHosts: [] };
    const pendingCount = (ac.pendingDeviceLogins || []).length + (ac.pendingHosts || []).length;
    const pushBadge = computePushBadgeMeta(cachedPushStatusText);

    const securityMeta = secSum.total24h > 0
      ? { text: `${secSum.total24h} 次拦截`, tone: 'red' }
      : pendingCount > 0
        ? { text: `${pendingCount} 待审批`, tone: 'amber' }
        : ac.deviceApprovalEnabled
          ? { text: '已开启', tone: 'green' }
          : { text: '未开启', tone: 'amber' };

    const nextThemePref = themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system';
    const themeLabel = themePref === 'light' ? '浅色' : themePref === 'dark' ? '深色' : '跟随系统';
    const nextLangPref = langPref === 'en' ? 'zh' : 'en';
    const langLabel = langPref === 'en' ? 'English' : '简体中文';

    const hostStripHtml = hosts.length > 0
      ? `
        <div class="ios-host-strip" data-settings-group="hosts">
          <div class="ios-host-chips">
            ${hosts.map(h => {
              const isRevoked = (h.trustStatus || h.trust?.status) === 'revoked';
              const isHostLive = deps.isHostLiveOnline(h);
              const sessCount = (h.bridgeState?.tasks || []).length;
              const runCount = h.runningCount || 0;
              const hostVer = String(h.bridgeState?.agentVersion || '');
              const isUpgrading = Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000);
              const isOutdated = Boolean(isHostLive && !isRevoked && (!hostVer || deps.compareSemver(hostVer, hubVer) < 0));

              const dotClass = isRevoked ? 'revoked' : isHostLive ? 'online' : 'offline';
              const metaParts = [];
              if (isRevoked) {
                metaParts.push('已吊销');
              } else if (!isHostLive) {
                metaParts.push('已离线');
              } else {
                if (h.isFeishuActive) metaParts.push('主控');
                if (isUpgrading) metaParts.push('升级中');
                else if (isOutdated) metaParts.push('可升级');
                if (runCount > 0) metaParts.push(`${runCount} 运行中`);
                else metaParts.push(`${sessCount} 会话`);
              }

              return `
                <button
                  type="button"
                  class="ios-host-chip"
                  data-settings-host="${deps.esc(h.hostId)}"
                  onclick="openSettingsSubpage('host_detail', '${deps.escJsStr(h.hostId)}')"
                >
                  <div class="ios-host-top">
                    <span class="ios-host-dot ${dotClass}"></span>
                    <span class="ios-host-name">${deps.esc(h.hostName)}</span>
                  </div>
                  <div class="ios-host-meta ${isOutdated && !isUpgrading ? 'has-update' : ''}">${deps.esc(metaParts.slice(0, 2).join(' · '))}</div>
                </button>
              `;
            }).join('')}
          </div>
          <button
            type="button"
            class="ios-host-all-btn"
            aria-label="查看全部电脑"
            data-settings-row="hosts_list"
            onclick="openSettingsSubpage('hosts_list')"
          >
            <span class="ios-chev">${SVG_ICONS.chev}</span>
          </button>
        </div>
      `
      : `
        <div class="ios-card" data-settings-group="hosts">
          <button
            type="button"
            class="ios-row"
            data-settings-row="add_host_empty"
            onclick="openSettingsSubpage('add_host')"
          >
            <span class="ios-ico blue">${SVG_ICONS.laptop}</span>
            <span class="ios-row-title">暂未接入电脑</span>
            <span class="ios-row-val tone-blue">去添加</span>
            <span class="ios-chev">${SVG_ICONS.chev}</span>
          </button>
        </div>
      `;

    const buildCopyPayload = `PocketAgents v${hubVer} (${buildInfo.uiBuild || 'dev'}) · started ${buildInfo.startedAt ? new Date(buildInfo.startedAt).toISOString() : ''}`;

    return `
      <div class="settings-wrap ios-settings-wrap settings-grouped-home">
        <div class="ios-header">
          <h1 class="ios-h1">设置</h1>
          <button
            type="button"
            class="ios-add-btn"
            data-settings-row="add_host"
            onclick="openSettingsSubpage('add_host')"
          >
            <span class="ios-add-ico">${SVG_ICONS.plus}</span>
            <span>添加电脑</span>
          </button>
        </div>

        ${hostStripHtml}

        <!-- 分组：模型与偏好 -->
        <section class="ios-section" data-settings-group="model-prefs">
          <div class="ios-group-label settings-group-title">模型与偏好</div>
          <div class="ios-card">
            <button
              type="button"
              class="ios-row"
              data-settings-row="voice"
              onclick="openVoiceLab('list')"
            >
              <span class="ios-ico indigo">${SVG_ICONS.headphones}</span>
              <span class="ios-row-title">边走边听</span>
              <span class="ios-row-val" id="settingsVoiceSummaryText">${deps.esc(voiceCompact)}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="push"
              onclick="openSettingsSubpage('push')"
            >
              <span class="ios-ico red">${SVG_ICONS.bell}</span>
              <span class="ios-row-title">锁屏通知</span>
              <span class="ios-row-val tone-${pushBadge.tone}" id="settingsPushSummaryBadge">${deps.esc(pushBadge.text)}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="theme"
              onclick="setThemePreference('${nextThemePref}')"
            >
              <span class="ios-ico blue">${SVG_ICONS.sun}</span>
              <span class="ios-row-title">外观</span>
              <span class="ios-row-val" id="settingsThemeVal">${deps.esc(themeLabel)}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="language"
              onclick="setLangPreference('${nextLangPref}')"
            >
              <span class="ios-ico teal">${SVG_ICONS.globe}</span>
              <span class="ios-row-title">语言</span>
              <span class="ios-row-val" id="settingsLangVal">${deps.esc(langLabel)}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>
          </div>
        </section>

        <!-- 分组：安全与隐私 -->
        <section class="ios-section" data-settings-group="security">
          <div class="ios-group-label settings-group-title">安全与隐私</div>
          <div class="ios-card">
            <button
              type="button"
              class="ios-row"
              data-settings-row="security"
              onclick="openSettingsSubpage('security')"
            >
              <span class="ios-ico emerald">${SVG_ICONS.shield}</span>
              <span class="ios-row-title">审批与安全防护</span>
              <span class="ios-row-val tone-${securityMeta.tone}">${deps.esc(securityMeta.text)}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="password"
              onclick="openSettingsSubpage('password')"
            >
              <span class="ios-ico amber">${SVG_ICONS.key}</span>
              <span class="ios-row-title">密码与配对登录</span>
              <span class="ios-row-val"></span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="shares"
              onclick="openSettingsSubpage('shares')"
            >
              <span class="ios-ico violet">${SVG_ICONS.lock}</span>
              <span class="ios-row-title">加密分享记录</span>
              <span class="ios-row-val">${shares.length} 条</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>
          </div>
        </section>

        <!-- 分组：更多 -->
        <section class="ios-section" data-settings-group="more">
          <div class="ios-group-label settings-group-title">更多</div>
          <div class="ios-card">
            <button
              type="button"
              class="ios-row"
              data-settings-row="migrate"
              onclick="openMigrateWizard()"
            >
              <span class="ios-ico slate">${SVG_ICONS.transfer}</span>
              <span class="ios-row-title">跨电脑会话迁移</span>
              <span class="ios-row-val">${hosts.length >= 2 ? `${hosts.length} 台可用` : '需 ≥2 台'}</span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>

            <button
              type="button"
              class="ios-row"
              data-settings-row="capabilities"
              onclick="openSettingsSubpage('capabilities')"
            >
              <span class="ios-ico slate">${SVG_ICONS.grid}</span>
              <span class="ios-row-title">各 AI 工具能力说明</span>
              <span class="ios-row-val"></span>
              <span class="ios-chev">${SVG_ICONS.chev}</span>
            </button>
          </div>
        </section>

        <div class="ios-footer">
          <span
            class="ios-footer-ver"
            onclick="copyCodeText('${deps.escUriJsStr(buildCopyPayload)}', '📋 版本信息已复制')"
          >PocketAgents v${deps.esc(hubVer)} (${deps.esc(buildInfo.uiBuild || 'dev')})</span>
          <span class="ios-footer-sep">·</span>
          <button
            type="button"
            class="ios-footer-link"
            data-settings-row="reload"
            onclick="forceHardUpgradeReload()"
          >刷新版本</button>
        </div>
      </div>
    `;
  }

  function renderHostsListSubpageHtml(state) {
    const { hubState, upgradingHostMap } = state;
    const hosts = hubState.hosts || [];
    const buildInfo = hubState.build || {};
    const hubVer = String(buildInfo.version || '0.9.21');

    return `
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="hosts_list">
        ${renderSubpageHeaderHtml(`${SETTINGS_SUBPAGE_TITLES.hosts_list} (${hosts.length})`)}
        <div class="ios-card">
          ${hosts.length ? hosts.map(h => {
            const isRevoked = (h.trustStatus || h.trust?.status) === 'revoked';
            const isHostLive = deps.isHostLiveOnline(h);
            const tm = deps.formatHostTelemetry(h);
            const sessCount = (h.bridgeState?.tasks || []).length;
            const runCount = h.runningCount || 0;
            const hostVer = String(h.bridgeState?.agentVersion || '');
            const isUpgrading = Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000);
            const isOutdated = Boolean(isHostLive && !isRevoked && (!hostVer || deps.compareSemver(hostVer, hubVer) < 0));
            const dotClass = isRevoked ? 'revoked' : isHostLive ? 'online' : 'offline';
            const sub = isHostLive
              ? `${tm.powerShort} · ${tm.netShort} · ${sessCount} 会话${runCount > 0 ? ` · ${runCount} 运行中` : ''}`
              : `已离线 (${deps.formatTime(h.lastSeen)}) · ${sessCount} 会话`;

            return `
              <div
                class="ios-host-list-row"
                onclick="openSettingsSubpage('host_detail', '${deps.escJsStr(h.hostId)}')"
              >
                <div class="ios-host-list-main">
                  <div class="ios-host-list-top">
                    <span class="ios-host-dot ${dotClass}"></span>
                    <span class="ios-host-list-name">${deps.esc(h.hostName)}</span>
                    ${h.isFeishuActive ? `<span class="settings-mini-tag tone-blue">主控</span>` : ''}
                    ${isRevoked ? `<span class="settings-mini-tag tone-red">已吊销</span>` : ''}
                  </div>
                  <div class="ios-host-list-sub">${deps.esc(sub)}</div>
                </div>
                <div class="ios-host-list-right">
                  ${isOutdated && !isUpgrading ? `
                    <button
                      type="button"
                      class="pill-action-btn primary"
                      style="padding:4px 10px;font-size:11.5px;"
                      onclick="event.stopPropagation(); upgradeHostTurbo('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')"
                    >升级</button>
                  ` : isUpgrading ? `<span class="ios-row-val tone-amber">升级中</span>` : ''}
                  <span class="ios-chev">${SVG_ICONS.chev}</span>
                </div>
              </div>
            `;
          }).join('') : `
            <div class="settings-item">
              <div class="settings-item-desc">暂未接入在线电脑</div>
            </div>
          `}
        </div>

        <div class="ios-card">
          <button type="button" class="ios-row" onclick="openSettingsSubpage('add_host')">
            <span class="ios-ico blue">${SVG_ICONS.plus}</span>
            <span class="ios-row-title" style="color:var(--primary);">添加新电脑 / 手机扫码登录</span>
            <span class="ios-chev">${SVG_ICONS.chev}</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderHostDetailSubpageHtml(state) {
    const { hubState, upgradingHostMap } = state;
    const hosts = hubState.hosts || [];
    const buildInfo = hubState.build || {};
    const hubVer = String(buildInfo.version || '0.9.21');
    const h = hosts.find(item => item.hostId === activeHostId) || hosts[0];
    if (!h) {
      return `
        <div class="settings-wrap ios-settings-wrap ios-subpage-wrap">
          ${renderSubpageHeaderHtml('电脑详情')}
          <div class="ios-card" style="padding:20px;text-align:center;color:var(--muted);">
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
    const turboShort = h.bridgeState?.turbo?.enabled ? '极速同步' : '轮询模式';
    const shortFp = (h.fingerprint || (state.langPref === 'en' ? 'Pinned' : '已锁定')).slice(0, 14);
    const hostVer = String(h.bridgeState?.agentVersion || '');
    const isUpgradingHost = Boolean(upgradingHostMap[h.hostId] && Date.now() - upgradingHostMap[h.hostId] < 45000);
    const isHostOutdated = Boolean(isHostLive && !isRevoked && (!hostVer || deps.compareSemver(hostVer, hubVer) < 0));
    const versionBadgeHtml = isUpgradingHost
      ? `<span class="settings-status-pill tone-amber">升级重启中…</span>`
      : isHostOutdated
        ? `<span class="settings-status-pill tone-amber">可升 v${deps.esc(hubVer)}</span>`
        : hostVer
          ? `<span class="settings-status-pill tone-green">v${deps.esc(hostVer)} 最新</span>`
          : '';

    return `
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="host_detail">
        ${renderSubpageHeaderHtml(h.hostName || '电脑详情')}

        <div class="ios-card" style="padding:14px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <span class="ios-host-dot ${isRevoked ? 'revoked' : isHostLive ? 'online' : 'offline'}"></span>
            <span style="font-size:16px;font-weight:750;color:var(--text);">${deps.esc(h.hostName)}</span>
            ${h.isFeishuActive ? `<span class="settings-mini-tag tone-blue">飞书主控</span>` : ''}
            ${isRevoked ? `<span class="settings-mini-tag tone-red">已吊销</span>` : ''}
            ${versionBadgeHtml}
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;font-size:12px;">
            <div class="ios-metric-tile ${tm.lowBattery ? 'warn' : ''}">
              <div class="ios-metric-k">供电与电量</div>
              <div class="ios-metric-v">${deps.esc(tm.powerDetail)}</div>
            </div>
            <div class="ios-metric-tile">
              <div class="ios-metric-k">网络与延迟</div>
              <div class="ios-metric-v">${deps.esc(tm.netDetail)}</div>
            </div>
            <div class="ios-metric-tile">
              <div class="ios-metric-k">会话与存储</div>
              <div class="ios-metric-v">${sessCount} 条 · ${runCount} 运行 · ${deps.formatBytes(h.totalBytes)}</div>
            </div>
            <div class="ios-metric-tile">
              <div class="ios-metric-k">同步与系统</div>
              <div class="ios-metric-v">${deps.esc(h.platform || 'macOS')} ${deps.esc(h.arch || '')} · ${turboShort}</div>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div style="font-size:11.5px;font-weight:650;color:var(--muted);margin-bottom:6px;">已检测到的 AI 工具</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px;">
              <span class="ios-harness-pill">${deps.renderHarnessBadgeHtml('dsh', 'inline')} DSH · 远控+审批</span>
              <span class="ios-harness-pill">${deps.renderHarnessBadgeHtml('antigravity-ide', 'inline')} Antigravity · 远控+审批</span>
              ${(h.bridgeState?.harnesses || []).map(ad => {
                const canApproveNow = Boolean(ad.capabilities?.canApprove || ad.id === 'codex' || ad.id === 'workbuddy');
                const isObserveAdapter = ad.capabilities?.canPrompt === false || ad.id === 'doubao';
                const statusTag = !ad.installed && !ad.hasBinary
                  ? '未安装'
                  : isObserveAdapter
                    ? '仅观测'
                    : ad.hasBinary
                      ? (canApproveNow ? '远控+审批' : '看会话/发指令')
                      : '观察模式';
                return `
                  <span class="ios-harness-pill">
                    ${deps.renderHarnessBadgeHtml(ad.id, 'inline')} ${deps.esc(ad.label || ad.id)} · ${statusTag}
                  </span>
                `;
              }).join('')}
            </div>
          </div>

          <div style="margin-top:12px;padding-top:10px;border-top:0.5px solid var(--hairline);font-size:11.5px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
            <span>指纹 <code>${deps.esc(shortFp)}</code> · ${h.hasDedicatedToken ? `独立凭证 (${deps.esc(h.hostTokenPreview)})` : '管理员凭证'}</span>
            <span>${h.syncMeta?.seq ? `同步 #${h.syncMeta.seq}` : ''}</span>
          </div>
        </div>

        <div class="ios-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">飞书主控电脑</div>
              <div class="settings-item-desc">指定飞书机器人指令默认发送到哪台电脑</div>
            </div>
            <button type="button" class="pill-action-btn ${h.isFeishuActive ? 'primary' : ''}" onclick="activateFeishuHost('${deps.escJsStr(h.hostId)}')">
              ${h.isFeishuActive ? '当前主控' : '设为主控'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">飞书实时通知</div>
              <div class="settings-item-desc">开启后 2 小时无操作自动关闭</div>
            </div>
            <button type="button" class="pill-action-btn ${h.remoteActive ? 'primary' : ''}" onclick="toggleHostRemoteMode('${deps.escJsStr(h.hostId)}', ${!h.remoteActive})">
              ${h.remoteActive ? '已开启' : '已关闭'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">极速同步引擎</div>
              <div class="settings-item-desc">查看 Rust 极速同步状态或一键开启提速</div>
            </div>
            <button type="button" class="pill-action-btn" onclick="openTurboGuideSheet()">
              ${h.bridgeState?.turbo?.enabled ? '极速详情' : '一键提速'}
            </button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">客户端版本更新</div>
              <div class="settings-item-desc">${hostVer ? `当前 v${deps.esc(hostVer)} · 云端 v${deps.esc(hubVer)}` : `云端最新 v${deps.esc(hubVer)}`}</div>
            </div>
            <button type="button" class="pill-action-btn ${isHostOutdated ? 'primary' : ''}" onclick="upgradeHostTurbo('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')" ${isUpgradingHost ? 'disabled' : ''}>
              ${isUpgradingHost ? '升级中…' : (isHostOutdated ? `升级 v${deps.esc(hubVer)}` : '检查/重装')}
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
              <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="revokeHostCredential('${deps.escJsStr(h.hostId)}', '${deps.escJsStr(h.hostName)}')">吊销凭证</button>
            `}
          </div>
        </div>
      </div>
    `;
  }

  function renderAddHostSubpageHtml() {
    return `
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="add_host">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.add_host)}
        ${deps.renderAddHostPanelHtml({ isEmptyState: false, forceExpanded: true })}
      </div>
    `;
  }

  function renderPushSubpageHtml(state) {
    const { cachedPushStatusText, cachedPushStatusColor, cachedPushDeviceListText } = state;
    return `
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="push">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.push)}
        <div class="ios-card">
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
              <button type="button" class="pill-action-btn primary" onclick="subscribeIphonePush()">开启推送</button>
              <button type="button" class="pill-action-btn" onclick="sendTestPush()">发送测试</button>
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
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="security">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.security)}

        <div class="ios-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">
                新设备 / 新电脑接入需我手机审批
                <span class="settings-status-pill tone-${ac.deviceApprovalEnabled ? 'green' : 'amber'}" style="margin-left:6px;">
                  ${ac.deviceApprovalEnabled ? '已开启' : '未开启'}
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
              <div class="settings-item-title">已信任的手机 / 浏览器 (${(ac.trustedDevices || []).length})</div>
              <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
                ${(ac.trustedDevices || []).map(dev => `
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:10px;background:var(--subtle);font-size:12px;">
                    <div style="min-width:0;flex:1;">
                      <div style="font-weight:650;color:var(--text);">
                        ${deps.esc(dev.name || '已信任设备')}
                        ${(dev.isCurrent || dev.id === hubState.currentDeviceId || dev.id === currentDeviceId)
                          ? `<span class="settings-mini-tag tone-blue" style="margin-left:4px;">本机</span>`
                          : ''}
                      </div>
                      <div style="font-size:11px;color:var(--muted);margin-top:2px;">
                        IP: <code>${deps.esc(dev.ip || '-')}</code> · 最近活跃 ${deps.formatTime(dev.lastSeen || dev.approvedAt)}
                      </div>
                    </div>
                    <button type="button" class="pill-action-btn" style="color:var(--red);padding:4px 8px;font-size:11px;" onclick="revokeTrustedDeviceById('${deps.escJsStr(dev.id)}')">踢出</button>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="settings-item" style="display:block;">
            <div class="settings-item-title">
              ${secSum.total24h > 0
                ? `<span style="color:var(--red);">近 24 小时已拦截 ${secSum.total24h} 次异常探测（${secSum.uniqueIps24h} 个来源 IP）</span>`
                : `<span style="color:var(--green);">运行安全 · 近 24 小时 0 次攻击探测</span>`}
            </div>
            <div class="settings-item-desc" style="margin-top:4px;">
              监测伪造令牌、敏感路径探测（403）、密码爆破（429）与未审批设备直连，命中后立即推送到你的手机锁屏。
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button type="button" class="pill-action-btn" onclick="sendTestSecurityAlert()">演练告警</button>
              ${(secSum.recentEvents || []).length > 0
                ? `<button type="button" class="pill-action-btn" onclick="clearSecurityAlerts()">清空日志</button>`
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
                    <div style="padding:8px 10px;border-radius:10px;background:var(--subtle);font-size:11.5px;line-height:1.45;">
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
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="password">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.password)}
        <div class="ios-card">
          <div class="settings-item">
            <div>
              <div class="settings-item-title">添加新手机（6 位免密配对码）</div>
              <div class="settings-item-desc">生成 3 分钟有效的一次性 6 位字母/数字配对码，新手机免输长密码直接解锁</div>
            </div>
            <button type="button" class="pill-action-btn primary" onclick="openPairingCodeSheet()">生成配对码</button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">修改总控台访问密码</div>
              <div class="settings-item-desc">随时更换访问密钥，防止未授权访问</div>
            </div>
            <button type="button" class="pill-action-btn" onclick="promptChangePassword()">修改密码</button>
          </div>
          <div class="settings-item">
            <div>
              <div class="settings-item-title">锁定当前浏览器</div>
              <div class="settings-item-desc">清除本机浏览器缓存的登录凭证</div>
            </div>
            <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="lockAndLogout()">立即锁定</button>
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
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="shares">
        ${renderSubpageHeaderHtml(`${SETTINGS_SUBPAGE_TITLES.shares} (${shares.length})`)}
        <div class="ios-card">
          ${latestShareResults.map(item => `
            <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="settings-item-title">最近生成（来自 ${deps.esc(item.hostName)}）</div>
                <span style="font-size:11.5px;color:var(--muted);">${deps.formatTime(item.at)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--muted);font-family:var(--mono);word-break:break-all;background:var(--subtle);padding:6px 8px;border-radius:8px;">
                ${deps.esc(item.fullUrl)}
              </div>
              <div style="display:flex;gap:8px;">
                <button type="button" class="pill-action-btn primary" onclick="copyCodeText('${deps.escUriJsStr(item.fullUrl)}', '🔗 加密分享链接已复制')">复制完整链接</button>
                <a href="${deps.esc(item.fullUrl)}" target="_blank" rel="noopener" class="pill-action-btn" style="text-decoration:none;display:inline-flex;align-items:center;">打开</a>
              </div>
            </div>
          `).join('')}
          ${shares.length ? shares.slice(0, 20).map(s => `
            <div class="settings-item">
              <div>
                <div class="settings-item-title">${deps.esc(s.title || '加密会话回放')}</div>
                <div class="settings-item-desc">来自 ${deps.esc(s.hostName || s.hostId || '远端电脑')} · ${deps.formatTime(s.createdAt)} · ${deps.formatBytes(s.sizeBytes || 0)}</div>
              </div>
              <button type="button" class="pill-action-btn" style="color:var(--red);" onclick="deleteShareRecord('${deps.escJsStr(s.id || s.shareId)}')">销毁</button>
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
      <div class="settings-wrap ios-settings-wrap ios-subpage-wrap" data-settings-subpage="capabilities">
        ${renderSubpageHeaderHtml(SETTINGS_SUBPAGE_TITLES.capabilities)}
        <div class="ios-card" style="padding:12px 14px;overflow-x:auto;">
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
    const voiceCompact = formatVoiceCompactValue(getVoiceConfig());
    const signature = buildSignature(state, voiceCompact);

    if (signature === lastRenderedKey && viewport.querySelector('.settings-wrap')) {
      syncPushSummaryBadge(state.cachedPushStatusText);
      void deps.refreshPushStatus?.();
      return;
    }

    const prevScrollTop = viewport.scrollTop || 0;
    lastRenderedKey = signature;

    let html = '';
    if (activeSubpage === 'hosts_list') {
      html = renderHostsListSubpageHtml(state);
    } else if (activeSubpage === 'host_detail') {
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
      html = renderHomeHtml(state, voiceCompact);
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
