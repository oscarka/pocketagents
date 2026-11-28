import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import { VoiceCopilotEngine } from '../../hub/voice-copilot.js'
import { VoiceVault } from '../../hub/voice-vault.js'
import {
  classifyVoiceReply,
  parsePlaybackControlFastPath,
  resolveNewWorkspacePath,
  sanitizeWorkspaceFolderName,
} from '../../hub/voice-harness.js'
import { evaluateBargeInUtterance } from '../../hub/web/src/voice/bargeInGate.js'

test('Voice Harness v1: classifyVoiceReply & 0ms playback/queue fast-path resist false triggers', () => {
  // Mini Health-derived affirmation / rejection / hedge classification
  for (const y of ['对', '可以', '行吧', '好的', '确认创建', '对的，对的，就。', 'ok', '没问题']) {
    assert.equal(classifyVoiceReply(y), 'yes', `"${y}" should classify as yes`)
  }
  for (const n of ['不对', '算了', '取消', '不要建', '不行', '先不']) {
    assert.equal(classifyVoiceReply(n), 'no', `"${n}" should classify as no`)
  }
  for (const a of ['等等', '没听清', '再说一遍', '嗯', '行吗']) {
    assert.equal(classifyVoiceReply(a), 'ambiguous', `"${a}" should classify as ambiguous`)
  }
  // Crucial guard: "好的，但是换个目录" MUST NOT classify as yes!
  assert.notEqual(classifyVoiceReply('好的，但是换个目录'), 'yes')
  assert.notEqual(classifyVoiceReply('不对，换mini2'), 'yes')

  // 0ms playback speed & queue navigation
  assert.equal(parsePlaybackControlFastPath('快一点', 1.0)?.speechRate, 1.25)
  assert.equal(parsePlaybackControlFastPath('加速', 1.75)?.speechRate, 2.0)
  assert.equal(parsePlaybackControlFastPath('再加速', 2.0)?.speechRate, 2.0)
  assert.equal(parsePlaybackControlFastPath('慢一点', 1.0)?.speechRate, 0.75)
  assert.equal(parsePlaybackControlFastPath('1.5倍速', 1.0)?.speechRate, 1.5)
  assert.equal(parsePlaybackControlFastPath('恢复原速', 1.5)?.speechRate, 1.0)
  assert.equal(parsePlaybackControlFastPath('下一条', 1.0)?.kind, 'queue_next')
  assert.equal(parsePlaybackControlFastPath('跳过', 1.0)?.kind, 'queue_next')
  assert.equal(parsePlaybackControlFastPath('上一条', 1.0)?.kind, 'queue_prev')
  assert.equal(parsePlaybackControlFastPath('再念一遍', 1.0)?.kind, 'queue_repeat')
  assert.equal(parsePlaybackControlFastPath('暂停播报', 1.0)?.kind, 'queue_pause')
  assert.equal(parsePlaybackControlFastPath('继续播报', 1.0)?.kind, 'queue_resume')
  assert.equal(parsePlaybackControlFastPath('先不聊了', 1.0)?.kind, 'handsfree_pause')
  assert.equal(parsePlaybackControlFastPath('挂断', 1.0)?.kind, 'handsfree_pause')
  assert.equal(parsePlaybackControlFastPath('休息一下', 1.0)?.kind, 'handsfree_pause')
  // Normal task sentences must NOT trigger playback fast-path
  assert.equal(parsePlaybackControlFastPath('帮我给网站提速优化一下', 1.0), null)
  assert.equal(parsePlaybackControlFastPath('新建任务查日志', 1.0), null)

  // Path traversal & workspace folder sanitization
  assert.equal(sanitizeWorkspaceFolderName('../evil/dir'), 'evil-dir')
  assert.equal(resolveNewWorkspacePath(['/Users/cc/deepseekharness-remote', '/Users/cc/mini-health'], 'my-video-app'), '/Users/cc/my-video-app')
  assert.equal(resolveNewWorkspacePath([], 'fresh-app'), '~/fresh-app')

  // Barge-in gate accepts speed/queue commands mid-playback
  for (const cmd of ['快一点', '1.5倍速', '上一条', '重播', '慢一点', '先不聊了', '挂断']) {
    assert.equal(evaluateBargeInUtterance(cmd, '正在播报一条长总结内容').accept, true, `barge-in should accept "${cmd}"`)
  }
})

test('Voice Harness v1: multi-turn new-task validation with NEW workspace creation, mid-draft correction, 0ms commit, and off-topic cancel', async () => {
  const hub = new HubCore()
  await hub.init()
  hub.handleHeartbeat({
    hostId: 'ccdemacbook-air',
    hostName: 'cc的MacBook Air',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      workspaces: ['/Users/cc/deepseekharness-remote', '/Users/cc/mini-health'],
      tasks: [{ id: 't1', title: '语音改造', harness: 'antigravity-ide', status: 'idle', cwd: '/Users/cc/deepseekharness-remote' }],
      approvals: [],
    },
  })
  hub.handleHeartbeat({
    hostId: 'no2demac-mini',
    hostName: 'no2mini',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      workspaces: ['/Users/no2/project-a', '/Users/no2/project-b'],
      tasks: [{ id: 't2', title: '后台任务', harness: 'codex', status: 'idle', cwd: '/Users/no2/project-a' }],
      approvals: [],
    },
  })

  const vault = new VoiceVault({ vaultFile: '', secret: 'test-harness-secret' })
  await vault.init()
  const engine = new VoiceCopilotEngine({ hub, vault })

  // 1. 0ms playback speed fast-path persists speechRate into vault prefs
  const speedRes = await engine.runBrainTurn({ text: '快一点', voiceSessionId: 'vh1' })
  assert.equal(speedRes.ok, true)
  assert.equal(speedRes.fastPath, 'playback_control')
  assert.equal(speedRes.playbackControl.speechRate, 1.25)
  assert.equal(vault.state.prefs.speechRate, 1.25)

  // 2. Multi-turn new task with NEW workspace + mid-draft host switch correction + 0ms commit
  const bareNew = await engine.runBrainTurn({ text: '帮我新建个任务', voiceSessionId: 'vh_bare' })
  assert.equal(bareNew.fastPath, 'draft_start', '"帮我新建个任务" must trigger draft_start immediately')
  assert.equal(bareNew.draftCard.status, 'collecting')
  assert.match(bareNew.spokenReply, /哪台电脑/)

  const s1 = await engine.runBrainTurn({ text: '帮我新建一个任务查一下登录超时', voiceSessionId: 'vh2' })
  assert.equal(s1.fastPath, 'draft_start')
  assert.equal(s1.execution.executed, false)
  assert.equal(s1.draftCard.status, 'collecting')
  assert.match(s1.spokenReply, /哪台电脑/)
  assert.equal(hub.hosts.get('ccdemacbook-air').commands.length, 0)

  const s2 = await engine.runBrainTurn({ text: 'Air，新建工作区叫 login-fix', voiceSessionId: 'vh2' })
  assert.equal(s2.draftCard.status, 'awaiting_confirm')
  assert.equal(s2.draftCard.hostId, 'ccdemacbook-air')
  assert.equal(s2.draftCard.createDir, true)
  assert.equal(s2.draftCard.cwd, '/Users/cc/login-fix')
  assert.match(s2.spokenReply, /新建工作区「login-fix」/)
  assert.match(s2.spokenReply, /确认创建吗/)

  // Correction before confirming: switch host to mini2!
  const s3 = await engine.runBrainTurn({ text: '不对，换 mini2', voiceSessionId: 'vh2' })
  assert.equal(s3.draftCard.status, 'awaiting_confirm')
  assert.equal(s3.draftCard.hostId, 'no2demac-mini')
  assert.equal(s3.draftCard.cwd, '/Users/no2/login-fix')
  assert.equal(s3.draftCard.createDir, true)
  assert.equal(hub.hosts.get('no2demac-mini').commands.length, 0)

  // 0ms deterministic commit on "可以"
  const s4 = await engine.runBrainTurn({ text: '可以', voiceSessionId: 'vh2' })
  assert.equal(s4.fastPath, 'draft_commit')
  assert.equal(s4.execution.executed, true)
  assert.equal(s4.draftCard, null)
  const miniCmds = hub.hosts.get('no2demac-mini').commands
  assert.equal(miniCmds.length, 1)
  assert.equal(miniCmds[0].type, 'new_session')
  assert.equal(miniCmds[0].cwd, '/Users/no2/login-fix')
  assert.equal(miniCmds[0].createDir, true)
  assert.equal(miniCmds[0].prompt, '查一下登录超时')

  // 3. New workspace WITHOUT name yet -> asks name -> bare name reply -> 1-tap screen card confirmation!
  const n1 = await engine.runBrainTurn({ text: '在 Air 上新建工作区写个视频脚本', voiceSessionId: 'vh3' })
  assert.equal(n1.draftCard.hostId, 'ccdemacbook-air')
  assert.equal(n1.draftCard.workspaceMode, 'new')
  assert.equal(n1.draftCard.status, 'collecting')
  assert.match(n1.spokenReply, /叫什么名字/)

  const n2 = await engine.runBrainTurn({ text: 'travel-bot', voiceSessionId: 'vh3' })
  assert.equal(n2.draftCard.status, 'awaiting_confirm')
  assert.equal(n2.draftCard.cwd, '/Users/cc/travel-bot')
  assert.equal(n2.draftCard.createDir, true)

  const n3 = engine.resolveDraftAction({ voiceSessionId: 'vh3', action: 'confirm' })
  assert.equal(n3.ok, true)
  assert.equal(n3.execution.executed, true)
  assert.equal(hub.hosts.get('ccdemacbook-air').commands[0].cwd, '/Users/cc/travel-bot')
  assert.equal(hub.hosts.get('ccdemacbook-air').commands[0].createDir, true)

  // 4. Off-topic interruption while awaiting confirmation safely cancels draft with explicit notice
  await engine.runBrainTurn({ text: '在 Air 上新建工作区叫 temp-demo 帮我跑测试', voiceSessionId: 'vh4' })
  assert.ok(engine.getActiveDraft('vh4'))
  const off = await engine.runBrainTurn({ text: '现在有什么任务进度', voiceSessionId: 'vh4' })
  assert.equal(engine.getActiveDraft('vh4'), null, 'off-topic turn must discard unconfirmed draft')
  assert.match(off.spokenReply, /还没确认，我先不建了/)
  assert.equal(hub.hosts.get('ccdemacbook-air').commands.length, 1, 'no extra task should be created')

  // 5. LLM blind `create_task` guardrail: even if LLM brain emits `create_task`, Harness stages for confirmation!
  const credRes = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'Mock Brain',
    apiKey: 'sk-mock',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'deepseek-v4-1-flash-261017',
  })
  const profRes = await vault.upsertProfile({
    name: 'Mock Brain Prof',
    brain: { provider: 'openai_compat', credId: credRes.credential.id, model: 'deepseek-v4-1-flash-261017' },
  })
  const llmEngine = new VoiceCopilotEngine({
    hub,
    vault,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              spokenReply: '好的，我帮你建好了。',
              action: { type: 'create_task', hostId: 'ccdemacbook-air', prompt: '写一个定时爬虫' },
            }),
          },
        }],
      }),
    }),
  })
  const guarded = await llmEngine.runBrainTurn({
    text: '帮我在 Air 上搞个定时爬虫',
    voiceSessionId: 'vh5',
    profileId: profRes.profile.id,
  })
  assert.equal(guarded.fastPath, 'draft_staged_from_brain')
  assert.equal(guarded.execution.executed, false, 'LLM must NEVER blind-create without workspace validation & confirmation')
  assert.ok(guarded.draftCard)
  assert.match(guarded.spokenReply, /已有项目还是新建工作区/)
})

test('Voice Harness v1 UI contracts: center AI hero icon without text label, docked AI tab, speed pill, queue bar, and draft card', () => {
  const rootDir = resolve(process.cwd())
  const bottomTabsSrc = readFileSync(resolve(rootDir, 'hub/web/src/components/BottomTabs.tsx'), 'utf8')
  const walkSrc = readFileSync(resolve(rootDir, 'hub/web/src/components/VoiceCopilotSheets.tsx'), 'utf8')
  const ctrlSrc = readFileSync(resolve(rootDir, 'hub/web/src/controller.js'), 'utf8')

  assert.match(bottomTabsSrc, /id="tab-ai"/)
  assert.match(bottomTabsSrc, /tab-ai-hero/)
  assert.match(bottomTabsSrc, /tab-ai-orb/)
  assert.doesNotMatch(bottomTabsSrc, /id="tab-files"/, 'tab-files must be replaced by center AI icon tab')
  assert.doesNotMatch(bottomTabsSrc, /<span>项目文件<\/span>/, '项目文件 label must be removed from bottom tabs')
  assert.match(walkSrc, /walkSpeedPillBtn/)
  assert.match(walkSrc, /walk-queue-bar/)
  assert.match(walkSrc, /id="walkDraftCard"/)
  assert.match(walkSrc, /aiTabMount/)
  assert.match(walkSrc, /stayHandsFreeLoop/)
  assert.match(walkSrc, /handsfree_pause/)
  assert.match(walkSrc, /mic_probe/)
  const walkAudioSrc = readFileSync(resolve(rootDir, 'hub/web/src/voice/walkAudio.ts'), 'utf8')
  assert.match(walkAudioSrc, /export class AdaptiveLevelVad/)
  assert.match(walkAudioSrc, /js_vad_agc_plateau/)
  assert.match(ctrlSrc, /tab-ai-active/)
})
