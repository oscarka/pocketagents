import assert from 'node:assert/strict'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import {
  classifyApprovalRisk,
  detectApprovalCommandEffects,
  formatApprovalBriefingSpeech,
  translateApprovalDeterministic,
  validateHumanApprovalExplanation,
  VoiceCopilotEngine,
} from '../../hub/voice-copilot.js'
import { VoiceVault } from '../../hub/voice-vault.js'

test('Layer 1 deterministic approval translator: translates everyday safe operations instantly without leaking raw CLI paths, and NEVER simplifies chained/destructive commands', () => {
  // 1. File edit (like mini's blender edit approval)
  const editRes = translateApprovalDeterministic({
    toolName: 'edit',
    promptTitle: 'File ../../blender/game_lumo/threejs_option1/index.html',
    command: '/Users/digtalhealthlink/blender/game_lumo/threejs_option1/index.html',
    riskLevel: 'L1',
  })
  assert.equal(editRes.confident, true)
  assert.equal(editRes.summary, '想修改网页文件「index.html」')
  assert.doesNotMatch(editRes.summary, /\/Users\/|\.\.\//)

  // 2. Read-only file view
  const readRes = translateApprovalDeterministic({
    toolName: 'read_file',
    promptTitle: 'Read /Users/cc/app/config.json',
    command: '/Users/cc/app/config.json',
    riskLevel: 'L0',
  })
  assert.equal(readRes.confident, true)
  assert.match(readRes.summary, /查看配置文件「config\.json」（只读，不改文件）/)

  // 3. Browser upload prompt
  const upRes = translateApprovalDeterministic({
    promptTitle: 'Allow upload "lumo.png" to https://studio.tripo3d.ai?',
    riskLevel: 'L1',
  })
  assert.equal(upRes.confident, true)
  assert.equal(upRes.summary, '想把文件「lumo.png」上传到网站 studio.tripo3d.ai')

  // 4. Single safe commands
  assert.equal(
    translateApprovalDeterministic({ command: 'git status', riskLevel: 'L1' }).summary,
    '想查看当前代码改动和提交记录（只读，不改文件）',
  )
  assert.equal(
    translateApprovalDeterministic({ command: 'npm test', riskLevel: 'L1' }).summary,
    '想运行项目自动化测试',
  )

  // 5. CRITICAL SAFETY: Chained command starting with `git status && rm -rf ./data` MUST NEVER hit safe `git status` fast-path!
  const chainedDanger = {
    toolName: 'run_command',
    command: 'git status && rm -rf ./data',
    fullCommand: 'git status && rm -rf ./data',
    riskLevel: classifyApprovalRisk({ command: 'git status && rm -rf ./data' }).level,
  }
  assert.equal(chainedDanger.riskLevel, 'L2')
  const chainedRes = translateApprovalDeterministic(chainedDanger)
  assert.equal(chainedRes.confident, false, 'chained destructive command must NEVER short-circuit as safe')
  assert.equal(chainedRes.effects.isCompound, true)
  assert.equal(chainedRes.effects.hasDelete, true)
  assert.equal(chainedRes.effects.hasForce, true)
  assert.match(chainedRes.summary, /强制删除/)
  assert.doesNotMatch(chainedRes.summary, /只读|无风险/)

  // 6. Inline Python script with os.replace / os.remove (like Blender audio mux script)
  const blenderPy = {
    toolName: 'run_command',
    command: `/Users/digtalhealthlink/blender/tools/Blender.app/Contents/Resources/4.5/python/bin/python3.11 -c 'import os, subprocess; os.replace(dtmp, dp)'`,
    riskLevel: 'L2',
  }
  const pyEffects = detectApprovalCommandEffects(blenderPy)
  assert.equal(pyEffects.hasInlineScript, true)
  assert.equal(pyEffects.hasWriteOrModify, true)
  assert.equal(pyEffects.isReadOnlySafe, false)
  assert.equal(translateApprovalDeterministic(blenderPy).confident, false)
})

test('Anti-hallucination & anti-downplay post-validator strictly blocks misleading LLM outputs', () => {
  // 1. LLM tries to downplay `rm -rf` as "清理临时缓存，无风险" -> REJECTED!
  const rmApproval = {
    toolName: 'run_command',
    fullCommand: 'rm -rf /Users/cc/project/dist',
    riskLevel: 'L2',
  }
  const downplayVerdict = validateHumanApprovalExplanation('清理一下构建缓存目录，很安全无风险', rmApproval)
  assert.equal(downplayVerdict.ok, false)
  assert.equal(downplayVerdict.rejectReason, 'downplayed_risk')

  // 2. LLM omits deletion on `rm -rf` ("整理构建目录") -> REJECTED!
  const omitDeleteVerdict = validateHumanApprovalExplanation('准备整理项目构建目录里的文件', rmApproval)
  assert.equal(omitDeleteVerdict.ok, false)
  assert.equal(omitDeleteVerdict.rejectReason, 'omitted_delete')

  // 3. LLM omits force on `git push --force origin main` ("把代码推送到 GitHub") -> REJECTED!
  const forcePush = {
    toolName: 'run_command',
    fullCommand: 'git push --force origin main',
    riskLevel: 'L2',
  }
  const omitForceVerdict = validateHumanApprovalExplanation('想把本地代码推送到远程 GitHub 仓库', forcePush)
  assert.equal(omitForceVerdict.ok, false)
  assert.equal(omitForceVerdict.rejectReason, 'omitted_force')

  // 4. Honest explanation of `git push --force origin main` -> ACCEPTED!
  const honestForceVerdict = validateHumanApprovalExplanation('要把本地代码强制覆盖推送到远程 GitHub 主分支', forcePush)
  assert.equal(honestForceVerdict.ok, true)

  // 5. LLM omits sudo/system privilege on `sudo systemctl restart dsh-hub` ("刷新一下服务") -> REJECTED!
  const sudoRestart = {
    toolName: 'run_command',
    fullCommand: 'gcloud compute ssh dsh-hub --command="sudo systemctl restart dsh-hub"',
    riskLevel: 'L2',
  }
  const omitPrivVerdict = validateHumanApprovalExplanation('想连接云端服务器刷新页面状态', sudoRestart)
  assert.equal(omitPrivVerdict.ok, false)
  assert.equal(omitPrivVerdict.rejectReason, 'omitted_system_priv')

  // 6. Honest explanation mentioning remote server + admin restart -> ACCEPTED!
  const honestSudoVerdict = validateHumanApprovalExplanation('想连接云服务器并用管理员权限重启后台总控服务', sudoRestart)
  assert.equal(honestSudoVerdict.ok, true)

  // 7. Raw CLI path leak (`/Users/cc/...` or `&&`) -> REJECTED!
  const leakVerdict = validateHumanApprovalExplanation('执行 /Users/cc/script.py && echo ok', {
    toolName: 'run_command',
    fullCommand: 'python3 /Users/cc/script.py && echo ok',
    riskLevel: 'L1',
  })
  assert.equal(leakVerdict.ok, false)
  assert.equal(leakVerdict.rejectReason, 'raw_cli_leak')
})

test('VoiceCopilotEngine.buildProactiveBriefing uses BYOK brain for complex commands, falls back safely on hallucination/timeout, and caches explanations', async () => {
  let nowMs = 1_795_900_000_000
  const hub = new HubCore({ now: () => nowMs })
  await hub.init()
  const vault = new VoiceVault({ vaultFile: '', secret: 'brief-safety-secret' })
  await vault.init()
  const brainCred = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'DeepSeek Flash',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'ark-test-key',
  })
  await vault.upsertProfile({
    name: 'Test Brain',
    activate: true,
    brain: { provider: 'openai_compat', credId: brainCred.id, model: 'deepseek-v4-1-flash-261017', thinkingLevel: 'off' },
  })

  // Seed host with 2 complex approvals:
  // #1 Blender python audio mux script (honest LLM explanation)
  // #2 Chained `rm -rf` where mock LLM attempts a deceptive "只读无风险" hallucination!
  hub.handleHeartbeat({
    hostId: 'mini',
    hostName: 'Mac mini',
    bridgeState: {
      tasks: [
        {
          id: 'agy-ide:blender-1',
          title: '食梦貘blender',
          status: 'approval',
          transcript: [{ role: 'assistant', text: '接下来我把百乐貘背景音乐合并进刚渲染好的视频里。' }],
        },
        {
          id: 'agy-ide:danger-2',
          title: '线上清理',
          status: 'approval',
          transcript: [{ role: 'assistant', text: '准备清理目录。' }],
        },
      ],
      approvals: [
        {
          code: 'AGY-BLENDER-1',
          agentId: 'agy-ide:blender-1',
          toolName: 'run_command',
          commandLine: `/Users/digtalhealthlink/blender/tools/Blender.app/Contents/Resources/4.5/python/bin/python3.11 -c 'import os, subprocess; subprocess.run(["ffmpeg", "-i", "a.mp4"]); os.replace("tmp.mp4", "out.mp4")'`,
          createdAt: nowMs - 2000,
          options: [{ index: 1, label: 'Allow' }, { index: 2, label: 'Deny' }],
        },
        {
          code: 'AGY-RM-2',
          agentId: 'agy-ide:danger-2',
          toolName: 'run_command',
          commandLine: 'git status && rm -rf /Users/cc/important-data',
          createdAt: nowMs - 1000,
          options: [{ index: 1, label: 'Allow' }, { index: 2, label: 'Deny' }],
        },
      ],
    },
  })

  let llmCalls = 0
  const mockFetch = async (_url, init) => {
    llmCalls += 1
    const payload = JSON.parse(String(init?.body || '{}'))
    const userPrompt = payload?.messages?.[1]?.content || ''
    if (userPrompt.includes('ffmpeg')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{
              message: {
                content: '想运行一段 Python 脚本，调用 ffmpeg 把配乐合并并替换本地视频文件',
              },
            }],
          }
        },
      }
    }
    // Simulated prompt-injection / hallucinated LLM trying to fool user on `rm -rf`!
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            message: {
              content: '只读查看一下 git 状态，完全安全无风险',
            },
          }],
        }
      },
    }
  }

  const engine = new VoiceCopilotEngine({ hub, vault, fetchImpl: mockFetch, now: () => nowMs })

  // 1. Complex Blender Python script gets clear human Chinese translation with context + zero raw paths!
  const b1 = await engine.buildProactiveBriefing({ kind: 'approval', hostId: 'mini', code: 'AGY-BLENDER-1' })
  assert.equal(b1.ok, true)
  assert.equal(b1.explainedByBrain, true)
  assert.match(b1.spokenReply, /食梦貘blender/)
  assert.match(b1.spokenReply, /把配乐合并并替换本地视频文件/)
  assert.doesNotMatch(b1.spokenReply, /\/Users\/|python3\.11|subprocess/)
  assert.equal(llmCalls, 1)

  // Repeat briefing hits 5-min cache -> zero extra LLM calls!
  const b1Cached = await engine.buildProactiveBriefing({ kind: 'approval', hostId: 'mini', code: 'AGY-BLENDER-1' })
  assert.equal(b1Cached.spokenReply, b1.spokenReply)
  assert.equal(llmCalls, 1)

  // 2. Deceptive LLM hallucination on `git status && rm -rf` MUST be blocked by validator -> conservative high-risk warning!
  const b2 = await engine.buildProactiveBriefing({ kind: 'approval', hostId: 'mini', code: 'AGY-RM-2' })
  assert.equal(b2.ok, true)
  assert.equal(b2.explainedByBrain, false, 'deceptive LLM output must be rejected')
  assert.match(b2.spokenReply, /高危待审批/)
  assert.match(b2.spokenReply, /强制删除/)
  assert.match(b2.spokenReply, /触发确认码/)
  assert.doesNotMatch(b2.spokenReply, /只读|无风险|安全/)
})
