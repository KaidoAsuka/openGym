// What the phone does with the Coach's answer to a question asked during a workout.
//
// The answer is a few sentences and, when the workout itself should change, a short list of ops
// (api/coach/core/live.js). An op is a suggestion: it is shown as a card and applied here when the
// person taps it, to the workout in front of them and to nothing else. The plan and the cycle are
// not touched from here; what a workout says about the weeks to come is read once it is finished.
//
// Three things are kept, all on `S.active`, which never leaves the phone:
//   active.coachTalk  what was said in this workout, theirs and the Coach's, with each answer's
//                     ops and the marks it set. It begins before the workout does when the
//                     Coach was asked first (lib/coach-pre.js)
//   active.coached    what was taken of those ops. Saved with the finished workout
//                     (finish-workout.js), so the look that follows reads a weight the Coach
//                     lowered as its own suggestion and not as a set that was missed
//   entry.flags       the marks the Coach set for what was said (lib/exercise-flags.js)
//
// An op is checked twice by the same code: by the server when the answer is made and here when it
// is tapped (cleanOps), against the workout as it is by then. In between the person may have
// swapped the exercise, done the sets, or changed the numbers themselves; an op that no longer
// fits is not applied.
import { LIVE_OPS, DAY_OPS, LIVE_THREAD_LINES, LIVE_THREAD_CHARS, LIVE_WHY_MAX, cleanOps } from '../../../api/coach/core/live.js'
import { modeOf, isPerSide, buildSets, applyIntensifierPlan, cleanupSg, setSpanAt, defaultConfig } from './history.js'
import { isWarmupRow, isSideSet, makeSideSet, syncSideAggregate, hasCompletedWork, WEIGHT_ORIGIN_MANUAL } from './workout-model.js'
import { buildPlannedEntry, builtOutOfProgression } from './session-start.js'
import { swapActiveExercise } from './active-exercise-swap.js'
import { FLAG_KINDS, cleanFlags, setEntryFlags, keepMarked } from './exercise-flags.js'
import { sessionHistory } from './backfill.js'
import { weightIncrement, defaultIncrement } from './progression.js'
import { dropGrid } from './plates.js'
import { exOr, isCardio } from './exercises.js'
import { uid } from './format.js'

// A workout's worth of questions; the oldest lines go first.
export const TALK_MAX = 40
// What a finished workout keeps of the ops that were taken. Pinned against
// api/coach/core/payload.js COACHED_MAX (coach-live.test.js).
export const COACHED_MAX = 12
export const COACHED_WHY_CHARS = 200
const REPLY_CHARS = 1200

const list = v => (Array.isArray(v) ? v : [])
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A workout under way that can be asked about: not a past one being filed, not a saved one open
 *  in the editor (both reuse `S.active`), and with at least one exercise in it. */
export const canAskLive = active => !!active && !active.backfill && active.editingWorkoutId == null && list(active.entries).length > 0

/** The id a question is sent under, so that it can be asked again without being answered twice. */
export const newTurnId = () => 'q' + uid()

/* ---------- the workout as an op is held against ---------- */

/** What the catalogue (or their own exercises) says of an id: `{ name, cardio }`, or null. */
export function lookupExercise(id) {
  const ex = id == null ? null : exOr(id)
  return !ex || ex.missing ? null : { name: ex.n, cardio: isCardio(ex) }
}

/**
 * The workout in the shape cleanOps reads: the phone's own reading of what the server read out of
 * the same object when it checked the answer (api/coach/core/payload.js liveContext). Each
 * exercise is known by where it stands.
 */
export function liveView(active) {
  const entries = []
  list(active?.entries).forEach((en, entry) => {
    if (!en || typeof en !== 'object' || en.id == null) return
    const cfg = { ...(en.target || {}), id: en.id }
    const flags = cleanFlags(en.flags)
    entries.push({
      entry, id: String(en.id), mode: modeOf(cfg),
      ...(isPerSide(cfg) ? { side: true } : {}),
      sets: list(en.sets).filter(s => s && typeof s === 'object').map(s => {
        const o = { done: !!s.done }
        if (isWarmupRow(s)) o.warmup = true
        for (const k of ['w', 'r', 'sec']) if (num(s[k]) !== undefined) o[k] = s[k]
        return o
      }),
      ...(flags.length ? { flags } : {}),
    })
  })
  return { entries }
}

/**
 * Where in the workout an op's exercise is now. The answer names it by position and by id, and
 * the two have to agree. An exercise that was moved since is found again by its id alone when
 * the workout holds it once; held twice, the id cannot say which of the two was meant.
 */
function placeOf(active, op) {
  const entries = list(active?.entries)
  const same = e => e && op && String(e.id) === String(op.exId)
  if (Number.isInteger(op?.entry) && same(entries[op.entry])) return op.entry
  const found = entries.map((e, i) => (same(e) ? i : -1)).filter(i => i >= 0)
  return found.length === 1 ? found[0] : -1
}

/**
 * The op as it applies to the workout as it is now, or null when it no longer fits: its exercise
 * is gone or cannot be told apart, the sets it was about are done, the workout already holds the
 * exercise it would bring in, or the sets are already at its numbers.
 */
export function fitOp(active, op, { lookup = lookupExercise } = {}) {
  if (!canAskLive(active) || !op || !LIVE_OPS.includes(op.op)) return null
  const entry = placeOf(active, op)
  if (entry < 0) return null
  const { ops, errors } = cleanOps({ ops: [{ ...op, entry }] }, liveView(active), { lookup, flagKinds: FLAG_KINDS })
  return !errors.length && ops.length === 1 ? ops[0] : null
}

/* ---------- applying one ---------- */

const workLeft = e => list(e?.sets).filter(s => s && !isWarmupRow(s) && !s.done)
// What the first set still to do is at, which is what a change is shown against.
function numbersLeft(e) {
  const row = workLeft(e)[0]
  if (!row) return {}
  const o = {}
  for (const k of ['w', 'r', 'sec']) if (num(row[k]) !== undefined) o[k] = row[k]
  return o
}
const numbersOf = op => ({
  ...(op.weight != null ? { w: op.weight } : {}),
  ...(op.reps != null ? { r: op.reps } : {}),
  ...(op.sec != null ? { sec: op.sec } : {}),
})

/* The sets still to do, at the op's numbers. Done sets and warm-ups stay as they are, and so does
   the done side of a per-side set. The first row changed is marked the way a typed weight is
   (WEIGHT_ORIGIN_MANUAL), so a weight corrected later on a set above it does not run down over
   what the Coach set. */
function changeRemaining(e, { weight, reps, sec }) {
  let first = true
  e.sets = list(e.sets).map(row => {
    if (!row || isWarmupRow(row) || row.done) return row
    if (isSideSet(row)) {
      const sides = {}
      for (const k of ['L', 'R']) {
        const sd = { ...row.sides[k] }
        if (!sd.done) {
          if (weight != null) { sd.w = weight; if (first) sd.weightOrigin = WEIGHT_ORIGIN_MANUAL }
          // A per-side exercise's reps are the total of both sides (cleanOps holds it to an even number).
          if (reps != null) sd.r = reps / 2
        }
        sides[k] = sd
      }
      first = false
      return syncSideAggregate({ ...row, sides })
    }
    const next = { ...row }
    if (weight != null) { next.w = weight; if (first) next.weightOrigin = WEIGHT_ORIGIN_MANUAL }
    if (reps != null) next.r = reps
    // A typed duration is the new plan (Workout.jsx setField): one a displaced hold put aside goes.
    if (sec != null) { next.sec = sec; delete next.planSec }
    first = false
    return next
  })
}

// A timed per-side hold is an L row and an R row that read as one set (history.js setSpanAt), and
// the answer counted rows. One set there is the pair, so a count is taken in pairs, rounded up.
const paired = e => list(e.sets).some(s => s && !isWarmupRow(s) && (s.side === 'L' || s.side === 'R'))
const setsFor = (e, count) => (paired(e) ? Math.ceil(count / 2) : count)

/* Sets off the end, the ones not started. A set with anything logged on it stays, and so does
   the last row of the exercise: taking that one too is "skip". */
function removeSets(e, count) {
  let n = setsFor(e, count)
  for (let i = list(e.sets).length - 1; i >= 0 && n > 0; i--) {
    const row = e.sets[i]
    if (!row || isWarmupRow(row)) continue
    const [start, span] = setSpanAt(e.sets, i)
    const rows = e.sets.slice(start, start + span)
    i = start
    if (rows.some(hasCompletedWork) || e.sets.length <= span) continue
    e.sets.splice(start, span)
    n--
  }
}

/* One more set, the way the workout's own "Add set" adds it (Workout.jsx addSet): at the numbers
   of the set before it, unless the op gave its own. */
function addOneSet(e, { weight, reps, sec } = {}) {
  const cfg = { ...(e.target || {}), id: e.id }
  const mode = modeOf(cfg)
  const l = e.sets[e.sets.length - 1]
  if (mode === 'cardio') {
    e.sets.push({ min: l ? l.min : (e.target?.min || 20), speed: l ? l.speed : (e.target?.speed || 8), done: false })
    return
  }
  if (mode === 'time') {
    const s = sec != null ? sec : (l ? l.sec : (e.target?.sec || 45))
    const w = weight != null ? weight : (l ? (l.w || 0) : (e.target?.weight || 0))
    if (isPerSide(cfg)) e.sets.push({ sec: s, w, done: false, side: 'L' }, { sec: s, w, done: false, side: 'R' })
    else e.sets.push({ sec: s, w, done: false })
    return
  }
  const side = l && isSideSet(l)
  const row = {
    w: weight != null ? weight : (l ? (side ? l.sides.L.w : l.w) : 0),
    r: reps != null ? reps : (l ? (side ? (l.sides.L.r || 0) * 2 : l.r) : e.target?.reps),
    done: false,
    // An extra set past a pyramid copies the last one's target, Max included, unless it has reps of its own.
    ...(l && l.max && reps == null ? { max: true } : {}),
  }
  e.sets.push(isPerSide(cfg) ? makeSideSet(row) : row)
}
function addSets(e, count, numbers) {
  if (!Array.isArray(e.sets)) e.sets = []
  for (let n = setsFor(e, count); n > 0; n--) addOneSet(e, numbers)
}

/* What is left of an exercise, left out. Nothing done yet: it leaves the workout, the way "Remove
   exercise" takes it out, and a mark on it stays with the workout (keepMarked). Some sets done:
   they stay, and the rows not started go. */
function skipRest(active, idx) {
  const e = active.entries[idx]
  if (!list(e.sets).some(hasCompletedWork)) {
    keepMarked(active, e)
    active.entries.splice(idx, 1)
    cleanupSg(active.entries)
    if (idx < active.cur) active.cur--
    if (active.cur >= active.entries.length) active.cur = Math.max(0, active.entries.length - 1)
    return
  }
  e.sets = e.sets.filter(hasCompletedWork)
}

/* Another exercise in this one's place, built the way a swap from the picker builds it
   (sheets.jsx swapActiveWorkoutExercise): in a planned slot by that routine's rules, freestyle
   from what was done last time. It keeps the sets and reps of what it replaces unless the op
   gave its own, and takes its weight from their own history of the new exercise unless the op
   gave one. Sets already logged stay with the exercise they were done on: the replacement goes
   in beside it, for as many sets as were still to do, and the rows not started are taken off
   the original. */
function swapIn(st, idx, op) {
  const active = st.active
  const current = active.entries[idx]
  const to = op.to
  const was = { ...(current.target || {}), id: current.id }
  const done = list(current.sets).filter(s => s && !isWarmupRow(s) && hasCompletedWork(s)).length
  const left = workLeft(current).length
  const mode = isCardio(to) ? 'cardio' : (op.sec != null && op.reps == null ? 'time' : 'reps')
  const cfg = defaultConfig(to, mode)
  if (mode !== 'cardio') {
    // As many sets as were still to do once some are logged, the plan's own count otherwise.
    const wasSets = (done ? 0 : current.target?.sets) || setsFor(current, left) || cfg.sets
    cfg.sets = op.sets != null ? op.sets : wasSets
    // A per-side exercise's reps are both sides together; its replacement is not per-side.
    const wasReps = modeOf(was) === 'reps' && current.target?.reps > 0 ? (isPerSide(was) ? Math.round(current.target.reps / 2) : current.target.reps) : null
    if (mode === 'reps') cfg.reps = op.reps != null ? op.reps : (wasReps || cfg.reps)
    if (mode === 'time') cfg.sec = op.sec != null ? op.sec : (modeOf(was) === 'time' && current.target?.sec > 0 ? current.target.sec : cfg.sec)
    if (op.weight != null) cfg.weight = op.weight
  }
  const full = { ...cfg, id: to }
  const routine = current.rid ? list(st.routines).find(r => r.id === current.rid) : null
  const past = sessionHistory(st)
  const step = modeOf(full) === 'reps' ? weightIncrement(full, st.unit) : defaultIncrement(to, st.unit)
  const built = routine
    ? buildPlannedEntry(past, full, routine, { noProg: builtOutOfProgression(current, routine) })
    : { target: { ...cfg }, plan: null, sets: applyIntensifierPlan(buildSets(past, full, { step, preferLast: true }), full, dropGrid(st, full)) }
  const replacement = {
    id: to, ...built,
    ...(current.rid ? { rid: current.rid } : {}),
    ...(current.noProg === true ? { noProg: true } : {}),
  }
  if (mode !== 'cardio') {
    // History may open it with another number of sets than was asked for; the count is the op's.
    const have = () => setsFor(replacement, list(replacement.sets).filter(s => s && !isWarmupRow(s)).length)
    if (have() > cfg.sets) removeSets(replacement, (have() - cfg.sets) * (paired(replacement) ? 2 : 1))
    if (have() < cfg.sets) addSets(replacement, (cfg.sets - have()) * (paired(replacement) ? 2 : 1))
    // And the numbers the op gave are the ones it is done at, whatever history said.
    if (op.weight != null || op.reps != null || op.sec != null) {
      changeRemaining(replacement, op)
      replacement.target = { ...replacement.target, ...(op.weight != null ? { weight: op.weight } : {}), ...(op.reps != null ? { reps: op.reps } : {}), ...(op.sec != null ? { sec: op.sec } : {}) }
    }
  }
  const out = swapActiveExercise(active, idx, replacement, { loggedConfirmed: true, groupDisposition: 'keep' })
  if (!out || out.needsConfirmation) return null
  if (out.inserted) current.sets = current.sets.filter(hasCompletedWork)
  return out
}

/**
 * Whether applying the op moves exercises about (one leaves, or one comes in beside another): the
 * timers the workout screen runs hold an exercise by its place, and the caller stops them first,
 * as the screen's own swap and remove do. `{ at, removes }`, or null when nothing moves.
 */
export function opMoves(active, op) {
  const fit = fitOp(active, op)
  if (!fit || (fit.op !== 'swap' && fit.op !== 'skip')) return null
  const logged = list(active.entries[fit.entry].sets).some(hasCompletedWork)
  if (fit.op === 'skip') return logged ? null : { at: fit.entry, removes: true }
  return { at: fit.entry, removes: false }
}

/**
 * Applies one op to the workout in `st.active`, which is a draft the caller owns (the store's
 * update). Returns what was done, in the shape the finished workout keeps it, or null when the op
 * no longer fits and nothing was touched.
 *
 *   { id, op, n?, w?, r?, sec?, was?: { w?, r?, sec? }, to?, why? }
 *
 * `id` is the exercise it was about, `n` how many sets it reached, `was` what those sets were at
 * before, `to` the exercise a swap brought in.
 */
export function applyLiveOp(st, op, opts = {}) {
  const active = st?.active
  const fit = fitOp(active, op, opts)
  if (!fit) return null
  const idx = fit.entry
  const e = active.entries[idx]
  const rec = recordOf(e, fit, op)
  if (fit.op === 'change-remaining') changeRemaining(e, fit)
  else if (fit.op === 'remove-set') removeSets(e, fit.count || 1)
  else if (fit.op === 'add-set') addSets(e, fit.count || 1, fit)
  else if (fit.op === 'swap') { if (!swapIn(st, idx, fit)) return null }
  else skipRest(active, idx)
  active.coached = [...list(active.coached), rec].slice(-COACHED_MAX)
  return rec
}

// What an op does to the exercise as it stands, written down before it is done.
function recordOf(e, fit, op) {
  const left = workLeft(e).length
  const rec = { id: e.id, op: fit.op }
  if (fit.op === 'change-remaining') {
    const before = numbersLeft(e)
    const now = numbersOf(fit)
    const was = {}
    for (const k of Object.keys(now)) if (before[k] !== undefined && before[k] !== now[k]) was[k] = before[k]
    Object.assign(rec, { n: left }, now, Object.keys(was).length ? { was } : {})
  } else if (fit.op === 'remove-set') rec.n = fit.count || 1
  else if (fit.op === 'add-set') Object.assign(rec, { n: fit.count || 1 }, numbersOf(fit))
  else if (fit.op === 'swap') Object.assign(rec, { to: fit.to }, fit.sets != null ? { n: fit.sets } : {}, numbersOf(fit))
  else rec.n = left
  const why = typeof op?.why === 'string' ? op.why.trim().slice(0, COACHED_WHY_CHARS) : ''
  if (why) rec.why = why
  return rec
}

/** What applying the op would record, without applying it: what its card shows before it is
 *  tapped. Null when the op no longer fits the workout. */
export function previewOp(active, op, opts = {}) {
  const fit = fitOp(active, op, opts)
  return fit ? recordOf(active.entries[fit.entry], fit, op) : null
}

/**
 * What a finished workout keeps of `active.coached`: each record read field by field, as
 * everything a workout is saved with is. `known(id)` says whether an exercise exists.
 */
export function cleanCoached(v, known = id => !!lookupExercise(id)) {
  const out = []
  for (const c of list(v)) {
    if (!c || typeof c !== 'object' || c.id == null || !LIVE_OPS.includes(c.op)) continue
    const rec = { id: c.id, op: c.op }
    if (Number.isInteger(c.n) && c.n > 0 && c.n <= 20) rec.n = c.n
    for (const k of ['w', 'r', 'sec']) if (num(c[k]) !== undefined && c[k] >= 0) rec[k] = c[k]
    if (c.was && typeof c.was === 'object') {
      const was = {}
      for (const k of ['w', 'r', 'sec']) if (num(c.was[k]) !== undefined && c.was[k] >= 0) was[k] = c.was[k]
      if (Object.keys(was).length) rec.was = was
    }
    if (c.op === 'swap') { if (c.to == null || !known(c.to)) continue; rec.to = c.to }
    if (typeof c.why === 'string' && c.why.trim()) rec.why = c.why.trim().slice(0, COACHED_WHY_CHARS)
    out.push(rec)
  }
  return out.slice(-COACHED_MAX)
}

/* ---------- what was said ---------- */

export const talkOf = active => list(active?.coachTalk)
const answerOf = (active, turn) => talkOf(active).find(m => m && m.who === 'coach' && m.turn === turn && !m.error)

/** What goes with the next question: the exchanges that were answered, oldest first and cut as the
 *  server cuts them. A question that never got its answer is left out, and so is a failure. */
export function threadFor(active) {
  const answered = new Set(talkOf(active).filter(m => m && m.who === 'coach' && !m.error).map(m => m.turn))
  return talkOf(active)
    .filter(m => m && typeof m.text === 'string' && m.text.trim() && answered.has(m.who === 'coach' ? m.turn : m.id))
    .map(m => ({ who: m.who === 'coach' ? 'coach' : 'user', text: m.text.trim().slice(0, LIVE_THREAD_CHARS) }))
    .slice(-LIVE_THREAD_LINES)
}

/** The question still waiting for its answer, or null: the last thing said, when it was theirs. */
export function openTurn(active) {
  const last = talkOf(active).at(-1)
  return last && last.who === 'user' ? last : null
}

const keep = (active, line) => { active.coachTalk = [...talkOf(active), line].slice(-TALK_MAX) }

/** Their question, written into the workout before it is sent. */
export function addQuestion(active, { id, text, focus, at = Date.now() }) {
  if (!canAskLive(active) || !id || typeof text !== 'string' || !text.trim()) return null
  const line = { id, who: 'user', text: text.trim(), at, ...(Number.isInteger(focus) ? { focus } : {}) }
  keep(active, line)
  return line
}

/**
 * The Coach's answer to turn `turn`, written into the workout. Its marks are set at once: a mark
 * is what the person said about the exercise ("the bar felt heavy"), written down for them, and
 * the line keeps which ones it set so that they can be taken off again (undoMarks). Its ops are
 * only kept; each waits to be tapped. Returns the line, or null when the turn is not this
 * workout's or was answered already (a question sent twice is answered once).
 */
export function addAnswer(active, turn, answer, at = Date.now()) {
  if (!canAskLive(active) || !talkOf(active).some(m => m && m.who === 'user' && m.id === turn) || answerOf(active, turn)) return null
  const ops = list(answer?.ops).filter(o => o && typeof o === 'object' && LIVE_OPS.includes(o.op)).map(o => ({ ...o }))
  const marks = []
  for (const f of cleanOps({ flags: list(answer?.flags).map(f => ({ ...f, entry: placeOf(active, f) })) }, liveView(active), { lookup: lookupExercise, flagKinds: FLAG_KINDS }).flags) {
    const e = active.entries[f.entry]
    setEntryFlags(e, [...cleanFlags(e.flags), f.flag])
    marks.push({ entry: f.entry, exId: f.exId, flag: f.flag })
  }
  // A failure written for this turn earlier (the first try timed out) gives way to the answer.
  active.coachTalk = talkOf(active).filter(m => !(m && m.turn === turn && m.error))
  const day = dayOfAnswer(active, answer)
  const line = {
    id: turn + '.a', turn, who: 'coach', at,
    text: typeof answer?.reply === 'string' ? answer.reply.trim().slice(0, REPLY_CHARS) : '',
    ...(ops.length ? { ops } : {}),
    ...(marks.length ? { marks } : {}),
    ...(day ? { day } : {}),
  }
  keep(active, line)
  return line
}

/** What an answer says about the day itself, as its line keeps it: only for a workout that has
 *  not been started (lib/coach-pre.js), and read by name. It waits to be tapped, like an op. */
function dayOfAnswer(active, answer) {
  const d = answer?.day
  if (!active?.pre || !d || typeof d !== 'object' || !DAY_OPS.includes(d.do)) return null
  const why = typeof d.why === 'string' ? d.why.trim().slice(0, LIVE_WHY_MAX) : ''
  if (d.do === 'train' && d.routine == null) return null
  return {
    do: d.do,
    ...(d.do === 'train' ? { routine: d.routine, ...(typeof d.name === 'string' && d.name ? { name: d.name.slice(0, 80) } : {}) } : {}),
    ...(why ? { why } : {}),
  }
}

/** The question could not be answered: the class it failed with, in place of an answer. One line
 *  per turn, so asking again replaces the reason rather than stacking them. */
export function addFailure(active, turn, errorClass, detail, at = Date.now()) {
  if (!active || !talkOf(active).some(m => m && m.who === 'user' && m.id === turn) || answerOf(active, turn)) return null
  active.coachTalk = talkOf(active).filter(m => !(m && m.turn === turn && m.error))
  const line = { id: turn + '.e', turn, who: 'coach', at, error: String(errorClass || 'internal'), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }
  keep(active, line)
  return line
}

/** Takes one op of an answer: applies it and notes on the line that it was taken. Returns what
 *  applyLiveOp returns. An op is taken once. */
export function takeOp(st, lineId, i, opts) {
  const line = talkOf(st?.active).find(m => m && m.id === lineId)
  const op = line && list(line.ops)[i]
  if (!op || list(line.taken).includes(i)) return null
  const rec = applyLiveOp(st, op, opts)
  if (rec) line.taken = [...list(line.taken), i]
  return rec
}

/** Takes the marks an answer set off again, where the exercise is still the one they were set on. */
export function undoMarks(active, lineId) {
  const line = talkOf(active).find(m => m && m.id === lineId)
  if (!line || line.marksOff || !list(line.marks).length) return false
  for (const f of line.marks) {
    const at = placeOf(active, f)
    if (at < 0) continue
    const e = active.entries[at]
    setEntryFlags(e, cleanFlags(e.flags).filter(k => k !== f.flag))
  }
  line.marksOff = true
  return true
}
