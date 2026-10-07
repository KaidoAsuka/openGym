// A cycle on the phone: the weeks of a Coach plan when they are not all the same week.
//
// The app trains one week and repeats it. A plan from the Coach may instead say what each week is
// done at — sets, reps and the weight of every exercise — for as many weeks as its block runs
// (api/coach/core/cycle.js has the shape, shared with the server so the two cannot disagree about
// what a week holds). This file is what makes the app train it:
//
//   adoptCycle     keeps the weeks in `S.coach.cycle` when the plan is imported
//   projectCycle   writes the current week's numbers into the routines, so the plan screen, the
//                  session start and everything else read an ordinary plan
//   applyLooks     takes in the Coach's daily corrections to the weeks still to come
//   undoLook       takes the latest one back
//
// An exercise whose weight the cycle sets has the app's own progression switched off (`prog:
// 'off'`, which opens a session at the plan's weight): two things must not move the same number.
// One the cycle gives no weight to keeps the policy it was planned with, so a lift with no record
// yet is run by the app until the Coach has something to go on.
//
// The server never writes this state. A correction is an ordinary local edit, synced like any
// other, and the server stops handing it over once it sees its id here (api/coach/adjust.js).
//
// Every function is pure over a draft state `s` (call them inside store.update).
import { numbersAt, cycleWeekOn, cleanChanges, withChanges } from '../../../api/coach/core/cycle.js'
import { todayISO } from './format.js'
import { modeOf } from './history.js'
import { exName } from './coach.js'

// Bounds, for the same reason the log has them (lib/coach.js): the whole state syncs in one body.
export const CYCLE_HISTORY_MAX = 10
export const CYCLE_APPLIED_MAX = 40

const NUMBERS = ['sets', 'reps', 'sec', 'weight']
const clone = v => JSON.parse(JSON.stringify(v))
const pick = e => { const o = {}; NUMBERS.forEach(k => { if (typeof e?.[k] === 'number' && e[k] > 0) o[k] = e[k] }); return o }
const cycleOf = S => (S?.coach?.cycle && typeof S.coach.cycle === 'object' ? S.coach.cycle : null)
const routinesOf = (s, c) => (s.routines || []).filter(r => (c.routines || []).includes(r.id))

/* ============================ taking a cycle on ============================ */

/**
 * Keep a created plan's weeks, and lay the first one out.
 *
 * @param {object} bundle     the plan as the validator passed it (`cycle: { weeks, plan }`)
 * @param {Array} merged      the routines the import just added, in the bundle's order — the import
 *                            gives routines, and exercises the plan invented, ids of their own
 * @param {string} proposalId what the plan was called while it waited, kept as the cycle's id
 */
export function adoptCycle(s, bundle, merged, proposalId, today = todayISO()) {
  if (!s.coach) s.coach = {}
  const src = bundle?.cycle
  // A new plan that repeats one week replaces a cycle as surely as another cycle does.
  if (!src || !Array.isArray(src.plan) || !Number.isInteger(src.weeks) || !(merged || []).length) { s.coach.cycle = null; return null }
  const rid = {}
  const exId = {}
  ;(bundle.routines || []).forEach((r, i) => {
    const mine = merged[i]
    if (!mine) return
    rid[r.id] = mine.id
    exId[r.id] = {}
    ;(r.ex || []).forEach((e, j) => { if (mine.ex?.[j]) exId[r.id][e.id] = mine.ex[j].id })
  })
  const base = {}
  merged.forEach(r => { base[r.id] = {}; (r.ex || []).forEach(e => { base[r.id][e.id] = { ...pick(e), ...(e.prog ? { prog: e.prog } : {}) } }) })
  const plan = src.plan.map(w => ({
    week: w.week,
    ...(w.focus ? { focus: w.focus } : {}),
    ...(w.sessions ? { sessions: w.sessions.filter(x => rid[x.routine]).map(x => ({
      routine: rid[x.routine],
      ex: (x.ex || []).filter(e => exId[x.routine]?.[e.id]).map(e => ({ ...pick(e), id: exId[x.routine][e.id] }))
    })) } : {})
  }))
  s.coach.cycle = {
    id: proposalId || 'cycle', name: String(bundle.name || '').slice(0, 80), startedAt: today, weeks: src.weeks,
    ...(bundle.program?.name ? { program: { id: bundle.program.id, name: String(bundle.program.name).slice(0, 80) } } : {}),
    ...(bundle.own === true ? { own: true } : {}),
    routines: merged.map(r => r.id), base, plan,
    projected: null, applied: [], history: [], lastCheck: null
  }
  projectCycle(s, today, true)
  return s.coach.cycle
}

/* ============================ laying a week out ============================ */

/** The week of the cycle today falls in, held to its last week; null when no cycle runs. */
export function cycleWeek(S, today = todayISO()) {
  const c = cycleOf(S)
  const at = c ? cycleWeekOn(c.startedAt, today) : null
  return at ? Math.min(c.weeks, at) : null
}
/** Whether the last week has been and gone. */
export const cycleOver = (S, today = todayISO()) => { const c = cycleOf(S); const at = c ? cycleWeekOn(c.startedAt, today) : null; return !!(at && at > c.weeks) }
/** Whether the routines hold another week's numbers than today's — the app-open check. */
export const cycleStale = (S, today = todayISO()) => { const w = cycleWeek(S, today); return w != null && cycleOf(S).projected !== w }

/**
 * Write this week's numbers into the routines. Returns whether anything was written.
 * `force` rewrites the week already laid out, after its numbers changed.
 */
export function projectCycle(s, today = todayISO(), force = false) {
  const c = cycleOf(s)
  const week = cycleWeek(s, today)
  if (!c || week == null || (!force && c.projected === week)) return false
  const numbers = numbersAt(c.base, c.plan, week)
  for (const r of routinesOf(s, c)) {
    if (!c.base[r.id]) c.base[r.id] = {}
    for (const e of r.ex || []) {
      // An exercise that joined the routine since — a swap, an addition — becomes the cycle's
      // from here on, standing as it is until a week says otherwise.
      if (!c.base[r.id][e.id]) c.base[r.id][e.id] = { ...pick(e), ...(e.prog ? { prog: e.prog } : {}) }
      const b = c.base[r.id][e.id]
      const x = numbers.get(r.id)?.get(e.id) || {}
      for (const k of ['sets', 'reps', 'sec']) if (x[k] != null) e[k] = x[k]
      if (x.weight != null) { e.weight = x.weight; e.prog = 'off' }
      // No weight from the cycle: the policy it was planned with runs it, as before.
      else if (e.prog === 'off' && b.prog !== 'off') { if (b.prog) e.prog = b.prog; else delete e.prog }
    }
  }
  c.projected = week
  return true
}

/* ============================ the Coach's corrections ============================ */

/** The looks handed over that this cycle has not taken in yet, in order. */
export function freshLooks(S, list) {
  const c = cycleOf(S)
  if (!c || !Array.isArray(list)) return []
  const have = new Set(c.applied || [])
  return list.filter(a => a && typeof a === 'object' && a.id && a.cycle === c.id && !have.has(a.id))
}

/**
 * Take the looks in. A look that changes numbers is checked again here against the routines as
 * they are now — the server checked it against the state it had, and a plan can move in between —
 * and what still fits is laid into the weeks. Returns what happened, one entry per look, for the
 * caller to say in the chat: `{ id, nochange?, manual?, reading?, summary?, changes? }`.
 */
export function applyLooks(s, list, today = todayISO()) {
  const done = []
  for (const a of freshLooks(s, list)) {
    const c = cycleOf(s)
    c.applied = [...(c.applied || []), a.id].slice(-CYCLE_APPLIED_MAX)
    if (a.nochange) {
      c.lastCheck = { at: a.at || Date.now(), reading: String(a.reading || '').slice(0, 600) }
      done.push({ id: a.id, nochange: true, manual: a.manual === true, reading: c.lastCheck.reading })
      continue
    }
    const shape = { weeks: c.weeks, routines: routinesOf(s, c).map(r => ({ id: r.id, ex: (r.ex || []).map(e => ({ id: e.id, mode: modeOf(e), side: !!e.side })) })) }
    const read = cleanChanges({ changes: a.changes, weeks: a.focus }, shape, 1)
    if (!read.changes.length && !read.focus.length) continue
    // What each exercise stood at in its week before this, for the card and nothing else.
    const changes = read.changes.map(ch => {
      const was = numbersAt(c.base, c.plan, ch.week).get(ch.routine)?.get(ch.exId) || {}
      return { ...ch, before: pick(was) }
    })
    // Only the latest correction can be taken back, so only it keeps the weeks as they were.
    ;(c.history || []).forEach(h => { delete h.prev })
    const entry = { id: a.id, at: a.at || Date.now(), summary: String(a.summary || '').slice(0, 600), changes, ...(a.notes?.length ? { notes: a.notes.slice(0, 4).map(n => String(n).slice(0, 300)) } : {}), prev: clone(c.plan) }
    c.history = [...(c.history || []), entry].slice(-CYCLE_HISTORY_MAX)
    c.plan = withChanges(c.plan, read.changes, read.focus)
    c.lastCheck = { at: entry.at, reading: entry.summary }
    projectCycle(s, today, true)
    done.push({ id: a.id, manual: a.manual === true, summary: entry.summary, changes: changes.length })
  }
  return done
}

/** The correction that can still be taken back: the latest one, if it has not been already. */
export function undoable(S) {
  const h = (cycleOf(S)?.history || []).at(-1)
  return h && h.prev && !h.undone ? h : null
}

/** Put the weeks back as they were before the latest correction. Returns whether it did. */
export function undoLook(s, id, today = todayISO()) {
  const c = cycleOf(s)
  const h = undoable(s)
  if (!c || !h || (id && h.id !== id)) return false
  c.plan = h.prev
  delete h.prev
  h.undone = true
  projectCycle(s, today, true)
  return true
}

export const lookEntry = (S, id) => (cycleOf(S)?.history || []).find(h => h.id === id) || null

/* ============================ for the screens ============================ */

function weeksView({ weeks, plan, base, routines, current, names }) {
  const out = []
  for (let n = 1; n <= weeks; n++) {
    const own = (plan || []).find(w => w.week === n) || null
    const numbers = numbersAt(base, plan, n)
    out.push({
      week: n, focus: own?.focus || '', current: n === current,
      // A week with no numbers of its own is trained as the one before it, until it is filled in.
      rough: !own?.sessions?.length && n > 1,
      sessions: routines.map(r => ({
        id: r.id, name: r.name || '',
        ex: (r.ex || []).map(e => ({ id: e.id, name: names(e.id), mode: e.mode || modeOf(e), ...pick(numbers.get(r.id)?.get(e.id) || e) }))
      }))
    })
  }
  return out
}

/** The running cycle as its screen shows it; null when none runs. */
export function cycleView(S, today = todayISO()) {
  const c = cycleOf(S)
  if (!c) return null
  const routines = routinesOf(S, c)
  return {
    id: c.id, name: c.name || '', weeks: c.weeks, week: cycleWeek(S, today), over: cycleOver(S, today),
    program: c.program?.name || null, own: c.own === true,
    rows: weeksView({ weeks: c.weeks, plan: c.plan, base: c.base, routines, current: cycleWeek(S, today), names: exName }),
    lastCheck: c.lastCheck || null,
    history: [...(c.history || [])].reverse()
  }
}

/** A plan that is still waiting to be imported, shown the same way. */
export function bundleCycleView(bundle) {
  const c = bundle?.cycle
  if (!c || !Array.isArray(c.plan)) return null
  const base = {}
  ;(bundle.routines || []).forEach(r => { base[r.id] = {}; (r.ex || []).forEach(e => { base[r.id][e.id] = pick(e) }) })
  return { weeks: c.weeks, rows: weeksView({ weeks: c.weeks, plan: c.plan, base, routines: bundle.routines || [], current: null, names: exName }) }
}
