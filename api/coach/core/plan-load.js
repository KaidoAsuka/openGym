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
// Two more numbers from the same prompt, which are never an error: a plan under or over them is
// still a plan, and its owner is told (planLoadFindings). A body part that is trained at all
// should get this many sets a week (V1) —
export const WEEKLY_SETS_MIN = 4;
// — and not more in one session than about ten for a muscle group (V3), which by body part is
// half of what the week allows it.
export const SESSION_SETS_MAX = Object.fromEntries(Object.entries(WEEKLY_SETS_MAX).map(([bp, n]) => [bp, n / 2]));
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
  const load = count(plan, custom);
  return { weeklySets: load.weeklySets, sessions: load.sessions.map(({ byPart, ...s }) => s) };
}

// `planLoad`, with each session's sets by body part kept beside its totals.
function count(plan, custom) {
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
    const byPart = {};
    ids.forEach(id => {
      const l = loads.get(id);
      scheduled.add(id);
      sets += l.sets;
      minutes += l.minutes;
      for (const bp in l.byPart) {
        weeklySets[bp] = (weeklySets[bp] || 0) + l.byPart[bp];
        byPart[bp] = (byPart[bp] || 0) + l.byPart[bp];
      }
    });
    sessions.push({ key: 'day:' + d, weekday: d, routines: ids, sets, minutes: Math.round(minutes), byPart });
  }
  // A routine no weekday holds is still a session someone can start.
  for (const [id, l] of loads) {
    if (!scheduled.has(id)) sessions.push({ key: 'routine:' + id, routines: [id], sets: l.sets, minutes: Math.round(l.minutes), byPart: l.byPart });
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

/* ---------- where a plan sits outside the principles, as facts ----------
   The same count read four ways, each a code and the numbers behind it, with nothing worded:

     weekly-over        a body part over its weekly ceiling (V2)
     session-over       a training day over the session length the person gave (V6)
     weekly-under       a body part trained, but under WEEKLY_SETS_MIN a week (V1)
     session-part-over  a body part over SESSION_SETS_MAX in one session (V3)

   The first two are what a plan the Coach designed is rejected for. For a plan the person brought
   themselves all four are notes: it is their plan, and what they are owed is the count, not a
   refusal (validate.js). The repair round reads them as English sentences (findingErrors); a plan
   card reads them as they are and words them in the reader's language (advisoriesOf). */
export const HARD_FINDINGS = ['weekly-over', 'session-over'];
export const isHardFinding = f => HARD_FINDINGS.includes(f.code);

export function planLoadFindings(plan, { sessionMin, custom } = {}) {
  const load = count(plan, custom);
  const out = [];
  for (const [bp, max] of Object.entries(WEEKLY_SETS_MAX)) {
    const n = load.weeklySets[bp] || 0;
    if (n > max) out.push({ code: 'weekly-over', bp, sets: n, max });
  }
  const cap = numOf(sessionMin);
  if (cap) {
    load.sessions.forEach(s => {
      if (s.minutes > cap) out.push({ code: 'session-over', session: s, sets: s.sets, minutes: s.minutes, cap });
    });
  }
  for (const bp of Object.keys(WEEKLY_SETS_MAX)) {
    const n = load.weeklySets[bp] || 0;
    if (n > 0 && n < WEEKLY_SETS_MIN) out.push({ code: 'weekly-under', bp, sets: n, min: WEEKLY_SETS_MIN });
  }
  load.sessions.forEach(s => {
    for (const [bp, max] of Object.entries(SESSION_SETS_MAX)) {
      const n = s.byPart[bp] || 0;
      if (n > max) out.push({ code: 'session-part-over', session: s, bp, sets: n, max });
    }
  });
  return out;
}

/** The hard findings as errors for the repair round: the count, the limit, where the sets come
 *  from and what to take out. */
export function findingErrors(plan, findings, custom) {
  return findings.filter(isHardFinding).map(f => (f.code === 'weekly-over'
    ? `the plan gives "${f.bp}" ${f.sets} work sets a week, over the ${f.max} the app allows a body part (principle V2) — `
      + `they come from ${sourcesOf(plan, f.bp, custom)}. Take at least ${Math.ceil(f.sets - f.max)} of those sets out: fewer sets on an exercise, or one exercise less`
    : `${sessionName(plan, f.session)} comes to about ${f.minutes} minutes by the app's estimate (${f.sets} sets; principle V6 gives the arithmetic), `
      + `over the ${f.cap} minutes this person has for a session — take out about ${setsOver(f.minutes - f.cap)} sets, or pair exercises as supersets with "sg"`));
}

/**
 * What a new plan asks for beyond the limits, as errors for the repair round; none when it is
 * inside them. `sessionMin` is the intake's session length, and without one no duration is held.
 */
export function planLoadErrors(plan, { sessionMin, custom } = {}) {
  return findingErrors(plan, planLoadFindings(plan, { sessionMin, custom }), custom);
}

// A card has room for a handful; a plan with more than this to say about it has a summary for that.
export const ADVISORIES_MAX = 12;
const ROUTINE_NAMES_MAX = 80;

/**
 * Findings as a bundle carries them to the plan card: the code, the body part, the numbers, and
 * which session — the weekdays the week schedules it on, and the names of its routines. A routine
 * trained on two days is one note with both days, not the same sentence twice.
 * frontend/src/lib/coach-plan-notes.js words them; coach-plan-notes.test.js pins the two together.
 */
export function advisoriesOf(plan, findings) {
  const nameOf = id => list(plan?.routines).find(r => r.id === id)?.name || String(id);
  const out = [];
  const seen = new Map();
  for (const f of findings) {
    const o = { code: f.code };
    if (f.bp) o.bp = f.bp;
    if (f.session) o.routine = f.session.routines.map(nameOf).join(' + ').slice(0, ROUTINE_NAMES_MAX);
    for (const k of ['sets', 'max', 'min', 'minutes', 'cap']) if (f[k] != null) o[k] = f[k];
    const day = f.session?.weekday;
    const key = f.session ? [f.code, f.bp, f.session.routines.join('+'), f.sets, f.minutes].join('|') : null;
    const same = key && seen.get(key);
    if (same) { if (day != null) same.weekdays = [...(same.weekdays || []), day]; continue; }
    if (day != null) o.weekdays = [day];
    if (key) seen.set(key, o);
    out.push(o);
  }
  return out.slice(0, ADVISORIES_MAX);
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
