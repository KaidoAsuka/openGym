// The charter: what the plan is for, and when it is looked at as a whole.
//
// The intake asks for one goal word. This is what a person says beyond it — a goal in their own
// words, the lifts they want to reach — and the block the current plan runs in: how many weeks,
// the day it started, the next checkpoint, and how the Coach laid it out when the plan was made.
// It lives in `S.coach.charter`, so it syncs and exports with everything else, and the payload
// builder reads it from there (api/coach/core/payload.js cleanCharter).
//
// The block is a length, two dates and a few lines of text. It runs nothing: the app trains the
// same week until the plan is changed, and the progression engine sets every load. What it gives
// the Coach is a reason to leave a plan alone for a while, and a day to stop and read all of it.
//
// Pure over a draft state, like lib/coach.js, and for the same reason.
import { modeOf, isBw } from './history.js'
import { todayISO, fmtDate } from './format.js'
import { t } from './i18n.js'

// The limits the sheet shows. payload.js cuts at the same ones, and is not imported for them: it
// would pull the exercise catalogue into the main bundle. coach-charter.test.js pins the two.
export const CHARTER_GOAL_MAX = 300
export const CHARTER_OUTLINE_MAX = 600
export const CHARTER_TARGETS_MAX = 5
export const BLOCK_WEEKS_MAX = 26
export const BLOCK_WEEKS_CHOICES = [4, 6, 8, 10, 12, 16]

const DAY_MS = 86400000
// Days are counted at noon UTC, so no clock change can make a week six days long.
const noon = iso => Date.parse(iso + 'T12:00:00Z')
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(noon(v))
export const daysApart = (a, b) => Math.round((noon(b) - noon(a)) / DAY_MS)
export const addDays = (iso, n) => new Date(noon(iso) + n * DAY_MS).toISOString().slice(0, 10)
const wholeIn = (v, lo, hi) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= lo ? Math.min(hi, n) : null
}

export const emptyCharter = () => ({ goal: '', targets: [], blockWeeks: null, startedAt: null, checkpoint: null, outline: '' })

/** Whatever was typed or synced, as a charter: every field by name, by type, and cut. */
export function cleanCharter(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const seen = new Set()
  const targets = (Array.isArray(c.targets) ? c.targets : [])
    .filter(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id && Number.isFinite(Number(x.weight)) && Number(x.weight) > 0)
    // One target per lift: two for the same exercise is a goal that contradicts itself.
    .filter(x => !seen.has(x.id) && seen.add(x.id))
    .slice(0, CHARTER_TARGETS_MAX)
    .map(x => ({ id: x.id, weight: Number(x.weight), reps: wholeIn(x.reps, 1, 100) ?? 1 }))
  return {
    goal: typeof c.goal === 'string' ? c.goal.slice(0, CHARTER_GOAL_MAX) : '',
    targets,
    blockWeeks: wholeIn(c.blockWeeks, 1, BLOCK_WEEKS_MAX),
    startedAt: isDay(c.startedAt) ? c.startedAt : null,
    checkpoint: isDay(c.checkpoint) ? c.checkpoint : null,
    outline: typeof c.outline === 'string' ? c.outline.slice(0, CHARTER_OUTLINE_MAX) : ''
  }
}

export const hasCharter = c => !!(c && (String(c.goal || '').trim() || c.targets?.length || c.blockWeeks || c.checkpoint))

/**
 * Keep what the sheet holds. A block with a length and no start begins today, and one with no
 * checkpoint gets the day its last week ends. A charter with nothing in it is stored as none,
 * so the payload carries no empty object.
 */
export function saveCharter(s, input, today = todayISO()) {
  const c = cleanCharter(input)
  c.goal = c.goal.trim()
  if (c.blockWeeks && !c.startedAt) c.startedAt = today
  if (c.blockWeeks && !c.checkpoint) c.checkpoint = addDays(c.startedAt, c.blockWeeks * 7)
  if (!s.coach) s.coach = {}
  s.coach.charter = hasCharter(c) ? { ...c, updatedAt: Date.now() } : null
  return s.coach.charter
}

/**
 * Taking a plan from the Coach starts a block: the length and the outline it proposed, counted
 * from today. The goal and the target lifts are the person's own and stay as they are. A plan
 * that came with no block (an older server, a small model) leaves the charter alone.
 */
export function adoptBlock(s, block, today = todayISO()) {
  if (!block || typeof block !== 'object' || !Number.isInteger(block.weeks)) return null
  const weeks = wholeIn(block.weeks, 1, BLOCK_WEEKS_MAX)
  if (!weeks) return null
  if (!s.coach) s.coach = {}
  s.coach.charter = {
    ...cleanCharter(s.coach.charter),
    blockWeeks: weeks, startedAt: today, checkpoint: addDays(today, weeks * 7),
    outline: typeof block.outline === 'string' ? block.outline.slice(0, CHARTER_OUTLINE_MAX) : '',
    updatedAt: Date.now()
  }
  return s.coach.charter
}

/**
 * Where today falls in the block: the week it is in, the days left, whether the checkpoint has
 * come. `week` and `checkpointDue` are the same two facts payload.js charterProgress hands the
 * model, so the phone and the Coach never disagree about what week it is.
 */
export function charterStatus(charter, today = todayISO()) {
  const c = charter || {}
  const o = {}
  if (!isDay(today)) return o
  if (isDay(c.startedAt)) {
    const n = daysApart(c.startedAt, today)
    if (n >= 0) o.week = Math.floor(n / 7) + 1
  }
  if (isDay(c.checkpoint)) {
    o.daysLeft = daysApart(today, c.checkpoint)
    o.checkpointDue = o.daysLeft <= 0
  }
  return o
}

/** The one line the Coach menu shows under "Goal & checkpoint". */
export function charterLine(charter, today = todayISO()) {
  const c = charter || {}
  const st = charterStatus(c, today)
  if (st.checkpointDue) return t('Checkpoint reached — ask for a review')
  if (st.week && c.blockWeeks && c.checkpoint) return t('Week {0} of {1} · checkpoint {2}', Math.min(st.week, c.blockWeeks), c.blockWeeks, fmtDate(c.checkpoint))
  const goal = String(c.goal || '').trim()
  if (goal) return goal.length > 60 ? goal.slice(0, 59) + '…' : goal
  return t('What you are working toward, and when to take stock')
}

/** The lifts a target can be set on: what the plan trains for reps, with a load of its own. */
export function targetChoices(S) {
  const seen = new Set()
  const out = []
  ;(S?.routines || []).forEach(r => (r.ex || []).forEach(e => {
    if (!e || seen.has(e.id) || modeOf(e) !== 'reps' || isBw(e)) return
    seen.add(e.id)
    out.push({ id: e.id, weight: e.weight || 0, reps: e.reps || 0 })
  }))
  return out
}
