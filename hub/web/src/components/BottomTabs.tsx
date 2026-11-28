import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

function countPendingApprovals(hubState: any): number {
  const hosts = Array.isArray(hubState?.hosts) ? hubState.hosts : [];
  let total = 0;
  for (const h of hosts) {
    if (!h?.online) continue;
    const apps = Array.isArray(h?.bridgeState?.approvals) ? h.bridgeState.approvals : [];
    total += apps.length;
  }
  return total;
}

export function BottomTabs() {
  const [walkState, setWalkState] = useState<{ active: boolean; phase: string }>({
    active: Boolean((window as any).__dshWalkModeOpen),
    phase: 'idle',
  });
  const [approvalCount, setApprovalCount] = useState(() =>
    countPendingApprovals((window as any).__dshLastHubState),
  );

  useEffect(() => {
    const onWalk = (ev: any) => {
      const d = ev?.detail || {};
      setWalkState({ active: Boolean(d.active), phase: String(d.phase || 'idle') });
    };
    const onHub = (ev: any) => {
      setApprovalCount(countPendingApprovals(ev?.detail || (window as any).__dshLastHubState));
    };
    window.addEventListener('dsh:walk-state', onWalk);
    window.addEventListener('dsh:hub-state', onHub);
    return () => {
      window.removeEventListener('dsh:walk-state', onWalk);
      window.removeEventListener('dsh:hub-state', onHub);
    };
  }, []);

  return (
    <footer class="bottom-tabs">
      <button
        type="button"
        class="tab-btn active"
        id="tab-chats"
        onClick={() => (window as any).switchTab?.('chats')}
      >
        <span class="icon">💬</span>
        <span>对话</span>
      </button>

      {/* 中间 C 位大号 AI 通管图标按钮（无多余文字标签，对标 Mini Health 悬浮中控位） */}
      <button
        type="button"
        class={`tab-btn tab-ai-hero ${walkState.active ? `is-live phase-${walkState.phase}` : ''}`}
        id="tab-ai"
        aria-label="AI"
        title="AI 指挥中枢"
        onClick={() => (window as any).switchTab?.('ai')}
      >
        <span class={`tab-ai-orb ${walkState.active ? `is-live phase-${walkState.phase}` : ''}`}>
          <svg class="tab-ai-bot-svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="3" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M9 13v2" />
            <path d="M15 13v2" />
          </svg>
          <svg class="tab-ai-sparkle-svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l2.1 5.9L20 10l-5.9 2.1L12 18l-2.1-5.9L4 10l5.9-2.1L12 2z" />
          </svg>
          {approvalCount > 0 ? (
            <span class="tab-ai-badge">{approvalCount > 9 ? '9+' : approvalCount}</span>
          ) : walkState.active ? (
            <span class="tab-ai-live-dot" />
          ) : null}
        </span>
      </button>

      <button
        type="button"
        class="tab-btn"
        id="tab-settings"
        onClick={() => (window as any).switchTab?.('settings')}
      >
        <span class="icon">⚙️</span>
        <span>设备与设置</span>
      </button>
    </footer>
  );
}

