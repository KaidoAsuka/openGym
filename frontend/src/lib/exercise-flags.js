// What a lifter can mark on an exercise in a session, next to the note they type about it.
//
// A note is free text, and nothing can count free text. A mark is one of seven fixed words, so
// "the bench was taken again" is something a later reading can add up: the Coach's payload
// (api/coach/core/payload.js) counts the marks per exercise, the way it counts stalls, and the
// counting needs no stored counter — it is worked out from the log every time.
//
// Marks live on the entry (`entry.flags`), as the note does. An exercise that leaves the session
// without a set — swapped out because the station was taken, dropped for time, stopped for pain —
// has no entry in the finished workout at all, and its mark is the one worth keeping most. Those
// are kept on the workout instead (`skipped`), as { id, flags, note? }.
import { NOTE_MAX } from './history.js'
import { hasCompletedWork } from './workout-model.js'

// Pinned against api/coach/core/payload.js FLAG_KINDS (exercise-flags.test.js): the two runtimes
// share no build step, and a kind only one of them knew would be dropped on the way out.
export const FLAG_KINDS = ['pain', 'discomfort', 'equipment', 'time', 'heavy', 'light', 'dislike']

export const FLAG_LABEL = {
  pain: 'Pain',
  discomfort: 'Uncomfortable',
  equipment: 'Equipment taken',
  time: 'Out of time',
  heavy: 'Too heavy',
  light: 'Too light',
  dislike: 'Don’t like it',
}

// A workout holds a handful of exercises; this is a ceiling for a record written by hand.
export const SKIPPED_MAX = 12

const list = v => (Array.isArray(v) ? v : [])

/** The known kinds in `v`, each once, in the order the sheet shows them. */
export const cleanFlags = v => (Array.isArray(v) ? FLAG_KINDS.filter(k => v.includes(k)) : [])

/** `flags` with one kind switched; an unknown kind changes nothing. */
export const toggleFlag = (flags, kind) => {
  const on = cleanFlags(flags)
  return FLAG_KINDS.filter(k => (k === kind ? !on.includes(k) : on.includes(k)))
}

/** Writes the marks onto an entry, or takes the key away when there are none. */
export function setEntryFlags(entry, flags) {
  if (!entry) return
  const on = cleanFlags(flags)
  if (on.length) entry.flags = on
  else delete entry.flags
}

/**
 * Remembers a marked exercise that is leaving the running session — swapped out before a set,
 * or removed. Its mark and what was typed about it stay with the session (`active.skipped`).
 * An exercise with no mark leaves nothing behind, as before. Returns whether anything was kept.
 */
export function keepMarked(active, entry) {
  const flags = cleanFlags(entry?.flags)
  if (!active || entry?.id == null || !flags.length) return false
  const note = typeof entry.note === 'string' ? entry.note.trim().slice(0, NOTE_MAX) : ''
  active.skipped = [...list(active.skipped), { id: entry.id, flags, ...(note ? { note } : {}) }]
  return true
}

/**
 * The marked exercises a finished session did not log, one per exercise: those that left it
 * (`active.skipped`) and those still in it without a single set done. `logged` is the finished
 * workout's own entries. An exercise that was logged after all is not skipped — its marks are
 * added to the logged entry, in place.
 */
export function settleMarks(active, logged) {
  const pending = [
    ...list(active?.skipped),
    ...list(active?.entries).filter(e => e && !list(e.sets).some(hasCompletedWork)),
  ]
  const byId = new Map()
  for (const e of pending) {
    const flags = cleanFlags(e?.flags)
    if (e?.id == null || !flags.length) continue
    const note = typeof e.note === 'string' ? e.note.trim().slice(0, NOTE_MAX) : ''
    const done = list(logged).find(x => x.id === e.id)
    if (done) {
      done.flags = cleanFlags([...list(done.flags), ...flags])
      if (note && !done.note) done.note = note
      continue
    }
    const kept = byId.get(e.id) || { id: e.id, flags: [] }
    kept.flags = cleanFlags([...kept.flags, ...flags])
    if (note) kept.note = note
    byId.set(e.id, kept)
  }
  return [...byId.values()].slice(0, SKIPPED_MAX)
}
