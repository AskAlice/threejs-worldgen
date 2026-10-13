// Tests for the flywheel hook: node --test .claude/hooks/flywheel.test.mjs
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'flywheel-'))
process.env.FLYWHEEL_DIR = dir
const fw = await import('./flywheel.mjs')
const fbm = await import('./flywheel-feedback.mjs')
const rules = JSON.parse(readFileSync(join(here, 'flywheel-sideflows.json'), 'utf8')).rules
const SECRET = 'the login page crashes with a stack trace when the email has a plus sign zebra42'

beforeEach(() => { for (const f of ['flywheel-state.json', 'flywheel-feedback.json', 'flywheel-hook.log']) rmSync(join(dir, f), { force: true }) })

/** Runs the hook as a subprocess with the given stdin and optional mode. */
function run(stdin, mode, env = {}) {
  return execFileSync('node', [join(here, 'flywheel.mjs'), ...(mode ? [mode] : [])], { input: stdin, encoding: 'utf8', env: { ...process.env, FLYWHEEL_DIR: dir, ...env } })
}
const fresh = () => ({ stage: 'none', sessions: {} })
const emptyFb = () => ({ rules: {}, flowMisses: {} })
const prompt = (state, p, sid = 's1', fb = emptyFb()) => fw.handlePrompt(state, fb, rules, sid, p)

test('next-command table: every row', () => {
  const rows = { none: '/triage', '/setup-matt-pocock-skills': '/triage', '/triage': '/implement', '/grill-with-docs': '/to-spec', '/grill-me': '/to-spec', '/wayfinder': '/to-spec', '/improve-codebase-architecture': '/to-spec', '/prototype': '/grill-with-docs', '/to-spec': '/to-tickets', '/to-tickets': '/implement', '/implement': '/pr', '/implement-spec': '/pr', '/diagnosing-bugs': '/pr', '/code-review': '/pr', '/pr': '/retro', '/retro': '/triage' }
  for (const [cmd, next] of Object.entries(rows)) {
    const s = cmd === 'none' ? fresh() : prompt(fresh(), cmd).state
    assert.equal(fw.nextFor(s.stage), next, cmd)
  }
  // /handoff and /wait-what leave the stage unchanged.
  for (const cmd of ['/handoff', '/wait-what']) {
    const s = prompt(prompt(fresh(), '/to-spec').state, cmd).state
    assert.equal(s.stage, '/to-spec')
  }
})

test('plugin-prefixed commands count', () => {
  assert.equal(fw.parseCommand('/mattpocock-skills:to-spec please'), '/to-spec')
  assert.equal(prompt(fresh(), '/mattpocock-skills:to-tickets').state.stage, '/to-tickets')
})

test('non-flywheel prompts leave the stage unchanged', () => {
  const s = prompt(fresh(), '/to-spec').state
  assert.equal(prompt(s, 'please rename this variable to something clearer').state.stage, '/to-spec')
  assert.equal(prompt(s, '/compact').state.stage, '/to-spec')
  assert.equal(fw.parseCommand('/compact'), null)
})

test('full display on a flywheel command, one line otherwise, bold next', () => {
  const a = prompt(fresh(), '/triage')
  assert.ok(a.systemMessage.split('\n').length <= 3)
  assert.match(a.systemMessage, /\[\/triage\]/)
  assert.match(a.systemMessage, /\*\*\/implement\*\*/)
  const b = prompt(a.state, 'tidy up the readme wording a little')
  assert.equal(b.systemMessage.split('\n').length, 1)
  assert.match(b.systemMessage, /^flywheel: at \/triage · next: \*\*\/implement\*\*/)
  assert.ok(b.additionalContext.split('\n').length <= 15)
})

test('missing or corrupt state falls back to "none yet"', () => {
  assert.equal(fw.loadState().stage, 'none')
  writeFileSync(join(dir, 'flywheel-state.json'), '{not json')
  assert.equal(fw.loadState().stage, 'none')
  const out = JSON.parse(run(JSON.stringify({ session_id: 'x', prompt: 'make the button a little bigger please' })))
  assert.match(out.systemMessage, /at none yet · next: \*\*\/triage\*\*/)
})

test('malformed stdin exits 0 silently', () => {
  assert.equal(run('this is not json'), '')
  assert.equal(run(''), '')
  assert.equal(run('{bad', 'posttool'), '')
})

test('each side-flow rule matches its example signals', () => {
  const examples = {
    'hard-bug': 'the export crashes with a stack trace on save',
    'too-big': 'we need a full rewrite of the renderer soon',
    architecture: 'this module is a tangled mess, time to refactor it',
    'design-question': 'make a quick mockup of the settings panel',
    'context-full': 'we are running out of context, wrap up',
    confused: 'what do you mean by floating origin here',
    idea: 'should we split the sky package in two',
    review: 'please review this before i merge it',
  }
  for (const r of rules) assert.deepEqual(fw.matchRules(examples[r.id], rules).map((x) => x.id).includes(r.id), true, r.id)
  assert.equal(fw.matchRules('add a debugger option', rules).some((r) => r.id === 'hard-bug'), false) // whole words only
})

test('no suggestion for slash commands, short prompts, or during the cooldown', () => {
  assert.doesNotMatch(prompt(fresh(), '/implement the crash fix').systemMessage, /maybe/)
  assert.doesNotMatch(prompt(fresh(), 'crash bug here').systemMessage, /maybe/)
  let s = fresh()
  const first = prompt(s, SECRET); s = first.state
  assert.match(first.systemMessage, /maybe: \*\*\/diagnosing-bugs\*\*/)
  for (let i = 0; i < 4; i++) { const r = prompt(s, 'another crash with an error message appeared'); s = r.state; assert.doesNotMatch(r.systemMessage, /diagnosing-bugs/) }
  const after = prompt(s, 'yet another crash with an error message appeared')
  assert.match(after.systemMessage, /diagnosing-bugs/) // cooldown over after 5 prompts
})

test('missing or invalid rules file: no suggestions, WARNING logged', () => {
  const bad = join(dir, 'bad-rules.json'); writeFileSync(bad, '{"rules": 5}')
  const out = JSON.parse(run(JSON.stringify({ session_id: 'x', prompt: SECRET }), undefined, { FLYWHEEL_RULES: bad }))
  assert.doesNotMatch(out.systemMessage, /maybe/)
  assert.match(readFileSync(join(dir, 'flywheel-hook.log'), 'utf8'), /WARNING side-flow rules unavailable/)
  const missing = JSON.parse(run(JSON.stringify({ session_id: 'x', prompt: SECRET }), undefined, { FLYWHEEL_RULES: join(dir, 'nope.json') }))
  assert.doesNotMatch(missing.systemMessage, /maybe/)
})

test('prompt text never reaches the state file or the log', () => {
  run(JSON.stringify({ session_id: 'p', prompt: SECRET }))
  run('garbage')
  run(JSON.stringify({ session_id: 'p', prompt: SECRET }), undefined, { FLYWHEEL_RULES: join(dir, 'nope.json') })
  for (const f of ['flywheel-state.json', 'flywheel-hook.log']) {
    if (existsSync(join(dir, f))) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /zebra42|plus sign/)
  }
})

/** A PostToolUse payload for a "Side flow" question, with the answer in tool_input.answers or tool_response. */
const post = (answer, where = 'input', sid = 'f') => {
  const q = 'This sounds like a hard bug. Run /diagnosing-bugs?'
  return JSON.stringify({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q, header: 'Side flow', options: [{ label: 'Yes, switch' }, { label: 'No, just do it' }] }], ...(where === 'input' ? { answers: { [q]: answer } } : {}) }, tool_response: where === 'response' ? `User has answered your questions: "${q}"="${answer}". You can now continue.` : {} })
}
const seedPending = (sid = 'f') => run(JSON.stringify({ session_id: sid, prompt: SECRET }))
const feedback = () => JSON.parse(readFileSync(join(dir, 'flywheel-feedback.json'), 'utf8'))

test('feedback from PostToolUse: accepted, declined, redirected', () => {
  seedPending(); run(post('Yes, switch'), 'posttool')
  assert.equal(feedback().rules['hard-bug'].outcomes.at(-1).o, 'accepted')
  seedPending('f2'); run(post('No, just do it', 'response', 'f2'), 'posttool')
  assert.equal(feedback().rules['hard-bug'].outcomes.at(-1).o, 'declined')
  seedPending('f3'); run(post('no, this is /wayfinder because it is huge zebra42', 'input', 'f3'), 'posttool')
  const last = feedback().rules['hard-bug'].outcomes.at(-1)
  assert.deepEqual([last.o, last.to], ['redirected', '/wayfinder'])
  assert.doesNotMatch(readFileSync(join(dir, 'flywheel-feedback.json'), 'utf8'), /zebra42|because|plus sign/)
})

test('feedback from the CLI fallback', () => {
  execFileSync('node', [join(here, 'flywheel.mjs'), 'feedback', '--rule', 'review', '--outcome', 'declined'], { env: { ...process.env, FLYWHEEL_DIR: dir } })
  execFileSync('node', [join(here, 'flywheel.mjs'), 'feedback', '--rule', 'review', '--outcome', 'redirected', '--to', '/pr'], { env: { ...process.env, FLYWHEEL_DIR: dir } })
  assert.deepEqual(feedback().rules.review.outcomes.map((o) => o.o), ['declined', 'redirected'])
  const stats = run('', 'stats')
  assert.match(stats, /review/)
})

test('thresholds: muted, strong, redirected; the 20-outcome window lets a muted rule recover', () => {
  const p = join(dir, 'flywheel-feedback.json')
  for (let i = 0; i < 5; i++) fbm.recordOutcome(p, 'idea', 'declined')
  assert.equal(fbm.scoreRule(fbm.loadFeedback(p), 'idea').status, 'muted')
  assert.doesNotMatch(prompt(fresh(), 'should we split the sky package in two', 's', fbm.loadFeedback(p)).systemMessage, /maybe/)
  for (let i = 0; i < 20; i++) fbm.recordOutcome(p, 'idea', 'accepted')
  assert.equal(fbm.scoreRule(fbm.loadFeedback(p), 'idea').status, 'strong')
  for (let i = 0; i < 3; i++) fbm.recordOutcome(p, 'architecture', 'redirected', '/wayfinder')
  const s = fbm.scoreRule(fbm.loadFeedback(p), 'architecture')
  assert.deepEqual([s.status, s.redirectTo], ['redirected', '/wayfinder'])
  assert.match(prompt(fresh(), 'this module is a tangled mess, time to refactor it', 's', fbm.loadFeedback(p)).systemMessage, /maybe: \*\*\/wayfinder\*\*/)
})

test('miss detection: flag after an unsuggested prompt, never after a suggested one', () => {
  const misses = []
  let s = fresh()
  s = fw.handlePrompt(s, emptyFb(), rules, 'm', 'the colours on the map look a bit off today', (f) => misses.push(f)).state
  const r = fw.handlePrompt(s, emptyFb(), rules, 'm', '/diagnosing-bugs', (f) => misses.push(f))
  assert.deepEqual(misses, ['/diagnosing-bugs'])
  assert.match(r.additionalContext, /Missed side flow/)
  const misses2 = []
  let t = fw.handlePrompt(fresh(), emptyFb(), rules, 'n', SECRET, (f) => misses2.push(f)).state
  fw.handlePrompt(t, emptyFb(), rules, 'n', '/diagnosing-bugs', (f) => misses2.push(f))
  assert.deepEqual(misses2, [])
})

test('malformed payload or corrupt feedback file are harmless', () => {
  writeFileSync(join(dir, 'flywheel-feedback.json'), '{corrupt')
  assert.deepEqual(fbm.loadFeedback(join(dir, 'flywheel-feedback.json')), { rules: {}, flowMisses: {} })
  assert.equal(run(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: 5 }), 'posttool'), '')
  assert.equal(fw.handlePostTool({ tool_name: 'Bash' }), false)
  const out = JSON.parse(run(JSON.stringify({ session_id: 'c', prompt: SECRET })))
  assert.match(out.systemMessage, /diagnosing-bugs/)
})
