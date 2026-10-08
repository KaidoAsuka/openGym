/* What the Coach may do to a session that is under way.
 *
 * Between two sets someone asks a question: the bar felt heavy, the rack is taken, there are
 * twenty minutes left. The answer is a few sentences and, when the session itself should change,
 * a short list of ops (prompts/live.md). An op is a suggestion: the phone shows it as a card and
 * applies it when the person taps it, to the session in front of them and to nothing else. The
 * plan and the cycle are not touched from here — what a session says about the weeks to come is
 * read after it is finished, by the look that follows every session (prompts/adjust.md).
 *
 * The list of ops is closed, like the list of plan changes (validate.js CHANGE_TYPES), and for the
 * same reason: what the user typed can talk a model into saying anything, and an op that is not
 * on this list does nothing. It is a list of its own because these are not plan changes. They
 * have no place on a review screen, and the phone applies them to another object.
 *
 * An op names its exercise twice, by where it stands in the session (`entry`) and by its id
 * (`exId`), and the two have to agree. A session can hold the same exercise twice, so the id
 * alone is not enough; and a position alone is one slip away from the exercise next to it.
 *
 * Only cycle.js is imported, for the ranges a number is held to. Both runtimes use this file —
 * the server to check an answer, the phone to apply one — and the phone's main bundle must not
 * pull the catalogue in behind it. Whether an exercise exists is asked through `lookup`.
 *
 * The same question can be asked before the session is started: how they slept, how long they
 * have, what hurts. The session is then the one the phone would build if they tapped Start (it is
 * sent with `pre: true`), every set of it is still to do, and the same ops apply to it. One thing
 * more can be said then and only then, about the day itself (`day`, DAY_OPS): train another
 * session of the plan in its place, or none. That too is a card they tap, and what the phone
 * writes is the per-date override the app already has, for today and for no other day.
 */
import { readNumbers } from './cycle.js';

export const LIVE_OPS = ['change-remaining', 'remove-set', 'add-set', 'swap', 'skip'];
// What an answer may say about the day, before the session is started.
export const DAY_OPS = ['train', 'rest'];
// What the phone may send of a session, and what an answer may hold.
export const LIVE_ENTRIES_MAX = 30;
export const LIVE_ROWS_MAX = 20;          // rows of one exercise, warm-ups included
export const LIVE_WORK_SETS_MAX = 10;     // validate.js: a plan's exercise has 1-10 sets
export const LIVE_OPS_MAX = 4;
export const LIVE_FLAGS_MAX = 3;
export const LIVE_REPLY_MAX = 600;
export const LIVE_WHY_MAX = 300;
export const LIVE_THREAD_LINES = 8;
export const LIVE_THREAD_CHARS = 400;

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const list = v => (Array.isArray(v) ? v : []);
const same = (a, b) => a != null && b != null && String(a) === String(b);

/** The work sets of one exercise of the session, counted: all of them, the ones done, and the
 *  ones still to do. Warm-up rows are not work sets and are never an op's to change. */
export function liveCounts(entry) {
  const work = list(entry?.sets).filter(s => s && !s.warmup);
  const done = work.filter(s => s.done).length;
  return { work: work.length, done, left: work.length - done };
}

/**
 * An answer's ops and marks, checked against the session they are for.
 *
 * @param {object} data    the model's answer: `{ ops?: [...], flags?: [...] }`
 * @param {object} live    the session as payload.js liveContext read it: `{ entries: [{ id, mode, side?, sets: [{ done, warmup?, w?, r?, sec? }], flags? }] }`
 * @param {object} [opts]  `lookup(id)`: `{ name, cardio }` for an exercise that exists, null otherwise;
 *                         `flagKinds`: the marks an exercise can carry
 * @returns {{ ops: Array, flags: Array, errors: string[] }}
 */
export function cleanOps(data, live, { lookup = () => null, flagKinds = [] } = {}) {
  const errors = [];
  // An exercise is known by the place it has on the phone, which is not always its place in
  // this list: a row of the session that could not be read is left out, not renumbered.
  const entries = list(live?.entries).map((e, i) => (Number.isInteger(e.entry) ? e : { ...e, entry: i }));
  const byEntry = new Map(entries.map(e => [e.entry, e]));
  const listed = entries.map(e => `${e.entry} "${e.id}"`).join(', ') || '(none)';

  // Which exercise of the session something is about, or null with the reason written down.
  const entryOf = (c, where) => {
    const e = Number.isInteger(c.entry) ? byEntry.get(c.entry) : null;
    if (!e) { errors.push(`${where}.entry must be the "entry" number of an exercise in live.entries — the session holds: ${listed}`); return null; }
    if (!same(c.exId, e.id)) { errors.push(`${where}.exId "${c.exId}" is not the exercise at entry ${c.entry}, which is "${e.id}" — the session holds: ${listed}`); return null; }
    return e;
  };

  const ops = [];
  if (data?.ops != null && !Array.isArray(data.ops)) errors.push('ops must be an array — leave it out when nothing about the session should change');
  if (list(data?.ops).length > LIVE_OPS_MAX) errors.push(`ops holds ${data.ops.length} items and at most ${LIVE_OPS_MAX} are allowed — keep the ones that matter and say the rest in "reply"`);
  const taken = new Map();   // entry -> the ops already given for it
  list(data?.ops).slice(0, LIVE_OPS_MAX).forEach((c, i) => {
    const where = `ops[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!LIVE_OPS.includes(c.op)) { errors.push(`${where}.op "${c.op}" is not allowed — use one of: ${LIVE_OPS.join(', ')}`); return; }
    const e = entryOf(c, where);
    if (!e) return;
    if (!isStr(c.why)) { errors.push(`${where}.why is required — say what in this session, or which rule, the change rests on`); return; }

    // An exercise that is left out or replaced takes nothing else, and no op is given twice.
    const before = taken.get(c.entry) || [];
    const alone = k => k === 'skip' || k === 'swap';
    if (before.includes(c.op)) { errors.push(`${where} is a second "${c.op}" for entry ${c.entry} — put it in one op`); return; }
    if (before.length && (alone(c.op) || before.some(alone))) { errors.push(`${where}: entry ${c.entry} is skipped or swapped by another op, so nothing else can be changed on it`); return; }
    if ((c.op === 'add-set' && before.includes('remove-set')) || (c.op === 'remove-set' && before.includes('add-set'))) {
      errors.push(`${where}: entry ${c.entry} cannot have a set added and a set removed in one answer`); return;
    }

    const n = liveCounts(e);
    const out = { op: c.op, entry: c.entry, exId: e.id };
    const mark = errors.length;
    const perSide = v => { if (e.side && v != null && v % 2) { errors.push(`${where}.reps is for a per-side exercise, so it is the total across both sides and must be an even number`); return false; } return true; };

    if (c.op === 'change-remaining') {
      if (!n.left) { errors.push(`${where}: every work set of entry ${c.entry} is done — there is nothing left to change (add-set adds one)`); return; }
      if (e.mode === 'cardio') { errors.push(`${where}: entry ${c.entry} is cardio, which has no reps or load to change — say it in "reply"`); return; }
      if (c.sets != null || c.count != null) { errors.push(`${where}: change-remaining sets the reps, seconds or weight of the sets still to do; how many there are is add-set and remove-set`); return; }
      const num = readNumbers({ reps: c.reps, sec: c.sec, weight: c.weight }, e.mode, where, errors);
      if (errors.length > mark || !perSide(num.reps)) return;
      if (!Object.keys(num).length) { errors.push(`${where} sets nothing — give at least one of reps, sec or weight`); return; }
      // The sets still to do already at these numbers: said, but nothing to apply.
      const rest = list(e.sets).filter(s => s && !s.warmup && !s.done);
      const held = s => (num.weight == null || Number(s.w || 0) === num.weight) && (num.reps == null || s.r === num.reps) && (num.sec == null || s.sec === num.sec);
      if (rest.every(held)) return;
      Object.assign(out, num);
    } else if (c.op === 'remove-set' || c.op === 'add-set') {
      const count = c.count == null ? 1 : c.count;
      if (!isInt(count, 1, LIVE_WORK_SETS_MAX)) { errors.push(`${where}.count must be a whole number of sets, 1 or more`); return; }
      if (c.op === 'remove-set') {
        if (count > n.left) { errors.push(`${where}: entry ${c.entry} has ${n.left} work set${n.left === 1 ? '' : 's'} still to do, so ${count} cannot be removed — a set that is done stays done`); return; }
        if (count === n.left && !n.done) { errors.push(`${where} would leave entry ${c.entry} with no set at all — that is "skip"`); return; }
      } else {
        if (n.work + count > LIVE_WORK_SETS_MAX) { errors.push(`${where}: entry ${c.entry} has ${n.work} work sets, and with ${count} more it would pass the ${LIVE_WORK_SETS_MAX} allowed`); return; }
        // An added set is done at the numbers of the set before it unless it is given its own.
        const num = e.mode === 'cardio' ? {} : readNumbers({ reps: c.reps, sec: c.sec, weight: c.weight }, e.mode, where, errors);
        if (errors.length > mark || !perSide(num.reps)) return;
        Object.assign(out, num);
      }
      if (count > 1) out.count = count;
    } else if (c.op === 'swap') {
      if (!n.left) { errors.push(`${where}: every work set of entry ${c.entry} is done — there is nothing left to swap`); return; }
      const to = lookup(c.to);
      if (!isStr(c.to) || !to) { errors.push(`${where}.to "${c.to}" is not an exercise id from the library in the payload`); return; }
      if (same(c.to, e.id)) { errors.push(`${where} swaps an exercise for itself`); return; }
      const there = entries.find(x => same(x.id, c.to));
      if (there) { errors.push(`${where}.to "${c.to}" is already in this session, at entry ${there.entry} — bring in an exercise the session does not have`); return; }
      if (ops.some(o => o.op === 'swap' && same(o.to, c.to))) { errors.push(`${where}.to "${c.to}" is brought in by another swap of this answer — an exercise is in a session once`); return; }
      // What the replacement is done at. Left out, the phone keeps the sets and reps of what it
      // replaces and takes the weight from their own history of the new exercise.
      const mode = to.cardio ? 'cardio' : (c.sec != null && c.reps == null ? 'time' : 'reps');
      const num = readNumbers({ sets: c.sets, reps: c.reps, sec: c.sec, weight: c.weight }, mode, where, errors);
      if (errors.length > mark) return;
      Object.assign(out, { to: c.to, ...(to.name ? { name: to.name } : {}), ...num });
    } else if (!n.left) {
      errors.push(`${where}: every work set of entry ${c.entry} is done — there is nothing left to skip`); return;
    }
    taken.set(c.entry, [...before, c.op]);
    ops.push({ ...out, why: c.why.trim().slice(0, LIVE_WHY_MAX) });
  });

  // Marks the Coach puts on an exercise for what the person just said about it: the same fixed
  // words they can set themselves, so "the bar felt heavy" is counted like a mark they tapped.
  const flags = [];
  if (data?.flags != null && !Array.isArray(data.flags)) errors.push('flags must be an array');
  list(data?.flags).slice(0, LIVE_FLAGS_MAX).forEach((f, i) => {
    const where = `flags[${i}]`;
    if (!f || typeof f !== 'object') { errors.push(`${where} is not an object`); return; }
    const e = entryOf(f, where);
    if (!e) return;
    if (!flagKinds.includes(f.flag)) { errors.push(`${where}.flag "${f.flag}" is not one of: ${flagKinds.join(', ')}`); return; }
    if (list(e.flags).includes(f.flag) || flags.some(x => x.entry === f.entry && x.flag === f.flag)) return;
    flags.push({ entry: f.entry, exId: e.id, flag: f.flag });
  });

  return { ops, flags, errors };
}

/**
 * An answer's word on the day itself, checked against the session it is for.
 *
 * @param {object} data  the model's answer: `{ day?: { do, routine?, why }, ops? }`
 * @param {object} live  `{ pre, routineIds, routines: [{ id, name }] }`: whether the session is
 *                       still to be started, the routines it was built from, and the routines of
 *                       the plan that can be trained (payload.js liveContext; the phone's own
 *                       reading is coach-pre.js dayView)
 * @returns {{ day: { do, routine?, name?, why } | null, errors: string[] }}
 */
export function cleanDay(data, live) {
  const errors = [];
  const c = data?.day;
  if (c == null) return { day: null, errors };
  if (typeof c !== 'object' || Array.isArray(c)) { errors.push('day must be an object — leave it out when the planned session stands'); return { day: null, errors }; }
  if (!live?.pre) {
    errors.push('day is for a session that has not been started, and this one is under way — what is left of it is "skip", and what to do tomorrow is said in "reply"');
    return { day: null, errors };
  }
  if (!DAY_OPS.includes(c.do)) { errors.push(`day.do "${c.do}" is not allowed — use one of: ${DAY_OPS.join(', ')}`); return { day: null, errors }; }
  if (!isStr(c.why)) { errors.push('day.why is required — say what in their log, or which rule, it rests on'); return { day: null, errors }; }
  // Ops are for the session in front of them, and `day` puts another in its place or none.
  if (list(data.ops).length) {
    errors.push('an answer with "day" carries no ops: they would be for the session that "day" replaces or calls off. Give one or the other — once they take "day" they can ask again about the session it brings in');
    return { day: null, errors };
  }
  const out = { do: c.do };
  if (c.do === 'train') {
    const routines = list(live.routines);
    const to = routines.find(r => same(r.id, c.routine));
    if (!to) {
      errors.push(`day.routine "${c.routine}" is not a routine of plan.routines that holds an exercise — the plan holds: ${routines.map(r => `"${r.id}"`).join(', ') || '(none)'}`);
      return { day: null, errors };
    }
    if (list(live.routineIds).length === 1 && same(live.routineIds[0], to.id)) {
      errors.push(`day.routine "${c.routine}" is the session they are about to start — leave "day" out when the planned session stands`);
      return { day: null, errors };
    }
    Object.assign(out, { routine: to.id }, isStr(to.name) ? { name: to.name } : {});
  }
  return { day: { ...out, why: c.why.trim().slice(0, LIVE_WHY_MAX) }, errors };
}
