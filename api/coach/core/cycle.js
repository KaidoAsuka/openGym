/* A cycle: the weeks of a plan when they are not all the same week.
 *
 * The app trains one week and repeats it; its own engine moves the weight. That is one way to
 * train and not the only one — a Russian squat routine is eighteen sessions, each different, and
 * most of what people run past their first year is laid out over weeks. So a plan may carry a
 * cycle: for each week, what each routine's exercises are done at that week — sets, reps and the
 * weight. The Coach writes it when it makes the plan, and goes on correcting the weeks not yet
 * trained as the log comes in (prompts/adjust.md).
 *
 * The app's plan stays one week. The phone writes the current week's numbers from the cycle into
 * the routines (frontend/src/lib/coach-cycle.js), and an exercise whose weight the cycle sets has
 * the app's own progression switched off, so two things do not move the same number.
 *
 * A week says only what it changes. Read in order, each week stands on the ones before it: an
 * exercise the week does not mention is done as in the latest week that did, and before any of
 * them as the routine held it when the cycle began (`base`). So a far week can be left rough —
 * a line of intent and no numbers — and still be trainable when it comes.
 *
 * This file has no imports on purpose. Both runtimes use it — the server to check an answer,
 * the phone to lay the week out — and the phone's main bundle must not pull the catalogue in
 * behind it. frontend/src/lib/coach-cycle.test.js and api/test/cycle.test.js pin the two uses.
 */

export const CYCLE_WEEKS_MAX = 26;        // payload.js BLOCK_WEEKS_MAX
export const CYCLE_FOCUS_MAX = 160;
export const CYCLE_ROUTINES_MAX = 7;      // validate.js MAX_ROUTINES
export const CYCLE_EX_MAX = 20;           // validate.js MAX_EX_PER_ROUTINE
export const WEIGHT_MAX = 1000;           // validate.js MAX_WEIGHT
export const ADJUST_CHANGES_MAX = 30;
export const ADJUST_WHY_MAX = 300;
export const ADJUST_SUMMARY_MAX = 600;
export const ADJUST_NOTES_MAX = 4;

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const list = v => (Array.isArray(v) ? v : []);
// Quarter-kilo plates exist; a third decimal is a rounding error, not a plate.
const round2 = n => Math.round(n * 100) / 100;

/* ---------- the numbers one line may set ---------- */

/**
 * Sets, reps, seconds and weight, each read by name and held to its range. `mode` is the
 * exercise's logging mode, which decides which of them mean anything: a hold has seconds and no
 * reps, cardio has neither a rep target nor a load.
 *
 * @param {string[]} problems  gets one line for each field that is present and unusable
 * @returns the fields that were given and are good; empty when none were
 */
export function readNumbers(e, mode, where, problems = []) {
  const o = {};
  if (e.sets != null) {
    if (isInt(e.sets, 1, 10)) o.sets = e.sets;
    else problems.push(`${where}.sets must be a whole number of sets (1-10)`);
  }
  if (e.reps != null) {
    if (mode === 'time' || mode === 'cardio') problems.push(`${where}.reps does not apply: this exercise is logged by ${mode === 'time' ? 'time (use "sec")' : 'minutes'}`);
    else if (isInt(e.reps, 1, 100)) o.reps = e.reps;
    else problems.push(`${where}.reps must be a whole number of reps (1-100)`);
  }
  if (e.sec != null) {
    if (mode !== 'time') problems.push(`${where}.sec does not apply: this exercise is not a timed hold`);
    else if (isInt(e.sec, 5, 3600)) o.sec = e.sec;
    else problems.push(`${where}.sec must be seconds (5-3600)`);
  }
  if (e.weight != null) {
    if (mode === 'cardio') problems.push(`${where}.weight does not apply to cardio`);
    else if (typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0 && e.weight <= WEIGHT_MAX) o.weight = round2(e.weight);
    else problems.push(`${where}.weight must be a positive number in the lifter's unit, no larger than ${WEIGHT_MAX}`);
  }
  return o;
}

const NUMBER_KEYS = ['sets', 'reps', 'sec', 'weight'];
const numbersOnly = e => { const o = {}; for (const k of NUMBER_KEYS) if (e && e[k] != null) o[k] = e[k]; return o; };

/* ---------- reading a cycle someone wrote ---------- */

/**
 * The weeks of a cycle, checked against the routines they are for.
 *
 * @param {Array} raw        `[{ week, focus?, sessions?: [{ routine, ex: [{ id, sets?, reps?, sec?, weight? }] }] }]`
 * @param {Array} routines   `[{ id, ex: [{ id, mode?, side? }] }]` — the plan the cycle runs on
 * @param {number} weeks     how long the cycle is
 * @returns {{ plan: Array, errors: string[] }}  `plan` sorted by week, each week once
 */
export function cleanCyclePlan(raw, routines, weeks) {
  const errors = [];
  const byId = new Map(list(routines).map(r => [r.id, r]));
  const seenWeeks = new Set();
  const plan = [];
  list(raw).slice(0, CYCLE_WEEKS_MAX).forEach((w, wi) => {
    const at = `cycle[${wi}]`;
    if (!w || typeof w !== 'object') { errors.push(`${at} is not an object`); return; }
    if (!isInt(w.week, 1, weeks)) { errors.push(`${at}.week must be a week of this cycle, 1 to ${weeks}`); return; }
    if (seenWeeks.has(w.week)) { errors.push(`${at}: week ${w.week} is listed twice — say everything about a week in one entry`); return; }
    seenWeeks.add(w.week);
    const out = { week: w.week };
    if (isStr(w.focus)) out.focus = w.focus.trim().slice(0, CYCLE_FOCUS_MAX);
    const sessions = [];
    const seenRoutines = new Set();
    list(w.sessions).slice(0, CYCLE_ROUTINES_MAX).forEach((s, si) => {
      const where = `${at}.sessions[${si}]`;
      const r = s && byId.get(s.routine);
      if (!r) { errors.push(`${where}.routine "${s && s.routine}" is not one of the routines of this plan (${[...byId.keys()].map(id => `"${id}"`).join(', ')})`); return; }
      if (seenRoutines.has(r.id)) { errors.push(`${where}: routine "${r.id}" appears twice in week ${w.week} — a routine has one set of numbers a week`); return; }
      seenRoutines.add(r.id);
      const ex = [];
      const seenEx = new Set();
      list(s.ex).slice(0, CYCLE_EX_MAX).forEach((e, ei) => {
        const here = `${where}.ex[${ei}]`;
        const planned = e && list(r.ex).find(x => x.id === e.id);
        if (!planned) { errors.push(`${here}.id "${e && e.id}" is not an exercise of routine "${r.id}" — a week sets numbers for the routine's own exercises: ${list(r.ex).map(x => `"${x.id}"`).join(', ')}`); return; }
        if (seenEx.has(e.id)) { errors.push(`${here}.id "${e.id}" appears twice in this session`); return; }
        seenEx.add(e.id);
        const n = readNumbers(e, planned.mode || 'reps', here, errors);
        // Reps of a unilateral exercise are the total across both sides (common.md), so they are even.
        if (planned.side && n.reps != null && n.reps % 2) { errors.push(`${here}.reps is for a per-side exercise, so it is the total across both sides and must be an even number`); return; }
        if (Object.keys(n).length) ex.push({ id: e.id, ...n });
      });
      if (ex.length) sessions.push({ routine: r.id, ex });
    });
    if (sessions.length) out.sessions = sessions;
    if (out.focus || out.sessions) plan.push(out);
  });
  plan.sort((a, b) => a.week - b.week);
  return { plan, errors };
}

/* ---------- what a week is trained at ---------- */

/**
 * The numbers every exercise of the cycle is done at in one week: the base, with each week up
 * to and including that one laid over it in order.
 *
 * @param {object} base   `{ [routineId]: { [exId]: { sets?, reps?, sec?, weight? } } }`
 * @param {Array} plan    the cycle's weeks (cleanCyclePlan)
 * @param {number} week   1-based
 * @returns {Map<string, Map<string, object>>} routine id → exercise id → `{ sets?, reps?, sec?, weight?, set? }`,
 *   `set` naming the week that last gave the exercise a number (absent when only the base did)
 */
export function numbersAt(base, plan, week) {
  const out = new Map();
  for (const rid of Object.keys(base || {})) {
    const m = new Map();
    for (const exId of Object.keys(base[rid] || {})) m.set(exId, numbersOnly(base[rid][exId]));
    out.set(rid, m);
  }
  list(plan).filter(w => w && w.week <= week).sort((a, b) => a.week - b.week).forEach(w => {
    list(w.sessions).forEach(s => {
      if (!out.has(s.routine)) out.set(s.routine, new Map());
      const m = out.get(s.routine);
      list(s.ex).forEach(e => { m.set(e.id, { ...(m.get(e.id) || {}), ...numbersOnly(e), set: w.week }); });
    });
  });
  return out;
}

/** A plan `{ routines, week }` with one cycle week's numbers written over its exercises — a copy. */
export function planAt(plan, base, cyclePlan, week) {
  const at = numbersAt(base, cyclePlan, week);
  return {
    week: plan?.week || {},
    routines: list(plan?.routines).map(r => {
      const m = at.get(r.id);
      return m ? { ...r, ex: list(r.ex).map(e => (m.has(e.id) ? { ...e, ...numbersOnly(m.get(e.id)) } : e)) } : r;
    })
  };
}

/** The numbers a set of routines holds right now, as a cycle's `base`. */
export function baseOf(routines) {
  const base = {};
  list(routines).forEach(r => {
    base[r.id] = {};
    list(r.ex).forEach(e => { base[r.id][e.id] = numbersOnly(e); });
  });
  return base;
}

/* ---------- which week it is ---------- */

const DAY = 86400000;
const noon = iso => Date.parse(String(iso).slice(0, 10) + 'T12:00:00Z');

/** The week of the cycle a day falls in, counting whole weeks from the day it began: 1 on the
 *  first seven days, and on past the last week when the cycle has run out. Null before it
 *  begins or for a date that does not parse. */
export function cycleWeekOn(startedAt, today) {
  const a = noon(startedAt), b = noon(today);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.floor(Math.round((b - a) / DAY) / 7) + 1;
}

/* ---------- changing the weeks not yet trained ---------- */

/**
 * Changes laid into a cycle's weeks: `[{ week, routine, exId, sets?, reps?, sec?, weight? }]`,
 * and `[{ week, focus }]`. A copy; the weeks given are not touched.
 */
export function withChanges(plan, changes, focus) {
  const weeks = new Map(list(plan).map(w => [w.week, { ...w, sessions: list(w.sessions).map(s => ({ ...s, ex: list(s.ex).map(e => ({ ...e })) })) }]));
  const weekOf = n => { if (!weeks.has(n)) weeks.set(n, { week: n, sessions: [] }); return weeks.get(n); };
  list(changes).forEach(c => {
    const w = weekOf(c.week);
    let s = w.sessions.find(x => x.routine === c.routine);
    if (!s) { s = { routine: c.routine, ex: [] }; w.sessions.push(s); }
    let e = s.ex.find(x => x.id === c.exId);
    if (!e) { e = { id: c.exId }; s.ex.push(e); }
    Object.assign(e, numbersOnly(c));
  });
  list(focus).forEach(f => { if (isStr(f.focus)) weekOf(f.week).focus = f.focus.trim().slice(0, CYCLE_FOCUS_MAX); });
  return [...weeks.values()]
    .map(w => { const o = { week: w.week }; if (w.focus) o.focus = w.focus; if (w.sessions.length) o.sessions = w.sessions; return o; })
    .filter(w => w.focus || w.sessions)
    .sort((a, b) => a.week - b.week);
}

/**
 * A daily answer's changes, checked against the cycle they are for.
 *
 * @param {object} data     the model's answer: `{ changes: [...], weeks?: [{ week, focus }] }`
 * @param {object} cycle    `{ weeks, routines: [{ id, ex: [{ id, mode?, side? }] }] }` — what is running
 * @param {number} fromWeek the current week: nothing before it can be changed, it has been trained
 * @returns {{ changes: Array, focus: Array, errors: string[] }}
 */
export function cleanChanges(data, cycle, fromWeek) {
  const errors = [];
  const byId = new Map(list(cycle?.routines).map(r => [r.id, r]));
  const last = cycle?.weeks || 0;
  const inRange = w => isInt(w, Math.max(1, fromWeek), last);
  const changes = [];
  const seen = new Set();
  list(data?.changes).slice(0, ADJUST_CHANGES_MAX).forEach((c, i) => {
    const where = `changes[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!inRange(c.week)) { errors.push(`${where}.week must be a week that is still to come or under way, ${Math.max(1, fromWeek)} to ${last} — earlier weeks have been trained`); return; }
    const r = byId.get(c.routine);
    if (!r) { errors.push(`${where}.routine "${c.routine}" is not one of the cycle's routines (${[...byId.keys()].map(id => `"${id}"`).join(', ')})`); return; }
    const planned = list(r.ex).find(x => x.id === c.exId);
    if (!planned) { errors.push(`${where}.exId "${c.exId}" is not an exercise of routine "${r.id}": ${list(r.ex).map(x => `"${x.id}"`).join(', ')}`); return; }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — say what in the log, or which rule of the programme, the change rests on`); return; }
    const key = c.week + '|' + r.id + '|' + c.exId;
    if (seen.has(key)) { errors.push(`${where} changes the same exercise in the same week as an earlier change — put the numbers in one change`); return; }
    seen.add(key);
    const before = errors.length;
    const n = readNumbers(c, planned.mode || 'reps', where, errors);
    if (errors.length > before) return;
    if (planned.side && n.reps != null && n.reps % 2) { errors.push(`${where}.reps is for a per-side exercise, so it is the total across both sides and must be an even number`); return; }
    if (!Object.keys(n).length) { errors.push(`${where} sets nothing — give at least one of sets, reps, sec or weight`); return; }
    changes.push({ week: c.week, routine: r.id, exId: c.exId, ...n, why: c.why.trim().slice(0, ADJUST_WHY_MAX) });
  });
  const focus = [];
  const seenFocus = new Set();
  list(data?.weeks).slice(0, CYCLE_WEEKS_MAX).forEach((w, i) => {
    if (!w || typeof w !== 'object' || !isStr(w.focus)) return;
    if (!inRange(w.week)) { errors.push(`weeks[${i}].week must be ${Math.max(1, fromWeek)} to ${last}`); return; }
    if (seenFocus.has(w.week)) return;
    seenFocus.add(w.week);
    focus.push({ week: w.week, focus: w.focus.trim().slice(0, CYCLE_FOCUS_MAX) });
  });
  return { changes, focus, errors };
}
