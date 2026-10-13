// Side-flow feedback: records how the user answered side-flow questions and scores each keyword rule.
// Stores only rule IDs, outcomes, target flow names and timestamps — never prompt text or free-text answers.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

/** Outcomes considered per rule (older ones fade out). */
export const WINDOW = 20

/** Loads the feedback file; a missing or corrupt file means "no feedback yet". */
export function loadFeedback(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || typeof data !== 'object' || typeof data.rules !== 'object') throw new Error('bad shape')
    data.flowMisses ??= {}
    return data
  } catch {
    return { rules: {}, flowMisses: {} }
  }
}

/** Writes JSON atomically: temp file, then rename over the original. */
export function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1))
  renameSync(tmp, path)
}

/** Records one outcome (`accepted`, `declined` or `redirected` with a target flow) for a rule. */
export function recordOutcome(path, rule, outcome, to, now = Date.now()) {
  if (!['accepted', 'declined', 'redirected'].includes(outcome)) throw new Error(`unknown outcome ${outcome}`)
  const fb = loadFeedback(path)
  const r = (fb.rules[rule] ??= { outcomes: [], misses: 0 })
  r.outcomes.push(outcome === 'redirected' ? { t: now, o: outcome, to: normaliseFlow(to) } : { t: now, o: outcome })
  r.outcomes = r.outcomes.slice(-WINDOW)
  writeAtomic(path, fb)
  return fb
}

/** Records a miss: the user ran a side-flow command right after a prompt that got no suggestion. */
export function recordMiss(path, flow, now = Date.now()) {
  const fb = loadFeedback(path)
  const f = normaliseFlow(flow)
  fb.flowMisses[f] = { count: (fb.flowMisses[f]?.count ?? 0) + 1, last: now }
  writeAtomic(path, fb)
  return fb
}

/** Reduces a free-text or slash answer to a bare flow name like `/wayfinder` (or null). */
export function normaliseFlow(s) {
  const m = /\/(?:[\w-]+:)?([a-z][\w-]*)/i.exec(String(s ?? ''))
  return m ? `/${m[1].toLowerCase()}` : null
}

/**
 * Scores a rule over its last WINDOW outcomes. score = (accepted + 1) / (asked + 2).
 * muted: ≥5 asks and score < 0.25 · strong: score ≥ 0.75 · redirect: a flow the rule was redirected to ≥3 times.
 */
export function scoreRule(fb, rule) {
  const outs = (fb.rules?.[rule]?.outcomes ?? []).slice(-WINDOW)
  const asked = outs.length
  const accepted = outs.filter((o) => o.o === 'accepted').length
  const declined = outs.filter((o) => o.o === 'declined').length
  const redirects = {}
  for (const o of outs) if (o.o === 'redirected' && o.to) redirects[o.to] = (redirects[o.to] ?? 0) + 1
  const [redirectTo, redirectCount] = Object.entries(redirects).sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
  const score = (accepted + 1) / (asked + 2)
  const status = redirectCount >= 3 ? 'redirected' : asked >= 5 && score < 0.25 ? 'muted' : score >= 0.75 ? 'strong' : 'normal'
  return { asked, accepted, declined, redirected: outs.length - accepted - declined, score, status, redirectTo: redirectCount >= 3 ? redirectTo : null }
}

/** One stats row per rule plus misses, for `flywheel.mjs stats`. */
export function statsTable(fb, rules) {
  return rules.map((r) => {
    const s = scoreRule(fb, r.id)
    return { rule: r.id, flow: r.flow, asks: s.asked, accepts: s.accepted, declines: s.declined, redirects: s.redirected, misses: fb.flowMisses?.[r.flow]?.count ?? 0, score: Number(s.score.toFixed(2)), status: s.status + (s.redirectTo ? ` → ${s.redirectTo}` : '') }
  })
}
