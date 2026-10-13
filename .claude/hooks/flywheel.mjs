// Skills flywheel hook.
//   node flywheel.mjs               UserPromptSubmit hook (reads the hook JSON on stdin)
//   node flywheel.mjs posttool      PostToolUse hook for AskUserQuestion: records "Side flow" answers
//   node flywheel.mjs feedback --rule <id> --outcome <accepted|declined|redirected> [--to /<flow>]
//   node flywheel.mjs stats         per-rule asks, accepts, declines, redirects, misses, score, status
// Never blocks a prompt: every error exits 0 silently and is appended to .claude/flywheel-hook.log.
// Never stores prompt text: state and feedback hold only stage names, rule IDs and timestamps.
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFeedback, writeAtomic, recordOutcome, recordMiss, normaliseFlow, scoreRule, statsTable } from './flywheel-feedback.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const claudeDir = process.env.FLYWHEEL_DIR ?? join(here, '..')
/** File locations (overridable with FLYWHEEL_DIR / FLYWHEEL_RULES for tests). */
export const paths = {
  state: join(claudeDir, 'flywheel-state.json'),
  feedback: join(claudeDir, 'flywheel-feedback.json'),
  log: join(claudeDir, 'flywheel-hook.log'),
  rules: process.env.FLYWHEEL_RULES ?? join(here, 'flywheel-sideflows.json'),
}

/** The main loop, in order. */
export const LOOP = ['/triage', '/grill-with-docs', '/to-spec', '/to-tickets', '/implement', '/pr', '/retro']
/** Side flows: when each fits, and whether the agent can invoke it itself. */
export const SIDE = {
  '/wayfinder': { when: 'work too big for one session; feeds /to-spec', self: false },
  '/improve-codebase-architecture': { when: 'run every few days; feeds /to-spec', self: false },
  '/diagnosing-bugs': { when: 'hard bugs; feeds /pr', self: true },
  '/prototype': { when: 'design questions mid-grill; returns to /grill-with-docs', self: true },
  '/implement-spec': { when: 'parallel alternative to /implement', self: false },
  '/code-review': { when: 'runs inside /implement; on its own it feeds /pr', self: true },
  '/handoff': { when: 'context is full; does not change the stage', self: false },
  '/grill-me': { when: 'usable anytime for ideas and plans', self: false },
  '/wait-what': { when: 'usable anytime when confused; does not change the stage', self: false },
}
/** Last flywheel command → suggested next command. `null` means "unchanged". */
export const NEXT = {
  none: '/triage', '/setup-matt-pocock-skills': '/triage',
  '/triage': '/implement',
  '/grill-with-docs': '/to-spec', '/grill-me': '/to-spec', '/wayfinder': '/to-spec', '/improve-codebase-architecture': '/to-spec',
  '/prototype': '/grill-with-docs',
  '/to-spec': '/to-tickets',
  '/to-tickets': '/implement',
  '/implement': '/pr', '/implement-spec': '/pr', '/diagnosing-bugs': '/pr', '/code-review': '/pr',
  '/pr': '/retro',
  '/retro': '/triage',
  '/handoff': null, '/wait-what': null,
}
/** Every command name the hook recognises (fixed allowlist; prompt text is never executed). */
export const ALLOW = new Set([...LOOP, ...Object.keys(SIDE), '/setup-matt-pocock-skills'])
const COOLDOWN = 5

/** Appends an error line to the hook log (never prompt text). */
function logError(where, err) {
  try { appendFileSync(paths.log, `${new Date().toISOString()} ERROR ${where}: ${String(err?.message ?? err).slice(0, 300)}\n`) } catch {}
}
/** Appends a warning line to the hook log. */
function logWarn(msg) {
  try { appendFileSync(paths.log, `${new Date().toISOString()} WARNING ${msg}\n`) } catch {}
}

/** Loads the per-developer state; a missing or corrupt file falls back to "none yet". */
export function loadState() {
  try {
    const s = JSON.parse(readFileSync(paths.state, 'utf8'))
    if (!s || typeof s !== 'object' || typeof s.stage !== 'string') throw new Error('bad shape')
    s.sessions ??= {}
    return s
  } catch {
    return { stage: 'none', sessions: {} }
  }
}

/** Loads side-flow rules; returns [] (and logs a WARNING) when the file is missing or invalid. */
export function loadRules() {
  try {
    const data = JSON.parse(readFileSync(paths.rules, 'utf8'))
    if (!Array.isArray(data.rules) || !data.rules.every((r) => r.id && r.flow && Array.isArray(r.signals))) throw new Error('invalid rules')
    return data.rules
  } catch (e) {
    logWarn(`side-flow rules unavailable: ${e.message}`)
    return []
  }
}

/** Detects a leading flywheel command, with or without a plugin prefix (`/mattpocock-skills:to-spec`). */
export function parseCommand(prompt) {
  const m = /^\s*\/(?:[\w-]+:)?([a-z][\w-]*)/i.exec(String(prompt ?? ''))
  if (!m) return null
  const cmd = `/${m[1].toLowerCase()}`
  return ALLOW.has(cmd) ? cmd : null
}

/** The suggested next command for a stage. */
export function nextFor(stage) {
  return NEXT[stage] ?? '/triage'
}

/** Escapes text for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rules whose signals appear in the prompt as whole words or phrases (case-insensitive). */
export function matchRules(prompt, rules) {
  const text = String(prompt ?? '').toLowerCase().replace(/[’]/g, "'")
  return rules.filter((r) => r.signals.some((s) => new RegExp(`(^|[^\\w'])${esc(s.toLowerCase())}(?=$|[^\\w'])`).test(text)))
}

/** Words in a prompt. */
const wordCount = (p) => String(p ?? '').trim().split(/\s+/).filter(Boolean).length

/**
 * Pure core: given state, feedback, rules and the submitted prompt, returns the new state and the hook
 * output ({ systemMessage, additionalContext }). Records misses through the `onMiss` callback.
 */
export function handlePrompt(state, fb, rules, sessionId, prompt, onMiss = () => {}) {
  const sid = String(sessionId ?? 'default')
  const sess = (state.sessions[sid] ??= { n: 0, suggested: [], last: null })
  sess.n += 1
  const cmd = parseCommand(prompt)
  const isSlash = /^\s*\//.test(String(prompt ?? ''))
  const context = []

  // Miss: a side-flow command right after an ordinary prompt that got no suggestion.
  if (cmd && SIDE[cmd] && sess.last && sess.last.ordinary && !sess.last.suggested) {
    onMiss(cmd)
    context.push(`Missed side flow: the previous prompt looked like a job for ${cmd} but got no suggestion. When ${cmd} is done, propose ONE new keyword rule for .claude/hooks/flywheel-sideflows.json based on that earlier prompt, ask the user before writing it, and if approved add it with "source": "feedback" and today's date.`)
  }

  if (cmd && NEXT[cmd] !== null && NEXT[cmd] !== undefined) state.stage = cmd
  const stage = state.stage
  const next = nextFor(stage)
  const nextText = stage === '/triage' ? `**${next}** (or **/grill-with-docs** if nothing is ready-for-agent)` : `**${next}**`

  // Side-flow hint (not for slash prompts, short prompts, or during the per-session cooldown).
  let hint = null
  if (!isSlash && wordCount(prompt) >= 4) {
    for (const r of matchRules(prompt, rules)) {
      const s = scoreRule(fb, r.id)
      if (s.status === 'muted') continue
      const flow = s.status === 'redirected' && s.redirectTo ? s.redirectTo : r.flow
      const recent = sess.suggested.filter((x) => sess.n - x.n < COOLDOWN && x.flow === flow)
      if (recent.length) continue
      hint = { rule: r.id, flow, strong: s.status === 'strong', remapped: s.status === 'redirected' }
      break
    }
  }
  if (hint) { sess.suggested.push({ n: sess.n, flow: hint.flow, rule: hint.rule, t: Date.now() }); sess.pending = { rule: hint.rule, flow: hint.flow, t: Date.now() } }
  sess.suggested = sess.suggested.filter((x) => sess.n - x.n < COOLDOWN)
  sess.last = { ordinary: !isSlash, suggested: Boolean(hint) }

  // Display.
  const stageLabel = stage === 'none' ? 'none yet' : stage
  let systemMessage
  if (cmd) {
    const loop = LOOP.map((c) => (c === stage ? `[${c}]` : c === next ? `**${c}**` : c)).join(' → ') + ' → ↺'
    systemMessage = [`flywheel: ${loop}`, `next: ${nextText}`, `side: /wayfinder /improve-codebase-architecture /diagnosing-bugs /prototype /implement-spec /code-review /handoff /grill-me /wait-what`].join('\n')
  } else {
    systemMessage = `flywheel: at ${stageLabel} · next: ${nextText}${hint ? ` · maybe: **${hint.flow}**?` : ''}`
  }

  // Context for the model (kept short).
  context.unshift(`Flywheel stage: ${stageLabel}. When this step is done, suggest ${nextText} as the next command.`)
  const catalogue = Object.entries(SIDE).map(([f, v]) => {
    const r = rules.find((x) => x.flow === f)
    const st = r ? scoreRule(fb, r.id).status : 'normal'
    return `${f}: ${v.when}${st === 'muted' ? ' (usually declined: only ask if it\'s unmistakable)' : st === 'strong' ? ' (usually accepted)' : ''}`
  })
  context.push(`Side flows: ${catalogue.join('; ')}.`)
  if (hint) context.push(`Keyword hint: this prompt may fit ${hint.flow}${hint.strong ? ' (strong: ask whenever the signals are present)' : ''}${hint.remapped ? ' (rule usually redirected here)' : ''}. A keyword alone is not enough; judge the whole prompt.`)
  context.push('If a side flow clearly fits an ordinary prompt, ask ONE question before doing any work, with AskUserQuestion header "Side flow" and options "Yes, switch" / "No, just do it". On yes: invoke /diagnosing-bugs, /prototype or /code-review yourself; for the others tell the user to type the command. On no: do the prompt as written and don\'t suggest that flow again this session. Never suggest anything for slash commands or prompts under 4 words.')

  return { state, systemMessage, additionalContext: context.join('\n') }
}

/** Reads the hook's JSON stdin. */
function readStdin() {
  return JSON.parse(readFileSync(0, 'utf8'))
}

/** Finds the user's answer to the "Side flow" question in a PostToolUse payload (input or response). */
export function sideFlowAnswer(payload) {
  const qs = payload?.tool_input?.questions ?? []
  const q = qs.find((x) => x?.header === 'Side flow')
  if (!q) return null
  const answers = payload?.tool_input?.answers ?? payload?.tool_response?.answers
  if (answers && typeof answers === 'object' && answers[q.question] != null) return String(answers[q.question])
  const resp = typeof payload?.tool_response === 'string' ? payload.tool_response : JSON.stringify(payload?.tool_response ?? '')
  const m = new RegExp(`"${esc(q.question)}"\\s*=\\s*"([^"]*)"`).exec(resp) ?? new RegExp(`${esc(q.question)}\\\\?"\\s*=\\s*\\\\?"([^"\\\\]*)`).exec(resp)
  return m ? m[1] : null
}

/** Classifies an answer as accepted, declined or redirected (with only the flow name kept). */
export function classifyAnswer(answer) {
  const a = String(answer ?? '').trim()
  if (/^yes\b/i.test(a)) return { outcome: 'accepted' }
  const to = normaliseFlow(a)
  if (to && ALLOW.has(to)) return { outcome: 'redirected', to }
  return { outcome: 'declined' }
}

/** PostToolUse handler: records the outcome of a "Side flow" question against the pending rule. */
export function handlePostTool(payload) {
  if (payload?.tool_name !== 'AskUserQuestion') return false
  const answer = sideFlowAnswer(payload)
  if (answer == null) return false
  const state = loadState()
  const sid = String(payload.session_id ?? 'default')
  const pending = state.sessions?.[sid]?.pending
  if (!pending) return false
  const { outcome, to } = classifyAnswer(answer)
  recordOutcome(paths.feedback, pending.rule, outcome, to)
  delete state.sessions[sid].pending
  writeAtomic(paths.state, state)
  return true
}

/** Parses `--key value` CLI flags. */
function flags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]
  return out
}

/** Entry point: dispatches on the first CLI argument. */
export function main(argv = process.argv.slice(2)) {
  const mode = argv[0]
  if (mode === 'stats') {
    const rows = statsTable(loadFeedback(paths.feedback), loadRules())
    console.table(rows)
    return
  }
  if (mode === 'feedback') {
    const f = flags(argv.slice(1))
    recordOutcome(paths.feedback, f.rule, f.outcome, f.to)
    const state = loadState()
    for (const s of Object.values(state.sessions)) if (s.pending?.rule === f.rule) delete s.pending
    writeAtomic(paths.state, state)
    console.log(`recorded ${f.outcome} for ${f.rule}`)
    return
  }
  if (mode === 'posttool') {
    try { handlePostTool(readStdin()) } catch (e) { logError('posttool', e) }
    return
  }
  try {
    const input = readStdin()
    const out = handlePrompt(loadState(), loadFeedback(paths.feedback), loadRules(), input.session_id, input.prompt, (flow) => recordMiss(paths.feedback, flow))
    writeAtomic(paths.state, out.state)
    process.stdout.write(JSON.stringify({ systemMessage: out.systemMessage, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.additionalContext } }))
  } catch (e) {
    logError('prompt', e)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main() } catch (e) { logError('main', e) }
  process.exitCode = 0
}
