// The weeks the Coach wrote up.
//
// Once a trained week is over the server has the Coach write a short note on it: a summary and
// three lists — what moved, what got in the way, what to check later — next to the week's own
// counts. Nobody asks for it and there is nothing to answer, so it is not a proposal: it rides on
// the status poll (api/coach/jobs.js status) until this profile's state holds it, and the server
// stops handing it over once it sees it there (api/coach/digest.js).
//
// The notes live in `S.coach.digests`, oldest first, one per week, so they sync and export with
// everything else, and the payload builder reads them back from there for every later review
// (api/coach/core/payload.js digestsOf).
//
// Pure over a draft state, like lib/coach.js, and for the same reason.
import { FLAG_KINDS } from './exercise-flags.js'

// Half a year: the longest block a charter can set (coach-charter.js BLOCK_WEEKS_MAX), so a
// checkpoint can still look back over all of it. A review reads the last twelve.
export const DIGESTS_MAX = 26
// The limits the validator holds an answer to and payload.js reads a note back at. Not imported
// from either, which would pull the exercise catalogue into the main bundle;
// coach-digests.test.js pins the three together.
export const DIGEST_SUMMARY_MAX = 500
export const DIGEST_ITEMS_MAX = 4
export const DIGEST_ITEM_MAX = 160
export const DIGEST_LISTS = ['progress', 'issues', 'carry']
const COUNTS = ['sessions', 'planned', 'sets', 'minutes', 'prs']

const list = v => (Array.isArray(v) ? v : [])
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z'))
const tally = v => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null)
const lines = v => list(v).filter(x => typeof x === 'string' && x.trim()).slice(0, DIGEST_ITEMS_MAX).map(x => x.trim().slice(0, DIGEST_ITEM_MAX))

/** Whatever the server handed over or a sync brought in, as a note: every field by name, by
 *  type, and cut. Null for anything that is not a week with something said about it. */
export function cleanDigest(raw) {
  const g = raw && typeof raw === 'object' ? raw : {}
  const summary = typeof g.summary === 'string' ? g.summary.trim().slice(0, DIGEST_SUMMARY_MAX) : ''
  if (!isDay(g.from) || !isDay(g.to) || g.to < g.from || !summary) return null
  const o = { id: typeof g.id === 'string' && g.id ? g.id.slice(0, 40) : g.from, from: g.from, to: g.to, at: Number.isFinite(g.at) ? g.at : 0 }
  for (const k of COUNTS) if (tally(g[k]) != null) o[k] = g[k]
  const marks = g.marks && typeof g.marks === 'object' ? FLAG_KINDS.filter(k => tally(g.marks[k])).map(k => [k, g.marks[k]]) : []
  if (marks.length) o.marks = Object.fromEntries(marks)
  o.summary = summary
  for (const k of DIGEST_LISTS) o[k] = lines(g[k])
  return o
}

/** The notes kept, oldest first. */
export const digestsOf = S => list(S?.coach?.digests).filter(g => g && typeof g === 'object' && isDay(g.from))
/** The same, newest first: the order a person reads them in. */
export const digestList = S => digestsOf(S).slice().reverse()

/**
 * Which of the notes just handed over this state does not hold yet. The server hands the same
 * ones over on every poll until it has seen them synced, so the usual answer is none — and the
 * caller only opens a store update, with the push that follows one, when there is something.
 * A week written a second time replaces the first.
 */
export function freshDigests(S, incoming) {
  const have = new Map(digestsOf(S).map(g => [g.from, g]))
  return list(incoming).map(cleanDigest).filter(g => {
    const old = g && have.get(g.from)
    return g && !(old && (old.at || 0) >= g.at)
  })
}

/** Take the new ones in: one note a week, oldest first, the oldest dropped past DIGESTS_MAX.
 *  Returns how many were taken. */
export function adoptDigests(s, incoming) {
  const fresh = freshDigests(s, incoming)
  if (!fresh.length) return 0
  if (!s.coach) s.coach = {}
  const byWeek = new Map(digestsOf(s).map(g => [g.from, g]))
  fresh.forEach(g => byWeek.set(g.from, g))
  s.coach.digests = [...byWeek.values()].sort((a, b) => a.from.localeCompare(b.from)).slice(-DIGESTS_MAX)
  return fresh.length
}
