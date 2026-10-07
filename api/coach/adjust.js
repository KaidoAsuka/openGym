/* When a running cycle is looked at, and who holds the answer until the phone has it.
 *
 * A cycle (core/cycle.js) is written when the plan is made and corrected as it is trained: after
 * a session comes in, the Coach reads it against the weeks still to come and moves their numbers
 * where the log says to (prompts/adjust.md). Like a weekly note it is a job nobody asks for. It
 * is not a proposal either: the changes take effect on the phone without being approved, and can
 * be undone there. So the answer is kept in the profile's own record (jobs.js) and handed out
 * with every status poll until the synced state shows the phone took it in — the server never
 * writes that state itself.
 *
 * One look per session: the scheduler remembers the last session it looked at, and a session
 * that was looked at is not looked at again whatever became of the job. A provider that was down
 * for one session is asked again after the next.
 *
 * Everything here is a pure function of what it is given. api/test/cycle.test.js is the reason.
 */
import { cycleWeekOn, CYCLE_WEEKS_MAX } from './core/cycle.js';

// What is held for a phone that has not looked. Each look stands on the one before, so they are
// applied in order and none may be dropped while it is still to be applied; a phone that stayed
// closed through more looks than this has a cycle too stale to correct by small steps anyway.
export const KEPT_MAX = 14;
// A cycle is looked at for a week past its end, so its last sessions are read and it is told
// that it is over; after that it is history.
const GRACE_WEEKS = 1;

const arr = v => (Array.isArray(v) ? v : []);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** The latest finished session of the cycle, as a key that changes when a newer one arrives. */
function latestSession(S) {
  const c = S?.coach?.cycle;
  if (!c || typeof c !== 'object' || !ISO_DAY.test(String(c.startedAt || ''))) return null;
  const from = String(c.startedAt).slice(0, 10);
  const done = arr(S.workouts).filter(w => w && typeof w.d === 'string' && ISO_DAY.test(w.d) && w.d.slice(0, 10) >= from && w.end);
  const w = done[done.length - 1];
  return w ? String(w.id || w.d).slice(0, 64) + ':' + Number(w.end) : null;
}

/**
 * Whether the cycle is due a look, and for which session.
 *
 * @param {object} S       the profile's synced state
 * @param {object} rec     the profile's record (jobs.readUser): `adjustSeen`, the last session looked at
 * @param {string} today   the date where the person is (YYYY-MM-DD)
 * @returns {string|null}  the session's key when a look is due
 */
export function dueLook(S, rec, today) {
  const c = S?.coach?.cycle;
  if (!c || typeof c !== 'object' || !arr(c.routines).length) return null;
  const weeks = Number.isInteger(c.weeks) && c.weeks >= 1 && c.weeks <= CYCLE_WEEKS_MAX ? c.weeks : 0;
  const at = cycleWeekOn(c.startedAt, today);
  if (!weeks || !at || at > weeks + GRACE_WEEKS) return null;
  const key = latestSession(S);
  return key && key !== rec?.adjustSeen ? key : null;
}

/** The looks held, with one more, oldest first. */
export function keep(held, look) {
  return [...arr(held).filter(a => a && a.id !== look.id), look].slice(-KEPT_MAX);
}

/** The looks held that the synced state has not taken in yet. A cycle that is gone, or another
 *  one than the look was made for, takes nothing more. */
export function unfetched(held, S) {
  const c = S?.coach?.cycle;
  if (!c || typeof c !== 'object') return [];
  const there = new Set(arr(c.applied));
  return arr(held).filter(a => a && a.cycle === c.id && !there.has(a.id));
}
