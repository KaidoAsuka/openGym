/* What a plan asks of a week, counted.
 *
 * Two numbers the principles prompt states as limits (prompts/principles.md, V2 and V6) and the
 * validator therefore has to be able to hold an answer to: the work sets a body part gets in a
 * week, and the minutes a training day comes to. Both are worked out here, from the plan alone,
 * so the model is never asked to add up sixty sets and the validator never takes its word for
 * the sum.
 *
 * The count is by body part (`bp`), the one taxonomy field the library slice gives the model for
 * every exercise it may name, and every set counts once. That is cruder than counting by muscle
 * with half-credit for synergists, which is how the research states its ranges, and it is crude
 * on purpose: the catalogue's muscle data credits a bench press to the biceps and a deadlift to
 * the calves, and counted that way an ordinary six-day push/pull/legs plan reads as 35 weekly
 * sets for the shoulders. A limit the validator enforces has to be one a sound plan stays under
 * and the model can check before it answers; the per-muscle range stays in the prompt, as
 * judgement.
 *
 * Pure, like the rest of core/: no file, no clock. The phone runs the same code when it brings
 * its own key.
 */
import { LIB_BY_ID, isStretch } from './library.js';

/* ---------- the limits ----------
   prompts/principles.md states these numbers to the model; api/test/plan-load.test.js pins the
   two together. */
// Work sets a week. One muscle group is held to 20 (V1); a body part that is two or three of
// them — the back of the arm and the front, the thigh and the hip — gets room for both.
export const WEEKLY_SETS_MAX = {
  chest: 20, shoulders: 20, back: 30, 'upper arms': 30, 'upper legs': 40,
  'lower legs': 20, waist: 20, 'lower arms': 20, neck: 20
};
// Minutes one set costs with its rest: a straight set, and a set of an exercise paired into a
// superset. create.md has always told the model "roughly 2-3 minutes per straight set".
export const SET_MINUTES = 2.5;
export const SUPERSET_SET_MINUTES = 1.5;
// A timed set is its hold plus this much rest, in seconds.
export const TIMED_REST_SEC = 60;
export const TIMED_SUPERSET_REST_SEC = 30;

const numOf = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const round1 = n => Math.round(n * 10) / 10;
const list = v => (Array.isArray(v) ? v : []);

/* ---------- reading one planned exercise ---------- */

/** A lookup from exercise id to body part for exercises the catalogue does not hold: the
 *  person's own (the payload's library slice flags them `custom`) and ones a new plan invents. */
export function customBodyParts(entries) {
  const m = new Map();
  list(entries).forEach(e => { if (e && e.id != null && typeof e.bp === 'string') m.set(e.id, e.bp.toLowerCase()); });
  return m;
}

// The same reading as payload.js modeOf: what the plan says, else cardio for a cardio exercise.
// Not imported from there because payload.js imports this file.
function modeOf(e, bp) {
  return e.mode === 'reps' || e.mode === 'time' || e.mode === 'cardio' ? e.mode : bp === 'cardio' ? 'cardio' : 'reps';
}

function readEx(e, custom) {
  const lib = LIB_BY_ID.get(e.id);
  const bp = lib ? lib.bp : custom?.get(e.id) || null;
  const mode = modeOf(e, bp);
  const sets = numOf(e.sets);
  // Counted toward a body part: lifting, not cardio and not mobility work.
  const counted = mode !== 'cardio' && bp && bp in WEEKLY_SETS_MAX && !(lib && isStretch(lib));
  return { id: e.id, bp, mode, sets, counted };
}

// A superset is adjacency: two neighbours carrying the same tag (history.js cleanupSg).
const paired = (ex, i) => !!ex[i].sg && (ex[i - 1]?.sg === ex[i].sg || ex[i + 1]?.sg === ex[i].sg);

/** One routine as a session: its work sets by body part, and the minutes it comes to. */
function routineLoad(routine, custom) {
  const ex = list(routine?.ex).filter(e => e && typeof e === 'object');
  const byPart = {};
  let sets = 0;
  let minutes = 0;
  ex.forEach((e, i) => {
    const r = readEx(e, custom);
    const inSuperset = paired(ex, i);
    if (r.mode === 'cardio') { minutes += r.sets * numOf(e.min); return; }
    sets += r.sets;
    if (r.mode === 'time') minutes += r.sets * (numOf(e.sec) + (inSuperset ? TIMED_SUPERSET_REST_SEC : TIMED_REST_SEC)) / 60;
    else minutes += r.sets * (inSuperset ? SUPERSET_SET_MINUTES : SET_MINUTES);
    if (r.counted) byPart[r.bp] = (byPart[r.bp] || 0) + r.sets;
  });
  return { sets, minutes, byPart };
}

/**
 * The week a plan schedules, counted.
 *
 * @param {object} plan     `{ routines, week }` — the payload's cleaned plan (a weekday holds a
 *                          list of routine ids) or a validated bundle (it holds one id)
 * @param {Map} [custom]    body parts of exercises the catalogue does not hold (customBodyParts)
 * @returns {{ weeklySets: object, sessions: Array }}  `weeklySets` by body part, over the week as
 *   scheduled; `sessions` one per training day, and one per routine no day schedules, each with
 *   its `key`, the routine ids trained, `sets` and whole `minutes`
 */
export function planLoad(plan, custom) {
  const routines = new Map(list(plan?.routines).filter(r => r && typeof r === 'object').map(r => [r.id, r]));
  const loads = new Map([...routines].map(([id, r]) => [id, routineLoad(r, custom)]));
  const weeklySets = {};
  const sessions = [];
  const scheduled = new Set();
  // Monday first, as the plan's own week is written out (payload.js cleanPlan).
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const ids = [].concat(plan?.week?.[d] ?? []).filter(id => routines.has(id));
    if (!ids.length) continue;
    let sets = 0;
    let minutes = 0;
    ids.forEach(id => {
      const l = loads.get(id);
      scheduled.add(id);
      sets += l.sets;
      minutes += l.minutes;
      for (const bp in l.byPart) weeklySets[bp] = (weeklySets[bp] || 0) + l.byPart[bp];
    });
    sessions.push({ key: 'day:' + d, weekday: d, routines: ids, sets, minutes: Math.round(minutes) });
  }
  // A routine no weekday holds is still a session someone can start.
  for (const [id, l] of loads) {
    if (!scheduled.has(id)) sessions.push({ key: 'routine:' + id, routines: [id], sets: l.sets, minutes: Math.round(l.minutes) });
  }
  return { weeklySets: Object.fromEntries(Object.entries(weeklySets).map(([bp, n]) => [bp, round1(n)])), sessions };
}

/** `planLoad` as the model reads it (payload.planLoad): the count by body part, and each
 *  training day with its routines, sets and estimated minutes. Null for a plan with nothing
 *  scheduled, where there is no week to count. */
export function planLoadForPayload(plan, custom) {
  const load = planLoad(plan, custom);
  const days = load.sessions.filter(s => s.weekday != null).map(s => ({ weekday: s.weekday, routines: s.routines, sets: s.sets, minutes: s.minutes }));
  return days.length ? { weeklySets: load.weeklySets, days } : null;
}

/* ---------- a review's changes, laid over the plan ----------
   The changes are checked one at a time against the plan as it stands; what they add up to is
   only visible once they are applied. This applies them the way the phone will
   (frontend/src/lib/coach.js CHANGE_APPLY), to a copy, for the types that move a set count, a
   duration, a superset or a weekday. frontend/src/lib/coach-load.test.js runs the phone's own
   apply beside it and compares the counts.

   One known difference: a swap keeps the mode the plan resolved for the old exercise, where the
   phone resolves it again for the new one. They part only when lifting is swapped for cardio. */
export function projectPlan(plan, changes) {
  const routines = list(plan?.routines).filter(r => r && typeof r === 'object')
    .map(r => ({ ...r, ex: list(r.ex).filter(e => e && typeof e === 'object').map(e => ({ ...e })) }));
  const week = {};
  Object.keys(plan?.week || {}).forEach(d => { const ids = [].concat(plan.week[d] ?? []); if (ids.length) week[d] = ids; });
  const out = { routines, week };
  const routineOf = c => out.routines.find(r => r.id === c.target?.routineId);
  const exOf = c => routineOf(c)?.ex.find(e => e.id === c.target?.exId);
  const cleanupSg = ex => ex.forEach((e, i) => { if (e.sg && !(ex[i - 1]?.sg === e.sg || ex[i + 1]?.sg === e.sg)) delete e.sg; });
  // The defaults are the phone's: an added exercise without a count gets three sets, a hold 45
  // seconds, cardio 20 minutes. A new routine's cardio gets no minutes there, so none here.
  const fresh = (a, inNewRoutine) => {
    const mode = a.mode || 'reps';
    const o = { id: a.id, sets: a.sets || 3, mode };
    if (mode === 'time') o.sec = a.sec || 45;
    else if (mode === 'cardio' && !inNewRoutine) o.min = a.min || 20;
    else o.reps = a.reps || 10;
    return o;
  };

  list(changes).forEach((c, n) => {
    const r = routineOf(c);
    const a = c.after;
    switch (c.type) {
      case 'add-exercise': {
        if (!r || !a) return;
        const at = Number.isInteger(a.position) ? Math.min(a.position, r.ex.length) : r.ex.length;
        r.ex.splice(at, 0, fresh(a, false));
        cleanupSg(r.ex);
        return;
      }
      case 'remove-exercise':
        if (!r) return;
        r.ex = r.ex.filter(e => e.id !== c.target.exId);
        cleanupSg(r.ex);
        return;
      case 'swap-exercise': {
        const i = r ? r.ex.findIndex(e => e.id === c.target.exId) : -1;
        if (i < 0 || !a) return;
        r.ex[i] = { ...r.ex[i], id: a.id, ...(a.sets ? { sets: a.sets } : {}), ...(a.reps ? { reps: a.reps } : {}) };
        return;
      }
      case 'sets': { const e = exOf(c); if (e) e.sets = a; return; }
      case 'sec': { const e = exOf(c); if (e) e.sec = a; return; }
      case 'cardio': { const e = exOf(c); if (e && a?.min != null) e.min = a.min; return; }
      case 'reorder': {
        if (!r || !Array.isArray(a)) return;
        const by = new Map(r.ex.map(e => [e.id, e]));
        r.ex = a.map(id => by.get(id)).filter(Boolean);
        cleanupSg(r.ex);
        return;
      }
      case 'superset': {
        const i = r ? r.ex.findIndex(e => e.id === c.target.exId) : -1;
        if (i < 0) return;
        if (!a?.link) { delete r.ex[i].sg; cleanupSg(r.ex); return; }
        const j = r.ex.findIndex(e => e.id === a.with);
        if (j < 0 || j === i) return;
        const [partner] = r.ex.splice(j, 1);
        const at = r.ex.findIndex(e => e.id === c.target.exId);
        r.ex.splice(at + 1, 0, partner);
        // The phone mints a tag of its own; any tag these two share and nothing else does will do.
        r.ex[at].sg = r.ex[at + 1].sg = 'sg+' + n;
        return;
      }
      case 'add-routine':
        // The phone gives it an id when it is applied, so nothing in this same set can schedule it.
        if (a) out.routines.push({ id: '+' + n, name: a.name, ex: list(a.ex).map(e => fresh(e, true)) });
        return;
      case 'remove-routine':
        out.routines = out.routines.filter(x => x.id !== c.target?.routineId);
        Object.keys(out.week).forEach(d => {
          const next = out.week[d].filter(id => id !== c.target?.routineId);
          if (next.length) out.week[d] = next; else delete out.week[d];
        });
        return;
      case 'week': {
        const d = c.target?.weekday;
        if (a == null || a === 'rest') delete out.week[d];
        else out.week[d] = [a];
        return;
      }
      default:
        // reps, rep range, load step, policies, a rename: none of them moves a count.
    }
  });
  return out;
}

/* ---------- holding a plan to the limits ---------- */

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Where a body part's weekly sets come from, as a phrase the repair round can act on. */
function sourcesOf(plan, bp, custom) {
  const timesTrained = new Map();
  Object.values(plan?.week || {}).forEach(v => [].concat(v ?? []).forEach(id => timesTrained.set(id, (timesTrained.get(id) || 0) + 1)));
  const parts = [];
  list(plan?.routines).forEach(r => {
    const times = timesTrained.get(r?.id) || 0;
    if (!times) return;
    list(r.ex).forEach(e => {
      const x = readEx(e, custom);
      if (x.counted && x.bp === bp && x.sets) parts.push(`"${e.id}" ${x.sets}${times > 1 ? ' x' + times : ''} in "${r.name || r.id}"`);
    });
  });
  return parts.join(', ');
}

const sessionName = (plan, s) => {
  const names = s.routines.map(id => `"${list(plan?.routines).find(r => r.id === id)?.name || id}"`).join(' + ');
  return s.weekday != null ? `${DAY[s.weekday]} (${names})` : `routine ${names}`;
};

const setsOver = minutes => Math.max(1, Math.ceil(minutes / SET_MINUTES));

/**
 * What a new plan asks for beyond the limits, as errors for the repair round; none when it is
 * inside them. `sessionMin` is the intake's session length, and without one no duration is held.
 */
export function planLoadErrors(plan, { sessionMin, custom } = {}) {
  const load = planLoad(plan, custom);
  const errors = [];
  for (const [bp, max] of Object.entries(WEEKLY_SETS_MAX)) {
    const n = load.weeklySets[bp] || 0;
    if (n > max) {
      errors.push(`the plan gives "${bp}" ${n} work sets a week, over the ${max} the app allows a body part (principle V2) — `
        + `they come from ${sourcesOf(plan, bp, custom)}. Take at least ${Math.ceil(n - max)} of those sets out: fewer sets on an exercise, or one exercise less`);
    }
  }
  const cap = numOf(sessionMin);
  if (cap) {
    load.sessions.forEach(s => {
      if (s.minutes > cap) {
        errors.push(`${sessionName(plan, s)} comes to about ${s.minutes} minutes by the app's estimate (${s.sets} sets; principle V6 gives the arithmetic), `
          + `over the ${cap} minutes this person has for a session — take out about ${setsOver(s.minutes - cap)} sets, or pair exercises as supersets with "sg"`);
      }
    });
  }
  return errors;
}

/**
 * What a review's changes push past the limits. Only what the changes themselves made worse: a
 * body part or a day that was already over — the plan is the lifter's to edit by hand — and is
 * left as it was, or brought down, is no error.
 */
export function changeLoadErrors(plan, changes, { sessionMin, custom } = {}) {
  const after = projectPlan(plan, changes);
  const was = planLoad(plan, custom);
  const now = planLoad(after, custom);
  const errors = [];
  for (const [bp, max] of Object.entries(WEEKLY_SETS_MAX)) {
    const n = now.weeklySets[bp] || 0;
    const before = was.weeklySets[bp] || 0;
    if (n > max && n > before) {
      errors.push(`with these changes "${bp}" goes from ${before} to ${n} work sets a week, over the ${max} the app allows a body part (principle V2) — `
        + `after the changes they come from ${sourcesOf(after, bp, custom)}. Drop or shrink the changes that add sets there, or take ${Math.ceil(n - Math.max(max, before))} sets off elsewhere in the same body part`);
    }
  }
  const cap = numOf(sessionMin);
  if (cap) {
    const wasAt = new Map(was.sessions.map(s => [s.key, s.minutes]));
    now.sessions.forEach(s => {
      const before = wasAt.get(s.key) || 0;
      if (s.minutes > cap && s.minutes > before) {
        errors.push(`with these changes ${sessionName(after, s)} goes from about ${before} to about ${s.minutes} minutes by the app's estimate (principle V6 gives the arithmetic), `
          + `over the ${cap} minutes this person has for a session — make room first (a set less elsewhere in that session, or a superset), or leave out what lengthens it`);
      }
    });
  }
  return errors;
}
