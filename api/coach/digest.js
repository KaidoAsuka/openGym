/* Which week is written up next, and who holds the note until the phone has it.
 *
 * A weekly note is the one Coach job nobody asks for and nobody answers. The scheduler
 * (cadence.js) queues it once a trained week is over; the result is not a proposal, so it does
 * not wait in `pending` and raises no notification. It is kept in the profile's own record
 * (jobs.js) and handed out with every status poll until the synced state shows the phone has
 * taken it into `S.coach.digests` — the server never writes that state itself, and a note handed
 * over once and then dropped would be lost to a phone that closed before it synced.
 *
 * Everything here is a pure function of what it is given: the state, the record, a date and a
 * clock. api/test/digest.test.js is the reason.
 */
import { weekBounds, weekWorkouts } from './core/payload.js';

// A box that was switched off over a Sunday night still writes the week up on Wednesday, and one
// that was off for a fortnight writes up both weeks. Further back than this is history nobody
// asked to have summarised, at one provider call a week.
export const CATCH_UP_WEEKS = 4;
// What is held for a phone that has not looked: as many as a review reads (payload.js
// DIGESTS_SENT), so a scheduled review loses nothing to an app that stayed closed.
export const KEPT_MAX = 12;
// A provider that was down is tried again, a few times and not every minute.
export const RETRY_AFTER_MS = 6 * 3600000;
export const MAX_TRIES = 3;
// An answer that was paid for and could not be used, or a week there is nothing to send for, is
// not tried again: the same payload would get the same answer.
const FINAL = new Set(['unusable', 'toolarge', 'noworkout']);

const DAY = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (on, days) => new Date(Date.parse(on + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10);
const arr = v => (Array.isArray(v) ? v : []);

/**
 * The oldest finished week that was trained and has no note yet, or null.
 *
 * @param {object} S       the profile's synced state
 * @param {object} rec     the profile's record (jobs.readUser): `digests` held, `history` of jobs
 * @param {string} today   the date where the person is (YYYY-MM-DD)
 * @param {object} [opts]  tzKnown: false when `today` is only the server's guess (no timezone on
 *                         the profile) — the week is then left a day longer, so a Sunday evening
 *                         session somewhere west of the server is not written up without;
 *                         now: the clock the retry delay is read against
 */
export function dueWeek(S, rec, today, { tzKnown = true, now = Date.now() } = {}) {
  if (!S || typeof today !== 'string' || !ISO_DAY.test(today)) return null;
  const asOf = tzKnown ? today : shift(today, -1);
  const have = new Set([...arr(S.coach?.digests), ...arr(rec?.digests)].map(g => g && g.from));
  const failed = arr(rec?.history).filter(h => h && h.kind === 'digest' && h.outcome === 'failed');
  for (let back = CATCH_UP_WEEKS; back >= 1; back--) {
    const week = weekBounds(shift(asOf, -7 * back), S.weekStart);
    if (!week || week.to >= asOf || have.has(week.from)) continue;
    if (!weekWorkouts(S, week.from, week.to).length) continue;
    const tries = failed.filter(h => h.week === week.from);
    if (tries.length >= MAX_TRIES || tries.some(h => FINAL.has(h.errorClass))) continue;
    if (tries.length && now - Math.max(...tries.map(h => h.at || 0)) < RETRY_AFTER_MS) continue;
    return week;
  }
  return null;
}

/** The notes held, with one more: a week has one note, the newest written, and the oldest held
 *  give way once there are more than a review would read. */
export function keep(held, digest) {
  return [...arr(held).filter(g => g && g.from !== digest.from), digest]
    .sort((a, b) => String(a.from).localeCompare(String(b.from)))
    .slice(-KEPT_MAX);
}

/** The notes held that the synced state does not have yet. */
export function unfetched(held, S) {
  const there = new Set(arr(S?.coach?.digests).map(g => g && g.from));
  return arr(held).filter(g => g && !there.has(g.from));
}
