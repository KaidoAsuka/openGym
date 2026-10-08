// Asking the Coach before a workout is started: how the night was, how long there is, what hurts.
//
// The question is asked about the workout Start would build, so that workout is built here first
// and not started: `S.active`'s shape, with no clock and `pre: true`. Everything a question asked
// during a workout does (lib/coach-live.js) is done to it the same way: what was said is kept on
// it, an op is a card that is applied to it when tapped, a mark is set on its exercise. When they
// start, the workout opens as it was prepared, with the conversation still on it.
//
// One thing can be answered before a workout that cannot be answered during one: the day itself
// (api/coach/core/live.js DAY_OPS). "Train Light today instead" and "rest today" are cards too,
// and what a tap writes is the per-date override the day sheet writes (`S.dayPlan`), for today
// and for no other day.
//
// What is prepared is held outside `S` (store/useCoachPre.js): it is one phone's, for one day,
// and stands only while the plan under it has not moved (prepFor).
import { cleanDay } from '../../../api/coach/core/live.js'
import { effectiveRoutineIds } from './history.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { isWarmupRow } from './workout-model.js'
import { canAskLive, talkOf } from './coach-live.js'
import { uid } from './format.js'

// Pinned against api/coach/core/payload.js (coach-pre.test.js): what a finished workout keeps of
// a day the Coach suggested, and what the server reads of it.
export const DAY_FROM_MAX = 4
export const DAY_WHY_CHARS = 200
const NAME_CHARS = 80

const list = v => (Array.isArray(v) ? v : [])

/** What the workout was built from, reduced to what a change of plan would move: each exercise,
 *  its target and the numbers of its rows. Two builds of an unchanged plan read the same. */
const baseOf = entries => JSON.stringify(list(entries).map(e => [
  e.id, e.rid ?? null, e.target?.sets ?? null, e.target?.reps ?? null, e.target?.sec ?? null, e.target?.weight ?? null,
  list(e.sets).map(s => [isWarmupRow(s) ? 1 : 0, s.w ?? null, s.r ?? null, s.sec ?? null, s.min ?? null]),
]))

/** Whether today holds a workout that could be asked about: a routine planned, with an exercise. */
export const canPrepare = (S, today) => effectiveRoutineIds(S, today, today)
  .some(id => list(list(S.routines).find(r => r.id === id)?.ex).length > 0)

/**
 * Today's workout as Start would build it, not started. `owner` is whose it is (a phone can hold
 * more than one profile). Null when today holds nothing to train.
 *
 *   { owner, base, session: { id, d, pre: true, routineIds, name, cur: 0, entries } }
 */
export function buildPre(S, today, owner = '') {
  const { entries, routineIds, routines } = buildCombinedEntries(S, effectiveRoutineIds(S, today, today))
  if (!entries.length) return null
  return {
    owner, base: baseOf(entries),
    session: { id: 'pre' + uid(), d: today, pre: true, routineIds, name: deriveSessionName(routines.map(r => r.name)), cur: 0, entries },
  }
}

/**
 * What was prepared, while it still stands: the same person's, for today, for the routines today
 * holds, and built from a plan that has not moved since (a cycle that rolled into its next week,
 * a routine edited, a session logged in between). Otherwise null, and it is built again.
 */
export function prepFor(S, prep, today, owner = '') {
  const session = prep?.session
  if (!prep || prep.owner !== owner || !session?.pre || session.d !== today || !canAskLive(session)) return null
  const ids = effectiveRoutineIds(S, today, today)
  if (ids.join('\n') !== list(session.routineIds).join('\n')) return null
  return baseOf(buildCombinedEntries(S, ids).entries) === prep.base ? prep : null
}

/** Whether anything came of it that a workout should open with: something said, an op taken, a
 *  mark set, or the day itself changed. An untouched one is the workout Start builds anyway. */
const touched = session => talkOf(session).length > 0 || list(session?.coached).length > 0 || !!session?.coachedDay || list(session?.skipped).length > 0

/** The prepared workout a start of `routineIds` opens with, or null: it is today's, it stands,
 *  it is for exactly these routines, and something was said or changed in it. */
export function preToStart(S, prep, routineIds, today, owner = '') {
  const p = prepFor(S, prep, today, owner)
  if (!p || list(routineIds).join('\n') !== p.session.routineIds.join('\n') || !touched(p.session)) return null
  return p.session
}

/** The workout that is starting (`active`, as Start just built it) opens as it was prepared: the
 *  exercises with the ops that were taken and the marks that were set, and what was said. */
export function startFromPre(active, session) {
  if (!active || !session) return
  active.entries = session.entries
  for (const k of ['coachTalk', 'coached', 'coachedDay', 'skipped']) if (session[k]) active[k] = session[k]
}

/* ---------- the day ---------- */

/** What the phone holds a `day` against: its own reading of what the server read when it checked
 *  the answer (api/coach/core/payload.js liveContext). */
export const dayView = (S, session) => ({
  pre: !!session?.pre && canAskLive(session),
  routineIds: list(session?.routineIds),
  routines: list(S?.routines).filter(r => r && r.id != null && list(r.ex).length > 0).map(r => ({ id: r.id, name: typeof r.name === 'string' ? r.name : '' })),
})

/** The day an answer suggested, as it applies now, or null when it no longer does: the routine is
 *  gone or emptied, or it is the one today holds already. */
export function fitDay(S, session, day) {
  const read = cleanDay({ day }, dayView(S, session))
  return read.errors.length ? null : read.day
}

/**
 * Takes the day an answer suggested. `s` is the store's draft of `S`: today's override is written
 * into it, as the day sheet writes it. Returns `{ rest: true }` for a rest day, `{ prep }` with
 * the workout the day now holds (what was said goes with it, and it remembers what it replaced),
 * or null when the suggestion no longer fits and nothing was written.
 */
export function takeDay(s, prep, lineId, today) {
  const session = prep?.session
  const line = talkOf(session).find(m => m && m.id === lineId)
  if (!line?.day || line.dayTaken) return null
  const day = fitDay(s, session, line.day)
  if (!day) return null
  const value = day.do === 'rest' ? 'rest' : day.routine
  // A session of a coach week that is done already cannot be pinned to a day (lib/queue.js): the
  // override would read as none, and today would hold what it held before.
  const then = { ...s, dayPlan: { ...(s.dayPlan || {}), [today]: value } }
  if (day.do === 'train' && !effectiveRoutineIds(then, today, today).includes(day.routine)) return null
  const next = day.do === 'train' ? buildPre(then, today, prep.owner) : null
  if (day.do === 'train' && !next) return null
  s.dayPlan = then.dayPlan
  if (day.do === 'rest') return { rest: true }
  const names = list(session.routineIds).map(id => list(s.routines).find(r => r.id === id)?.name).filter(n => typeof n === 'string' && n.trim())
  // Changed twice, it still stands in for what the plan held at first.
  const from = list(session.coachedDay?.from).length ? session.coachedDay.from : names
  // What was said goes along. The cards of earlier answers were for the workout that is given
  // up here: what was taken of them went with it, so they read as open again, and as no longer
  // fitting where the new workout does not hold their exercise.
  next.session.coachTalk = talkOf(session).filter(Boolean).map(({ taken, marks, marksOff, ...m }) => (m.id === lineId ? { ...m, dayTaken: true } : m))
  next.session.coachedDay = cleanCoachedDay({ from, why: day.why })
  return { prep: next }
}

/** What a finished workout keeps of a day the Coach suggested: the names of what was planned in
 *  its place, and the reason given. Read field by field, as everything a workout is saved with. */
export function cleanCoachedDay(v) {
  if (!v || typeof v !== 'object') return null
  const from = list(v.from).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim().slice(0, NAME_CHARS)).slice(0, DAY_FROM_MAX)
  const why = typeof v.why === 'string' ? v.why.trim().slice(0, DAY_WHY_CHARS) : ''
  return { from, ...(why ? { why } : {}) }
}
