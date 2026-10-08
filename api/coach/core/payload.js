/* What actually leaves this server.
 *
 * The consent screen makes a promise about which categories of data reach the provider, and
 * this file is where that promise is either kept or quietly broken. So it is built as an
 * allowlist: every field is copied in by name. Nothing is spread, nothing is passed through,
 * and a field added to the state blob next year cannot ride along by accident — which is the
 * property the FR-11 test actually asserts.
 *
 * Excluded on purpose and permanently: the profile's display name and user id (an opaque
 * handle stands in), passkey and credential material, push subscriptions, invite data, theme
 * and appearance settings, and every other profile's everything.
 */
import { glyphStr } from './glyphs.js';
import { LIBRARY, LIB_BY_ID, libraryHas, libraryName, librarySlice, isStretch, MAX_LIBRARY } from './library.js';
import { planLoadForPayload, customBodyParts } from './plan-load.js';
import { programsForPayload, programBrief } from './kb.js';
import { cleanCyclePlan, numbersAt, cycleWeekOn, CYCLE_WEEKS_MAX, CYCLE_FOCUS_MAX } from './cycle.js';
import { liveCounts, LIVE_OPS, LIVE_ENTRIES_MAX, LIVE_ROWS_MAX, LIVE_THREAD_LINES, LIVE_THREAD_CHARS } from './live.js';

export const CONTRACT = 1;
// Bounds from FR-22. A review reads a training block, not a training career: more history
// makes the payload bigger and the reading vaguer, not better.
export const MAX_WEEKS = 12;
export const MAX_SESSIONS = 60;
// The most a session note can be: the app's own cap (frontend/src/lib/history.js NOTE_MAX, pinned
// by api/test/payload-parity.test.js), so a note the athlete wrote arrives whole and the bound only
// holds for a document edited outside the app. It was 300 here, and a 500-character note reached
// the model cut off mid-sentence.
export const NOTE_MAX = 500;
// Last-resort ceiling for a free-text note/refine (issue #267). The real limit is the admin's
// `maxMessageLen`, enforced in jobs.js before a message ever reaches this module — this module
// stays a pure allowlist with no config import of its own, so it keeps its own constant instead.
// It has to stay >= config.js's MAX_MESSAGE_LEN_CEILING, or a raised admin limit would still get
// clipped back down here.
export const MAX_NOTE_CHARS = 4000;
// The ceiling on a whole payload, as JSON characters, which the server checks before a job
// leaves (jobs.js). Every field below is bounded on its own; this is the backstop for how many
// of them there are, and for a field added later that nobody bounded. A deliberately extreme
// history (30 routines of 12 exercises, 200 custom exercises, 60 twelve-exercise sessions in
// the review window) builds a review of about 240k; ordinary ones stay under 50k.
export const MAX_PAYLOAD_CHARS = 300_000;

/* ---------- what a person typed, bounded ----------
   Every free-text field below rides into the prompt, and the prompt is paid for by whoever runs
   the instance: the Coach spends one instance-wide key. The intake screen caps what it lets you
   type, but this module never sees that screen. It reads the profile from a POST body or from
   the synced state, and a client can fill either with megabytes (the only server limit is the
   5 MB body cap). So the text is cut here, the one place both the server and the phone build a
   payload, to the limits the intake screen shows (CoachIntake.jsx). The system prompt already
   reads this text as data rather than instruction (common rule 3); the bound is about size.
   A field of the wrong type reads as absent rather than as "[object Object]". */
export const PROFILE_TEXT_MAX = { limitations: 600, likes: 300, dislikes: 300, notes: 600, ownPlan: 1500 };
// Goal and experience are enum words today (strength, returning, ...); 40 leaves room for new
// ones without letting either carry a paragraph.
export const PROFILE_WORD_MAX = 40;
// The equipment taxonomy has 28 values, the longest 20 characters.
export const PROFILE_EQUIPMENT_MAX = 40;
// Routine, workout and custom-exercise names have no length limit in the app. The Coach writes
// its own names at 40 (validate.js); twice that keeps any name a person would really type.
export const NAME_MAX = 80;
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const word = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/** A language tag's shape ('de', 'pt-BR', 'zh_Hant'), or null — for a language that arrives with
 *  a request or from the environment rather than from the state (#303). */
export const langTag = v => (typeof v === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v.trim()) ? v.trim() : null);
// Zero reads as absent, as `|| null` always made it; anything else is clamped into range.
const count = (v, lo, hi) => {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};
// A weekday is 0-6, as a number or a one-digit string; null must not turn into Sunday.
const weekday = d => (typeof d === 'number' ? d : typeof d === 'string' && /^\d$/.test(d) ? Number(d) : NaN);

/* ---------- what the plan and the log hold, bounded by type ----------
   The plan, the logged sets, the body-weight series and the exercise ids come from the same
   client-written state as the profile, and PUT /api/data checks no more than that workouts and
   routines are arrays. A field copied as it came is a field that can carry a megabyte of text
   into the prompt, so each one is read by what it is meant to be. Anything else reads as
   absent, as a wrong-typed profile field does. */
// The app's own ids are uid() (13 characters) or a four-digit catalogue number; 64 is room for
// any id an import or an older build ever wrote, and no room for a paragraph.
export const ID_MAX = 64;
// The progression engine's policies (frontend/src/lib/progression.js POLICIES, validate.js).
const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'];
const ident = v => (typeof v === 'string' ? v.slice(0, ID_MAX) : typeof v === 'number' && Number.isFinite(v) ? v : null);
const policy = v => (POLICIES.includes(v) ? v : null);
// A finite number, or a number written as a short string (the app writes numbers, but a
// hand-made import may not, and the model reads "20" as well as 20). Kept as given rather than
// converted, so a Coach change's `before` still equals what the plan holds.
const NUMERIC = /^-?\d{1,9}(\.\d{1,6})?$/;
const num = v => ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMERIC.test(v)) ? v : undefined);
// A date is the ISO day every screen writes; anything else is not a date.
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const list = v => (Array.isArray(v) ? v : []);
function cleanProfile(profile) {
  const days = Array.isArray(profile.preferredDays) ? profile.preferredDays : [];
  const equipment = Array.isArray(profile.equipment) ? profile.equipment : [];
  return {
    goal: word(profile.goal, PROFILE_WORD_MAX),
    experience: word(profile.experience, PROFILE_WORD_MAX),
    daysPerWeek: count(profile.daysPerWeek, 1, 7),
    // Weekdays 0-6, each once: seven entries is the whole week, so anything past that is noise.
    preferredDays: [...new Set(days.map(weekday).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))],
    sessionMin: count(profile.sessionMin, 1, 24 * 60),
    equipment: equipment.filter(e => typeof e === 'string' && e).slice(0, PROFILE_EQUIPMENT_MAX).map(e => e.slice(0, PROFILE_WORD_MAX)),
    limitations: text(profile.limitations, PROFILE_TEXT_MAX.limitations),
    likes: text(profile.likes, PROFILE_TEXT_MAX.likes),
    dislikes: text(profile.dislikes, PROFILE_TEXT_MAX.dislikes),
    notes: text(profile.notes, PROFILE_TEXT_MAX.notes),
    // A plan they want to train, in their words. Absent rather than empty when they wrote none:
    // its presence is what tells a job the plan is theirs (create.md, validate.js).
    ...(text(profile.ownPlan, PROFILE_TEXT_MAX.ownPlan).trim() ? { ownPlan: text(profile.ownPlan, PROFILE_TEXT_MAX.ownPlan).trim() } : {})
  };
}

/* ---------- the data categories the consent screen names (FR-09/10) ----------
   Kept here, next to the code that acts on it, and rendered by the consent UI from the same
   list — a screen that drifts from the payload is worse than no screen. */
export { DATA_CATEGORIES } from './categories.js';

/* ---------- reading a session the way the engine reads it ----------
   Duplicated from frontend/src/lib/history.js rather than shared: the two runtimes have no
   build step in common, and this is the same trade-off server.js already made for
   effectiveRoutineId. frontend/src/lib/coach-parity.test.js pins modeOf, isBw and isPerSide
   against the frontend's own copies over a shared table of configs, so the duplicate cannot
   drift silently — which it otherwise would have, quietly, when v1.2.4 taught the app about
   bodyweight work. isWarmupSet and readSession are duplicated the same way but were pinned by
   nothing; api/test/payload-parity.test.js pins them now. It has to be a separate file: that
   test imports the frontend's own readSession, and a vitest test cannot import into a
   node:test file or back. */
export const modeOf = (cfg, ex) => {
  const m = cfg && cfg.mode;
  if (m === 'reps' || m === 'time' || m === 'cardio') return m;
  return ex && ex.bp === 'cardio' ? 'cardio' : 'reps';
};

/* Two flags that ride on top of a mode rather than making new ones (upstream #31/#32), and
   both matter to the Coach for the same reason: on a bodyweight exercise `w` is *added* load,
   so it is 0 on a perfectly good session, and every load-shaped signal — volume, e1RM, "is it
   going up" — reads as a flat zero. A Coach that could not see this would look at a push-up
   progression that is working and propose adding weight to a push-up.

   Absent reads as false on every plan written before these existed, exactly as upstream. */
export const isBw = (cfg, ex) =>
  (cfg && cfg.bodyweight != null ? !!cfg.bodyweight : (ex && ex.eq) === 'body weight');
export const isPerSide = cfg => !!(cfg && cfg.side);
// Mirror of frontend/src/lib/workout-model.js isWarmupRow: an explicit phase wins, else the
// legacy boolean. A warm-up row is prep, not the session: it is filtered out of the stall
// count exactly as progression.js filters it, it never counts as a done set or a top set,
// and where it does travel (the last few sessions in full) it is flagged so the model reads
// "0x12 warm-up" as what it is rather than as a failed set.
export const isWarmupSet = s => {
  const ph = typeof s?.phase === 'string' ? s.phase.trim().toLowerCase() : '';
  if (ph) return ph === 'warmup' || ph === 'warm-up' || ph === 'warm_up';
  return s?.warmup === true;
};
function readSession(entry, fallback) {
  const target = (entry && entry.target) || fallback || {};
  const ex = LIB_BY_ID.get(entry?.id);
  const mode = modeOf(target, ex);
  const bw = isBw(target, ex);
  const logged = ((entry && entry.sets) || []).filter(s => !isWarmupSet(s));
  const planned = target.sets || logged.length;
  const enough = logged.length >= planned;
  // Only the sets the plan asked for decide whether the session was hit, exactly as
  // frontend/src/lib/progression.js readSession has done since issue #233. This copy graded
  // every logged set, so a fourth set taken short of the goal on a clean 3x10 was a hit in the
  // app and a miss here — and stallCount, reading only this copy, reported a stall the athlete
  // never had. `count` below stays the real total: extra sets are exactly how bodyweight work
  // is meant to grow (#33), they just do not decide whether the prescription was met.
  // Only a plan the session itself carried may decide where that line falls, as on the
  // frontend: a Hevy or CSV import has no target of its own, and slicing it to the `fallback`
  // config's set count would grade the warm-up end of a session nobody planned that way.
  const sets = entry && entry.target ? logged.slice(0, Math.max(1, planned)) : logged;
  if (mode === 'time') {
    const goal = target.sec || 0;
    const held = sets.map(s => (s.done ? (s.sec || 0) : 0));
    return { mode, bw, goal, ok: goal > 0 && enough && held.length > 0 && held.every(h => h >= goal) };
  }
  const goal = target.reps || 0;
  const reps = sets.map(s => (s.done ? (s.r || 0) : 0));
  // Set count is the dimension bodyweight work grows once reps hit their ceiling (upstream
  // #33), so it travels alongside the reps rather than being inferred from them downstream.
  const done = logged.filter(s => s.done).length;
  return { mode, bw, goal, count: done, ok: goal > 0 && enough && reps.length > 0 && reps.every(r => r >= goal) };
}
/** Consecutive misses counting back from the most recent session. */
export function stallCount(sessions) {
  let n = 0;
  for (let i = sessions.length - 1; i >= 0; i--) { if (sessions[i].ok) break; n++; }
  return n;
}

/* ---------- plan cleaning (mirrors plan-share.js cleanEx) ---------- */
function cleanEx(e) {
  const o = { id: ident(e.id), name: LIB_BY_ID.get(e.id)?.n || null, sets: num(e.sets) };
  const mode = modeOf(e, LIB_BY_ID.get(e.id));
  o.mode = mode;
  const put = (k, v) => { if (num(v) !== undefined) o[k] = v; };
  if (mode === 'cardio') { put('min', e.min); put('speed', e.speed); }
  else if (mode === 'time') { put('sec', e.sec); if (e.weight) put('weight', e.weight); }
  else { put('reps', e.reps); if (e.weight) put('weight', e.weight); }
  if (policy(e.prog)) o.prog = e.prog;
  if (e.inc > 0) put('inc', e.inc);
  put('repsMin', e.repsMin);
  // repsMax is the ceiling that turns "+1 rep forever" into "add a set and start over"; without
  // it the Coach cannot see, or propose, how a bodyweight exercise is meant to progress.
  put('repsMax', e.repsMax);
  // Written out only when they disagree with the catalogue, matching plan-share.js — an
  // absent flag has always meant "whatever the exercise says", and still does.
  if (e.bodyweight != null) o.bodyweight = !!e.bodyweight;
  if (e.side) o.side = true;
  // A superset tag is an id the app mints (sg-0-1, hs + uid()), so it is bounded like one.
  if (e.sg) o.sg = ident(e.sg);
  return o;
}
/**
 * The plan reduced to exactly the fields that decide whether it has *changed* — mode-aware,
 * with every absent value written out as a zero so "no weight" and "0 kg" cannot hash apart.
 *
 * frontend/src/lib/coach.js mirrors this function field for field. That duplication is the
 * price of the two runtimes sharing no build step, and it is load-bearing: if the two ever
 * disagree, every proposal reads as stale and the feature quietly stops working. coach.test.js
 * pins them together against shared fixtures.
 */
export function canonicalPlan(S) {
  const custom = new Map((S.customEx || []).map(c => [c.id, c]));
  const exOf = id => LIB_BY_ID.get(id) || custom.get(id);
  return {
    routines: (S.routines || []).map(r => ({
      id: r.id, name: r.name || '', prog: r.prog || '',
      ex: (r.ex || []).map(e => {
        const mode = modeOf(e, exOf(e.id));
        return {
          id: e.id, mode, sets: e.sets || 0,
          reps: mode === 'reps' ? (e.reps || 0) : 0,
          sec: mode === 'time' ? (e.sec || 0) : 0,
          min: mode === 'cardio' ? (e.min || 0) : 0,
          speed: mode === 'cardio' ? (e.speed || 0) : 0,
          weight: mode === 'cardio' ? 0 : (e.weight || 0),
          prog: e.prog || '', inc: e.inc || 0, repsMin: e.repsMin || 0, repsMax: e.repsMax || 0,
          // Resolved rather than copied: the fingerprint has to change when a plan starts
          // disagreeing with the catalogue, and `bodyweight: undefined` and an exercise the
          // dataset already calls bodyweight are the same plan and must hash the same.
          bodyweight: isBw(e, exOf(e.id)), side: isPerSide(e),
          sg: e.sg || ''
        };
      })
    })),
    // A weekday holds a routine-id list. `[].concat` folds a legacy bare string and a
    // one-element list to the same shape (so their fingerprint is identical); `?.length` keeps
    // a stray `[]` out; insertion order is preserved and never sorted (it is the merge order).
    week: Object.fromEntries([1, 2, 3, 4, 5, 6, 0].filter(d => S.week?.[d]?.length).map(d => [d, [].concat(S.week[d])]))
  };
}

export function cleanPlan(S) {
  // Names are typed by the person, so they are cut like the profile's text. The icon is held to
  // what the validator lets a plan carry (an icon key or a legacy emoji, core/glyphs.js): it is
  // the client's state, and free text in it would ride into every prompt.
  const routines = list(S.routines).filter(r => r && typeof r === 'object').map(r => ({
    id: ident(r.id), name: r.name == null ? r.name : text(String(r.name), NAME_MAX),
    emoji: r.emoji == null ? r.emoji : glyphStr(String(r.emoji)),
    ...(policy(r.prog) ? { prog: r.prog } : {}),
    ex: list(r.ex).filter(e => e && typeof e === 'object').map(cleanEx)
  }));
  // A weekday holds routine ids, so each entry is bounded like one.
  const week = {};
  [1, 2, 3, 4, 5, 6, 0].forEach(d => { if (S.week?.[d]?.length) week[d] = [].concat(S.week[d]).map(ident); });
  return { routines, week };
}

// The catalogue lives in library.js; re-exported so older imports keep resolving.
export { LIBRARY, MAX_LIBRARY, libraryHas, libraryName, librarySlice, isStretch };

/* ---------- effort scale (mirrors history.js effortOf) ---------- */
const effortOf = S => {
  const e = S && S.effort;
  return e === 'none' || e === 'rir' || e === 'rpe' ? e : (S && S.showRir ? 'rir' : 'none');
};

/* ---------- window + aggregates ---------- */
const iso = d => d.toISOString().slice(0, 10);

export function reviewWindow(S, since) {
  const all = (S.workouts || []).filter(w => w && w.d);
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - MAX_WEEKS * 7);
  const cutoff = iso(cutoffDate);
  const from = since && since > cutoff ? since : cutoff;
  return all.filter(w => w.d >= from).slice(-MAX_SESSIONS);
}

function aggregates(S, workouts) {
  // Per-exercise stall/deload picture, computed over the same sessions the engine would see.
  const byEx = new Map();
  const planCfg = new Map();
  (S.routines || []).forEach(r => (r.ex || []).forEach(e => planCfg.set(e.id, e)));
  (S.workouts || []).forEach(w => (w.entries || []).forEach(en => {
    if (!en.sets?.some(s => s.done)) return;
    if (!byEx.has(en.id)) byEx.set(en.id, []);
    byEx.get(en.id).push(readSession(en, planCfg.get(en.id)));
  }));
  const exercises = [];
  for (const [id, sessions] of byEx) {
    const stalls = stallCount(sessions);
    if (stalls > 0 || sessions.length >= 3) {
      exercises.push({ id: ident(id), name: libraryName(id), sessions: sessions.length, stalls, lastOk: !!sessions[sessions.length - 1]?.ok });
    }
  }

  // Adherence: what the week asked for against what actually happened.
  const trained = new Set(workouts.map(w => w.d));
  // A combined day already counts as 1 — this counts days scheduled, not routines.
  const plannedDays = Object.keys(S.week || {}).filter(k => S.week[k]?.length).length;
  const reschedules = Object.entries(S.dayPlan || {}).filter(([d]) => workouts.some(w => w.d === d) || d >= (workouts[0]?.d || '')).length;

  // Muscle coverage in the window, by body part — the "not trained" gap the Stats screen shows.
  const hit = {};
  workouts.forEach(w => (w.entries || []).forEach(en => {
    const work = (en.sets || []).filter(s => s.done && !isWarmupSet(s));
    if (!work.length) return;
    const bp = LIB_BY_ID.get(en.id)?.bp;
    if (bp) hit[bp] = (hit[bp] || 0) + work.length;
  }));

  const durations = workouts.map(w => (w.end && w.start ? Math.round((w.end - w.start) / 60000) : null)).filter(Boolean);
  return {
    exercises,
    adherence: { plannedPerWeek: plannedDays, sessionsInWindow: workouts.length, distinctDays: trained.size, dayOverrides: reschedules },
    setsByBodyPart: hit,
    sessionMinutes: durations.length
      ? { median: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)], min: Math.min(...durations), max: Math.max(...durations) }
      : null
  };
}

/** Every exercise id the plan names or the given workouts logged — the ones a proposal has to
 *  be able to refer to, so they ride in the library slice whatever the cap or the filter. */
function trainedIds(S, workouts) {
  const ids = new Set();
  (S.routines || []).forEach(r => (r.ex || []).forEach(e => ids.add(e.id)));
  (workouts || []).forEach(w => (w.entries || []).forEach(en => ids.add(en.id)));
  return [...ids];
}

// Only the most recent sessions carry full set-by-set detail; everything older in the window
// arrives as one line per exercise. The old payload sent every set of up to 60 sessions —
// 10k+ tokens a small local model cannot hold and a metered API should not be billed for —
// while stalls and trends already live in `aggregates`, computed over the full window.
export const FULL_DETAIL_SESSIONS = 3;

const fmtSet = s => {
  const eff = s.rir != null ? '@RIR' + s.rir : s.rpe != null ? '@RPE' + s.rpe : '';
  if (s.sec != null) return s.sec + 's' + eff;
  if (s.min != null) return s.min + 'min' + (s.speed != null ? '/' + s.speed : '') + eff;
  return (s.w != null ? s.w + 'x' : '') + (s.r != null ? s.r : '?') + eff;
};

/** One logged set, its numbers only. */
function cleanSet(s) {
  const o = { done: !!s.done };
  if (isWarmupSet(s)) o.warmup = true;
  for (const k of ['w', 'r', 'sec', 'min', 'speed', 'rir', 'rpe']) if (num(s[k]) !== undefined) o[k] = s[k];
  return o;
}
const entriesOf = w => list(w.entries).filter(en => en && typeof en === 'object');
const setsOf = en => list(en.sets).filter(s => s && typeof s === 'object');
const targetOf = en => (en.target && typeof en.target === 'object'
  ? { sets: num(en.target.sets), reps: num(en.target.reps), sec: num(en.target.sec), weight: num(en.target.weight) }
  : null);

/* ---------- what the lifter marked on an exercise ----------
   A session's entry can carry marks (frontend/src/lib/exercise-flags.js): seven fixed words for
   what got in the way that day, set next to the note typed about the exercise. A marked exercise
   that ended the session without a set has no entry; the workout lists it under `skipped`
   instead. Both come out of the client-written state, so a mark is read against the list of
   kinds and the note is cut like every other typed text.

   frontend/src/lib/exercise-flags.test.js pins the kinds to the ones the phone writes. */
export const FLAG_KINDS = ['pain', 'discomfort', 'equipment', 'time', 'heavy', 'light', 'dislike'];
export const ENTRY_NOTE_CHARS = 200;
// A workout holds a handful of exercises; this is what the phone keeps at most (SKIPPED_MAX).
export const SKIPPED_MAX = 12;
const flagsOf = v => (Array.isArray(v) ? FLAG_KINDS.filter(k => v.includes(k)) : []);
const noteOf = en => text(en.note, ENTRY_NOTE_CHARS).trim();
const skippedOf = w => list(w.skipped)
  .filter(e => e && typeof e === 'object' && e.id != null && flagsOf(e.flags).length)
  .slice(0, SKIPPED_MAX);
/** The marks on one entry, and with `withNote` what was typed about it; nothing when unmarked. */
function marked(en, withNote) {
  const o = {};
  const flags = flagsOf(en.flags);
  if (flags.length) o.flags = flags;
  if (withNote && noteOf(en)) o.note = noteOf(en);
  return o;
}
/** `skipped` for one workout, or no key at all. */
function skippedPart(w, withNote) {
  const out = skippedOf(w).map(e => ({ id: ident(e.id), name: libraryName(e.id), ...marked(e, withNote) }));
  return out.length ? { skipped: out } : {};
}

/* ---------- what the Coach suggested during a session, and they took ----------
   A question asked between two sets can be answered with ops on the session (live.js). The phone
   keeps the ones the person took on the finished workout (`coached`,
   frontend/src/lib/coach-live.js), and they are read back here, so that a later reading knows a
   weight that came down mid-session was the Coach's own suggestion: the sets after it were done
   as advised, not missed. Client-written like everything else on a workout, so every field is
   read by name and by type, and the reason is cut.

   frontend/src/lib/coach-live.test.js pins the ceiling to the one the phone keeps. */
export const COACHED_MAX = 12;
const COACHED_WHY_CHARS = 200;
const COACHED_DAY_FROM = 4;
function coachedPart(w) {
  const numbers = v => {
    const o = {};
    if (!v || typeof v !== 'object') return o;
    if (num(v.w) !== undefined) o.weight = v.w;
    if (num(v.r) !== undefined) o.reps = v.r;
    if (num(v.sec) !== undefined) o.sec = v.sec;
    return o;
  };
  const out = [];
  for (const c of list(w.coached).slice(-COACHED_MAX)) {
    if (!c || typeof c !== 'object' || ident(c.id) == null || !LIVE_OPS.includes(c.op)) continue;
    const o = { id: ident(c.id), name: libraryName(c.id), op: c.op };
    if (Number.isInteger(c.n) && c.n > 0 && c.n <= 20) o.sets = c.n;
    Object.assign(o, numbers(c));
    const was = numbers(c.was);
    if (Object.keys(was).length) o.was = was;
    if (c.op === 'swap') {
      if (ident(c.to) == null) continue;
      o.to = ident(c.to);
      o.toName = libraryName(c.to);
    }
    const why = text(c.why, COACHED_WHY_CHARS).trim();
    if (why) o.why = why;
    out.push(o);
  }
  // A session trained in place of the one planned, on a suggestion made before it was started
  // (live.js cleanDay): the names of what was planned, and the reason given.
  const d = w.coachedDay && typeof w.coachedDay === 'object' ? w.coachedDay : null;
  const from = list(d?.from).map(n => text(n, NAME_MAX).trim()).filter(Boolean).slice(0, COACHED_DAY_FROM);
  const dayWhy = text(d?.why, COACHED_WHY_CHARS).trim();
  return {
    ...(out.length ? { coached: out } : {}),
    ...(d ? { coachedDay: { from, ...(dayWhy ? { why: dayWhy } : {}) } } : {})
  };
}

/** One older workout as a summary: what was done, the top set, whether targets were hit. */
function compactWorkout(w) {
  return {
    d: day(w.d),
    name: word(w.name, NAME_MAX),
    minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
    prs: list(w.prs).length,
    compact: true,
    entries: entriesOf(w).map(en => {
      const sets = setsOf(en).filter(s => !isWarmupSet(s)).map(cleanSet);
      const done = sets.filter(s => s.done);
      let top = null;
      done.forEach(s => {
        if (!top || (s.w || 0) * (s.r || 0) + (s.sec || 0) > (top.w || 0) * (top.r || 0) + (top.sec || 0)) top = s;
      });
      const target = targetOf(en);
      return {
        id: ident(en.id),
        name: libraryName(en.id),
        done: done.length + '/' + sets.length,
        ...(target ? { target: fmtSet({ w: target.weight, r: target.reps, sec: target.sec }) } : {}),
        ...(top ? { top: fmtSet(top) } : {}),
        ...marked(en, false)
      };
    }),
    ...skippedPart(w, false),
    ...coachedPart(w)
  };
}

/** One workout, reduced to what a coach reads. */
function cleanWorkout(w) {
  return {
    d: day(w.d),
    name: word(w.name, NAME_MAX),
    minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
    ...(w.rating ? { rating: typeof w.rating === 'number' ? w.rating : text(String(w.rating), 20) } : {}),
    ...(w.note ? { note: String(w.note).slice(0, NOTE_MAX) } : {}),
    prs: list(w.prs).length,
    entries: entriesOf(w).map(en => ({
      id: ident(en.id),
      name: libraryName(en.id),
      target: targetOf(en),
      sets: setsOf(en).map(cleanSet),
      ...marked(en, true)
    })),
    ...skippedPart(w, true),
    ...coachedPart(w)
  };
}

/** The body-weight series between two days, each weigh-in a date and a number. */
function weighIns(S, from, to) {
  return list(S.bodyweight)
    .map(b => ({ d: day(b?.d), w: num(b?.w) }))
    .filter(b => b.d && b.w !== undefined && (!from || b.d >= from) && (!to || b.d <= to));
}

/* The room's medians are computed on this server, but from other people's synced workouts —
   state their own clients wrote. cohort.js keeps only catalogue exercises; this copy bounds
   every field again, so what reaches one person's prompt never depends on that filter alone. */
function cleanCohort(c) {
  if (!c || typeof c !== 'object') return null;
  const spw = c.sessionsPerWeek && typeof c.sessionsPerWeek === 'object' ? c.sessionsPerWeek : {};
  return {
    unit: word(c.unit, 8),
    people: num(c.people) ?? null,
    sessionsPerWeek: { median: num(spw.median) ?? null, you: num(spw.you) ?? null },
    exercises: list(c.exercises).filter(x => x && typeof x === 'object').map(x => ({
      id: ident(x.id), name: word(x.name, NAME_MAX), median: num(x.median) ?? null, you: num(x.you) ?? null
    }))
  };
}

/* ---------- one workout, for a debrief ---------- */
export function findWorkout(S, workoutId) {
  const all = (S.workouts || []).filter(w => w && w.d);
  return (workoutId && all.find(w => w.id === workoutId)) || all[all.length - 1] || null;
}
/** The little a debrief's card needs to name the session: id, date, name and four numbers. */
export function workoutMeta(S, workoutId) {
  const w = findWorkout(S, workoutId);
  if (!w) return null;
  let vol = 0;
  let sets = 0;
  (w.entries || []).forEach(en => (en.sets || []).forEach(s => {
    if (!s.done || isWarmupSet(s)) return;
    sets++;
    vol += (s.w || 0) * (s.r || 0);
  }));
  return {
    id: w.id || null, d: w.d, name: w.name || null,
    minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
    vol: Number.isFinite(w.vol) ? Math.round(w.vol) : Math.round(vol),
    sets, prs: (w.prs || []).length
  };
}

/* ---------- what the Coach already changed, and what it already said ----------
   The log (frontend/src/lib/coach.js appendLog) keeps every decision with its reason, and until
   now only the refusals travelled. A review that cannot see what it changed last month, or why,
   proposes the opposite this month with the same confidence — so the accepted half travels too,
   and with it what was written after single sessions, which was kept for display and never
   read again.

   Both come back out of the synced state, which the client writes, so they are read like
   everything else here: by name, by type, and cut. */
export const RECENT_CHANGES = 20;
export const CHANGE_WHY_CHARS = 240;
export const DEBRIEFS = 6;
export const DEBRIEF_ITEMS = 4;
export const DEBRIEF_ITEM_CHARS = 200;
export const DEBRIEF_SUMMARY_CHARS = 300;
// A reorder lists a routine's exercises, and the validator lets a routine hold twenty.
const CHANGE_LIST_MAX = 20;

// A name for an exercise id: the catalogue's, or the person's own for one they made.
const exNamer = S => {
  const custom = new Map(list(S.customEx).filter(c => c && typeof c === 'object').map(c => [c.id, c.n]));
  return id => libraryName(id) || word(custom.get(id), NAME_MAX);
};

// The log stamps an entry with Date.now(); the model reads days.
const stamp = at => {
  const d = new Date(typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN);
  return Number.isFinite(d.getTime()) ? iso(d) : null;
};

/** A change's `before` or `after`, reduced to what names it: a number, a short word, a list of
 *  ids, or the few fields of an exercise. Never the object as it came. */
function briefValue(v, nameOf) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (num(v) !== undefined) return v;
  if (typeof v === 'string') return v.slice(0, NAME_MAX);
  if (Array.isArray(v)) return v.slice(0, CHANGE_LIST_MAX).map(ident);
  if (typeof v !== 'object') return null;
  const o = {};
  if (v.id != null) { o.id = ident(v.id); o.name = nameOf(v.id); }
  else if (typeof v.name === 'string') o.name = v.name.slice(0, NAME_MAX);
  for (const k of ['sets', 'reps', 'sec', 'min', 'speed', 'weight']) if (num(v[k]) !== undefined) o[k] = v[k];
  if (typeof v.link === 'boolean') o.link = v.link;
  if (v.with != null) o.with = ident(v.with);
  if (Array.isArray(v.ex)) o.exercises = v.ex.length;
  return o;
}

/** The changes this person accepted, oldest first, each with the reason it was made. */
function recentChanges(S, coach) {
  const log = list(coach.log).filter(e => e && typeof e === 'object');
  // Undoing a change-set logs a `revert` naming the proposal it took back (coach.js revertLast).
  const undone = new Set(log.filter(e => e.kind === 'revert' && e.proposalId != null).map(e => e.proposalId));
  const routines = new Map(list(S.routines).filter(r => r && typeof r === 'object').map(r => [r.id, r.name]));
  const nameOf = exNamer(S);
  const out = [];
  for (const e of log) {
    if (e.dismissed) continue;
    const reverted = e.proposalId != null && undone.has(e.proposalId) ? { reverted: true } : {};
    if (e.kind === 'create') {
      // What the plan was built from, as the phone kept it (coach.js lightBundle): a catalogue
      // programme by its name, or their own plan.
      const from = e.bundle && typeof e.bundle === 'object' ? e.bundle : {};
      const basis = { ...(word(from.program?.name, NAME_MAX) ? { program: word(from.program.name, NAME_MAX) } : {}), ...(from.own === true ? { own: true } : {}) };
      out.push({ on: stamp(e.at), type: 'new-plan', name: word(e.bundle?.name, NAME_MAX), ...basis, why: text(e.summary, CHANGE_WHY_CHARS), ...reverted });
      continue;
    }
    if (e.kind !== 'review') continue;
    for (const d of list(e.decisions)) {
      if (!d || typeof d !== 'object' || d.status !== 'accepted') continue;
      const target = d.target && typeof d.target === 'object' ? d.target : {};
      const c = { on: stamp(e.at), type: word(d.type, PROFILE_WORD_MAX) };
      if (target.routineId != null) {
        c.routineId = ident(target.routineId);
        // The name the routine has now; a routine that has since been removed keeps the one the
        // log wrote down.
        c.routine = word(routines.get(target.routineId) ?? d.routineName, NAME_MAX);
      }
      if (target.exId != null) { c.exId = ident(target.exId); c.exercise = nameOf(target.exId); }
      if (Number.isInteger(target.weekday) && target.weekday >= 0 && target.weekday <= 6) c.weekday = target.weekday;
      c.before = briefValue(d.before, nameOf);
      c.after = briefValue(d.after, nameOf);
      c.why = text(d.why, CHANGE_WHY_CHARS);
      out.push({ ...c, ...reverted });
    }
  }
  return out.slice(-RECENT_CHANGES);
}

const lines = v => list(v).filter(x => typeof x === 'string' && x.trim()).slice(0, DEBRIEF_ITEMS).map(x => x.trim().slice(0, DEBRIEF_ITEM_CHARS));

/** What was written after single sessions from `from` on (and, for one week, up to `to`),
 *  oldest first. One per workout: a session debriefed twice would otherwise read as the same
 *  concern raised twice. */
function pastDebriefs(coach, from, to) {
  if (!from) return [];
  const seen = new Set();
  const out = [];
  const log = list(coach.log);
  for (let i = log.length - 1; i >= 0 && out.length < DEBRIEFS; i--) {
    const e = log[i];
    if (!e || typeof e !== 'object' || e.kind !== 'debrief') continue;
    const w = e.workout && typeof e.workout === 'object' ? e.workout : {};
    // A debrief kept before the card named its session has only the day it was written.
    const d = day(w.d) || stamp(e.at);
    if (!d || d < from || (to && d > to)) continue;
    const key = w.id != null ? 'w' + ident(w.id) : 'd' + d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      d,
      name: word(w.name, NAME_MAX),
      score: Number.isInteger(e.score) && e.score >= 1 && e.score <= 10 ? e.score : null,
      summary: text(e.summary, DEBRIEF_SUMMARY_CHARS),
      watch: lines(e.watch),
      nextTime: lines(e.nextTime)
    });
  }
  return out.reverse();
}

/* ---------- the marks, counted ----------
   One mark is one session. What a review can act on is the same mark on the same exercise more
   than once, and whether that is so is worked out here rather than left to the model to count
   across sixty sessions, most of which reach it as one line each — the reason stalls are counted
   in `aggregates`. Like the stall count it does not stop at the last review: a mark set before it
   and again after it is still twice. So this reads the last MAX_WEEKS whatever the window is, and
   says which days, so a mark can be placed before or after a change in `recentChanges`.

   Nothing is stored for it. It is worked out from the log every time, as the stalls are. */
export const OBSERVATIONS_MAX = 30;
export const OBSERVATION_DATES = 4;
export const OBSERVATION_NOTES = 2;
export const OBSERVATION_NOTE_CHARS = 160;

/**
 * @param {object} S     the synced state
 * @param {Set} [only]   exercise ids to keep (a debrief reads its own session's exercises)
 * @returns the marks of the last twelve weeks, or null when there are none
 */
function observations(S, only) {
  const workouts = reviewWindow(S, null).filter(w => day(w.d));
  const nameOf = exNamer(S);
  const planned = new Set();
  list(S.routines).forEach(r => list(r?.ex).forEach(e => planned.add(ident(e?.id))));
  const items = new Map();    // exercise and kind -> the sessions that carry the mark
  const trained = new Map();  // exercise -> the sessions it was part of
  const byKind = {};
  for (const w of workouts) {
    // One session counts once for an exercise and a kind, however often the exercise appears.
    const here = new Map();
    const read = (en, skipped) => {
      const id = ident(en.id);
      const flags = flagsOf(en.flags);
      if (id == null || !(flags.length || setsOf(en).some(s => s.done))) return;
      const at = here.get(id) || { flags: new Set(), skipped: true, note: '' };
      flags.forEach(k => at.flags.add(k));
      if (!skipped) at.skipped = false;
      if (flags.length && !at.note) at.note = text(en.note, OBSERVATION_NOTE_CHARS).trim();
      here.set(id, at);
    };
    entriesOf(w).forEach(en => read(en, false));
    skippedOf(w).forEach(en => read(en, true));
    const kinds = new Set();
    for (const [id, at] of here) {
      trained.set(id, (trained.get(id) || 0) + 1);
      for (const kind of at.flags) {
        kinds.add(kind);
        const key = id + '|' + kind;
        const it = items.get(key) || { id, flag: kind, dates: [], skipped: 0, notes: [] };
        it.dates.push(day(w.d));
        if (at.skipped) it.skipped++;
        if (at.note) it.notes.push({ d: day(w.d), text: at.note });
        items.set(key, it);
      }
    }
    kinds.forEach(k => { byKind[k] = (byKind[k] || 0) + 1; });
  }
  if (!items.size) return null;
  // Pain first, then whatever was marked most often, then most recently.
  const rank = it => (it.flag === 'pain' ? 0 : 1);
  const exercises = [...items.values()]
    .filter(it => !only || only.has(it.id))
    .sort((a, b) => rank(a) - rank(b) || b.dates.length - a.dates.length || (b.dates.at(-1) || '').localeCompare(a.dates.at(-1) || ''))
    .slice(0, OBSERVATIONS_MAX)
    .map(it => ({
      id: it.id, name: nameOf(it.id), flag: it.flag,
      times: it.dates.length, of: trained.get(it.id),
      ...(it.skipped ? { skipped: it.skipped } : {}),
      dates: it.dates.slice(-OBSERVATION_DATES),
      ...(it.notes.length ? { notes: it.notes.slice(-OBSERVATION_NOTES) } : {}),
      inPlan: planned.has(it.id)
    }));
  return {
    from: day(workouts[0]?.d), to: day(workouts[workouts.length - 1]?.d), sessions: workouts.length,
    byKind: Object.fromEntries(FLAG_KINDS.filter(k => byKind[k]).map(k => [k, byKind[k]])),
    exercises
  };
}

/* ---------- the charter: what the plan is for, and when it is looked at whole ----------
   The intake has one goal word. The charter (frontend/src/lib/coach-charter.js) is what the
   person wrote beyond it — a goal in their own words, lifts they want to reach — and the block
   the current plan runs in: its length, the day it started, the next checkpoint, and how the
   Coach laid it out when the plan was made. It is typed into the same client-written state as
   the profile and is read the same way.

   The limits are the ones the charter sheet shows; coach-charter.test.js pins the two files
   together, as coach.test.js does for the plan fingerprint. */
export const CHARTER_GOAL_MAX = 300;
export const CHARTER_OUTLINE_MAX = 600;
export const CHARTER_TARGETS_MAX = 5;
export const BLOCK_WEEKS_MAX = 26;

// Whole days from one ISO day to another, counted at noon UTC so no clock change can bend it.
const daysApart = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/**
 * Where `today` falls in the block: the week it is in, and whether the checkpoint has come.
 * Worked out here rather than left to the model, which is not to be trusted with a calendar.
 * frontend/src/lib/coach-charter.js charterStatus shows the same two facts on the phone.
 */
export function charterProgress(charter, today) {
  const start = day(charter?.startedAt);
  const end = day(charter?.checkpoint);
  const now = day(today);
  const o = {};
  if (start && now) {
    const n = daysApart(start, now);
    if (Number.isFinite(n) && n >= 0) o.week = Math.floor(n / 7) + 1;
  }
  if (end && now) {
    const left = daysApart(now, end);
    if (Number.isFinite(left)) o.checkpointDue = left <= 0;
  }
  return o;
}

function cleanCharter(S, coach, today) {
  const c = coach.charter;
  if (!c || typeof c !== 'object') return null;
  const nameOf = exNamer(S);
  const o = {};
  const goal = text(c.goal, CHARTER_GOAL_MAX).trim();
  if (goal) o.goal = goal;
  const targets = list(c.targets)
    .filter(t => t && typeof t === 'object' && t.id != null && num(t.weight) !== undefined && Number(t.weight) > 0)
    .slice(0, CHARTER_TARGETS_MAX)
    .map(t => ({ id: ident(t.id), name: nameOf(t.id), weight: t.weight, reps: count(t.reps, 1, 100) ?? 1 }));
  if (targets.length) o.targets = targets;
  const weeks = count(c.blockWeeks, 1, BLOCK_WEEKS_MAX);
  if (weeks) o.blockWeeks = weeks;
  if (day(c.startedAt)) o.startedAt = day(c.startedAt);
  if (day(c.checkpoint)) o.checkpoint = day(c.checkpoint);
  Object.assign(o, charterProgress(o, today));
  const outline = text(c.outline, CHARTER_OUTLINE_MAX).trim();
  if (outline) o.outline = outline;
  return Object.keys(o).length ? o : null;
}

/* ---------- the week, written up ----------
   A review reads the sessions since the last one, and the rest of what happened reaches it as
   counts. What a count cannot hold — that the bench was taken three Mondays running, that a
   shoulder was first mentioned in August — went nowhere. So each trained week is written up once
   by its own small job (prompts/digest.md), and the notes travel on later reviews in place of
   the one-line sessions of the weeks they cover.

   A note is kept in the synced state (`S.coach.digests`, frontend/src/lib/coach-digests.js) and,
   until a phone has fetched it, in the server's own record (api/coach/digest.js). Both are read
   here by name, by type, and cut: the first is the client's, and the sentences in either were
   written by a model.

   The limits are the ones the validator holds an answer to and the phone keeps a note at;
   api/test/digest.test.js and frontend/src/lib/coach-digests.test.js pin the three together. */
export const DIGESTS_SENT = 12;
export const DIGEST_SUMMARY_CHARS = 500;
export const DIGEST_ITEMS = 4;
export const DIGEST_ITEM_CHARS = 160;
export const DIGEST_LISTS = ['progress', 'issues', 'carry'];
// Two sessions a day, every day. A week that claims more is not a week of training.
export const WEEK_SESSIONS_MAX = 14;
// How many kept notes are looked at before the newest are chosen; the phone keeps 26.
const DIGESTS_READ = 60;

/** The week a day falls in, as its first and last day. `weekStart` is the app's own setting, a
 *  getDay() index that is Sunday or else Monday (frontend/src/lib/format.js weekStartOf). */
export function weekBounds(on, weekStart) {
  const at = Date.parse(day(on) + 'T12:00:00Z');
  if (!Number.isFinite(at)) return null;
  const back = (new Date(at).getUTCDay() - (weekStart === 0 ? 0 : 1) + 7) % 7;
  const first = at - back * 86400000;
  return { from: iso(new Date(first)), to: iso(new Date(first + 6 * 86400000)) };
}

/** The sessions logged from one day to another, both included. */
export function weekWorkouts(S, from, to) {
  const a = day(from), b = day(to);
  if (!a || !b) return [];
  return list(S.workouts)
    .filter(w => w && typeof w === 'object' && day(w.d) && day(w.d) >= a && day(w.d) <= b)
    .slice(-WEEK_SESSIONS_MAX);
}

/** A week in numbers, counted here so the note about it never has to: sessions against the days
 *  the plan schedules, work sets done, minutes trained, records, and the sessions each kind of
 *  mark appears in. */
export function weekFacts(S, from, to) {
  const workouts = weekWorkouts(S, from, to);
  let sets = 0, minutes = 0, prs = 0;
  const marks = {};
  for (const w of workouts) {
    const m = w.end && w.start ? Math.round((w.end - w.start) / 60000) : 0;
    if (Number.isFinite(m) && m > 0) minutes += m;
    prs += list(w.prs).length;
    const kinds = new Set();
    entriesOf(w).forEach(en => {
      sets += setsOf(en).filter(s => s.done && !isWarmupSet(s)).length;
      flagsOf(en.flags).forEach(k => kinds.add(k));
    });
    skippedOf(w).forEach(en => flagsOf(en.flags).forEach(k => kinds.add(k)));
    kinds.forEach(k => { marks[k] = (marks[k] || 0) + 1; });
  }
  return {
    sessions: workouts.length,
    planned: [0, 1, 2, 3, 4, 5, 6].filter(d => S.week?.[d]?.length).length,
    sets, minutes, prs,
    ...(Object.keys(marks).length ? { marks: Object.fromEntries(FLAG_KINDS.filter(k => marks[k]).map(k => [k, marks[k]])) } : {})
  };
}

const tally = v => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : undefined);
const shortLines = v => list(v).filter(x => typeof x === 'string' && x.trim()).slice(0, DIGEST_ITEMS).map(x => x.trim().slice(0, DIGEST_ITEM_CHARS));

/** One kept note, or null for anything that is not one. */
function cleanDigest(g) {
  if (!g || typeof g !== 'object') return null;
  const from = day(g.from), to = day(g.to);
  const summary = text(g.summary, DIGEST_SUMMARY_CHARS).trim();
  if (!from || !to || to < from || !summary) return null;
  const o = { from, to };
  for (const k of ['sessions', 'planned', 'sets', 'minutes', 'prs']) if (tally(g[k]) !== undefined) o[k] = g[k];
  const marks = g.marks && typeof g.marks === 'object' ? FLAG_KINDS.filter(k => tally(g.marks[k])).map(k => [k, g.marks[k]]) : [];
  if (marks.length) o.marks = Object.fromEntries(marks);
  o.summary = summary;
  for (const k of DIGEST_LISTS) {
    const items = shortLines(g[k]);
    if (items.length) o[k] = items;
  }
  return o;
}

/**
 * The weeks written up so far, oldest first, one note per week.
 *
 * @param {object} coach   `S.coach`
 * @param {Array} [held]   notes the server still holds for a phone that has not fetched them; a
 *                         scheduled review runs with nobody's app open, so it cannot wait for one
 */
export function digestsOf(coach, held) {
  const byWeek = new Map();
  for (const g of [...list(coach?.digests).slice(-DIGESTS_READ), ...list(held).slice(-DIGESTS_READ)]) {
    const c = cleanDigest(g);
    if (c) byWeek.set(c.from, c);
  }
  return [...byWeek.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/* ---------- what a lift is at ----------
   A cycle sets the weight of each session, and a weight is set from what the person can do. That
   is arithmetic over the log — the heaviest recent sets, an estimated one-rep max, what the last
   session of the lift looked like — and it is done here, so the model starts from numbers it
   was given and a programme's "80 % of your max" has a max to be 80 % of.

   The estimate is Epley's, as the app's own (frontend/src/lib/onerm.js): weight × (1 + reps/30),
   from sets of twelve reps or fewer, where it holds. Nothing is stored for it. */
export const LIFTS_MAX = 40;
export const LIFT_WEEKS = 12;
const LIFT_SETS = 6;
const half = n => Math.round(n * 2) / 2;

/**
 * @param {object} S       the synced state
 * @param {Set} [only]     exercise ids to keep (a running cycle's own); all trained ones otherwise
 * @returns one entry per exercise with a loaded set in the last twelve weeks, most trained first
 */
function lifts(S, only) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - LIFT_WEEKS * 7);
  const from = iso(cutoff);
  const nameOf = exNamer(S);
  const by = new Map();
  for (const w of list(S.workouts)) {
    const d = day(w?.d);
    if (!d || d < from) continue;
    for (const en of entriesOf(w)) {
      const id = ident(en.id);
      if (id == null || (only && !only.has(id))) continue;
      const done = setsOf(en).filter(s => s.done && !isWarmupSet(s) && Number(s.w) > 0 && Number(s.r) > 0);
      if (!done.length) continue;
      const it = by.get(id) || { id, sessions: 0, e1rm: 0, best: null, last: null };
      it.sessions++;
      for (const s of done) {
        const est = Number(s.r) <= 12 ? Number(s.w) * (1 + Number(s.r) / 30) : 0;
        if (est > it.e1rm) { it.e1rm = est; it.best = { d, set: fmtSet(cleanSet(s)) }; }
      }
      // Workouts are kept oldest first, so the last one seen is the latest.
      it.last = { d, sets: done.slice(0, LIFT_SETS).map(s => fmtSet(cleanSet(s))) };
      by.set(id, it);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, LIFTS_MAX)
    .map(it => ({ id: it.id, name: nameOf(it.id), sessions: it.sessions, ...(it.e1rm ? { e1rm: half(it.e1rm), best: it.best } : {}), last: it.last }));
}

/* ---------- the cycle that is running ----------
   `S.coach.cycle` is what the phone keeps of a cycle it took on (frontend/src/lib/coach-cycle.js):
   the routines it runs on, what those held when it began, and the weeks. It is client-written
   state like the rest, so it is read by name and by type, against the plan as it stands — a
   routine or an exercise the plan no longer has is not part of the cycle any more. */
export const CYCLE_AHEAD = 6;
export const ADJUST_WINDOW_DAYS = 21;
export const ADJUST_SESSIONS = 8;
const CYCLE_HISTORY = 3;

/** The cycle as kept, checked against the cleaned plan; null when none is running. */
function cycleState(S, coach, plan) {
  const c = coach.cycle;
  if (!c || typeof c !== 'object') return null;
  const startedAt = day(c.startedAt);
  const weeks = count(c.weeks, 1, CYCLE_WEEKS_MAX);
  const routines = list(c.routines).map(ident).filter(id => list(plan.routines).some(r => r.id === id));
  if (!startedAt || !weeks || !routines.length) return null;
  const mine = list(plan.routines).filter(r => routines.includes(r.id));
  const base = {};
  for (const r of mine) {
    base[r.id] = {};
    const kept = c.base && typeof c.base === 'object' && c.base[r.id] && typeof c.base[r.id] === 'object' ? c.base[r.id] : {};
    for (const e of r.ex) {
      const b = kept[e.id] && typeof kept[e.id] === 'object' ? kept[e.id] : {};
      const o = {};
      for (const k of ['sets', 'reps', 'sec', 'weight']) if (typeof b[k] === 'number' && Number.isFinite(b[k]) && b[k] > 0) o[k] = b[k];
      base[r.id][e.id] = o;
    }
  }
  const { plan: weeksPlan } = cleanCyclePlan(c.plan, mine, weeks);
  const program = c.program && typeof c.program === 'object' && typeof c.program.id === 'string'
    ? { id: c.program.id.slice(0, ID_MAX), name: word(c.program.name, NAME_MAX) } : null;
  const history = list(c.history).filter(h => h && typeof h === 'object').slice(-CYCLE_HISTORY).map(h => ({
    on: stamp(h.at), summary: text(h.summary, 300), changes: list(h.changes).length, ...(h.undone === true ? { undone: true } : {})
  }));
  const check = c.lastCheck && typeof c.lastCheck === 'object' && text(c.lastCheck.reading, 300).trim()
    ? { on: stamp(c.lastCheck.at), reading: text(c.lastCheck.reading, 300).trim() } : null;
  return {
    name: word(c.name, NAME_MAX), startedAt, weeks, routines, base, plan: weeksPlan,
    program, own: c.own === true, history, lastCheck: check
  };
}

/**
 * The cycle as a job reads it.
 *
 * `full`: the daily look — every week from the current one on, for the next few with each
 * routine's exercises at the numbers that week trains them at, and the rest as a line of intent.
 * Otherwise a review's short view: how long, which week, what each week is for.
 */
function cycleForPayload(cyc, plan, today, { full }) {
  const at = cycleWeekOn(cyc.startedAt, today);
  const week = Math.min(cyc.weeks, Math.max(1, at || 1));
  const o = {
    ...(cyc.name ? { name: cyc.name } : {}),
    weeks: cyc.weeks, week, startedAt: cyc.startedAt,
    // The last week has been and gone: the cycle is over and what follows is theirs to ask for.
    ...(at && at > cyc.weeks ? { over: true } : {}),
    ...(cyc.program?.name ? { program: cyc.program.name } : {}),
    ...(cyc.own ? { own: true } : {})
  };
  const focusOf = n => cyc.plan.find(w => w.week === n)?.focus || null;
  const mine = list(plan.routines).filter(r => cyc.routines.includes(r.id));
  const weekdaysOf = rid => Object.keys(plan.week || {}).map(Number).filter(d => [].concat(plan.week[d]).includes(rid));
  if (!full) {
    o.routines = mine.map(r => r.id);
    o.focus = cyc.plan.filter(w => w.focus).map(w => ({ week: w.week, focus: w.focus }));
    return o;
  }
  o.routines = mine.map(r => ({ id: r.id, name: r.name || null, weekdays: weekdaysOf(r.id) }));
  o.plan = [];
  for (let n = week; n <= Math.min(cyc.weeks, week + CYCLE_AHEAD - 1); n++) {
    const numbers = numbersAt(cyc.base, cyc.plan, n);
    o.plan.push({
      week: n, ...(focusOf(n) ? { focus: focusOf(n) } : {}),
      sessions: mine.map(r => ({
        routine: r.id,
        ex: r.ex.map(e => {
          const x = numbers.get(r.id)?.get(e.id) || {};
          // `set` is the week that last gave this exercise a number; absent, it stands as the
          // routine held it when the cycle began.
          return { id: e.id, name: e.name, ...(x.sets != null ? { sets: x.sets } : {}), ...(x.reps != null ? { reps: x.reps } : {}), ...(x.sec != null ? { sec: x.sec } : {}), ...(x.weight != null ? { weight: x.weight } : {}), ...(x.set ? { set: x.set } : {}) };
        })
      }))
    });
  }
  const later = [];
  for (let n = week + CYCLE_AHEAD; n <= cyc.weeks; n++) if (focusOf(n)) later.push({ week: n, focus: focusOf(n).slice(0, CYCLE_FOCUS_MAX) });
  if (later.length) o.later = later;
  if (cyc.history.length) o.adjusted = cyc.history;
  if (cyc.lastCheck) o.lastCheck = cyc.lastCheck;
  return o;
}

/** What a daily answer is checked against (pipeline.js): the cycle's length, its routines with
 *  their exercises, and the week it is in. Null when no cycle is running. */
export function cycleContext(S, today) {
  const coach = S.coach || {};
  const plan = cleanPlan(S);
  const cyc = cycleState(S, coach, plan);
  if (!cyc) return null;
  const at = cycleWeekOn(cyc.startedAt, day(today) || iso(new Date()));
  return {
    weeks: cyc.weeks, week: Math.max(1, at || 1), base: cyc.base, plan: cyc.plan,
    routines: list(plan.routines).filter(r => cyc.routines.includes(r.id)),
    schedule: plan.week
  };
}

/* ---------- the session under way ----------
   A question asked between two sets comes with the session it is asked in, as the phone holds
   it: the server never has one in progress (PUT /api/data drops `active` on the way in). It is
   client-written like everything else here, and more directly — it arrives in the request that
   asks — so it is read the same way: by name, by type, and cut. What is read is the app's own
   `S.active`, so a phone can send that object as it is.

   Each exercise keeps the place it has on the phone (`entry`), because that is where an op is
   applied (core/live.js); one that cannot be read is left out and the others keep their numbers.
   A session being filed for a past day (`backfill`) is not under way, and nothing is read of it.

   A session that has not been started is sent the same way, as the phone would build it, with
   `pre: true` (frontend/src/lib/coach-pre.js). It is read as one only while no set of it is done.
   What is read with it is what the day itself can be answered from (live.js cleanDay): the
   routines it was built from, and the routines of the plan that could be trained in its place. */
export const LIVE_PREVIOUS = 2;
const LIVE_MINUTES_MAX = 12 * 60;
// Before a session: what was trained lately, a line an exercise, so that "which session today,
// or none" is answered from the days behind it and not from the weekday.
export const PRE_RECENT_DAYS = 14;
export const PRE_RECENT_SESSIONS = 8;
const PRE_ROUTINES_MAX = 8;

/** The session as an answer about it is checked against (pipeline.js), or null when what was
 *  sent is not a session under way. */
export function liveContext(S, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.backfill) return null;
  const custom = new Map(list(S?.customEx).filter(c => c && typeof c === 'object').map(c => [c.id, c]));
  const nameOf = exNamer(S || {});
  const entries = [];
  list(raw.entries).slice(0, LIVE_ENTRIES_MAX).forEach((en, entry) => {
    if (!en || typeof en !== 'object' || ident(en.id) == null) return;
    const cfg = en.target && typeof en.target === 'object' ? en.target : {};
    const ex = LIB_BY_ID.get(en.id) || custom.get(en.id);
    const target = {};
    for (const [k, v] of Object.entries(targetOf(en) || {})) if (v !== undefined) target[k] = v;
    entries.push({
      entry, id: ident(en.id), name: nameOf(en.id), mode: modeOf(cfg, ex),
      ...(isBw(cfg, ex) ? { bodyweight: true } : {}),
      ...(isPerSide(cfg) ? { side: true } : {}),
      target,
      sets: setsOf(en).slice(0, LIVE_ROWS_MAX).map(cleanSet),
      ...marked(en, true)
    });
  });
  if (!entries.length) return null;
  const pre = raw.pre === true && !entries.some(e => e.sets.some(s => s.done));
  return {
    id: ident(raw.id), d: day(raw.d), name: word(raw.name, NAME_MAX),
    startedAt: typeof raw.start === 'number' && Number.isFinite(raw.start) ? raw.start : null,
    cur: Number.isInteger(raw.cur) && entries.some(e => e.entry === raw.cur) ? raw.cur : null,
    entries,
    ...(pre ? {
      pre: true,
      routineIds: list(raw.routineIds).map(ident).filter(v => v != null).slice(0, PRE_ROUTINES_MAX),
      routines: list(S?.routines)
        .filter(r => r && typeof r === 'object' && ident(r.id) != null && list(r.ex).some(e => e && typeof e === 'object'))
        .map(r => ({ id: ident(r.id), name: text(r.name == null ? '' : String(r.name), NAME_MAX) }))
    } : {})
  };
}

/** The session as the model reads it: where they are, and each exercise with its sets counted.
 *  One that has not been started has no clock and no exercise they are on. */
function liveForPayload(live, focus) {
  const minutes = live.startedAt ? Math.round((Date.now() - live.startedAt) / 60000) : null;
  const at = live.pre ? null : Number.isInteger(focus) && live.entries.some(e => e.entry === focus) ? focus : live.cur;
  return {
    ...(live.name ? { name: live.name } : {}),
    ...(live.pre ? { pre: true, routines: live.routineIds } : {}),
    ...(minutes != null && minutes >= 0 && minutes <= LIVE_MINUTES_MAX ? { minutes } : {}),
    ...(at != null ? { at } : {}),
    entries: live.entries.map(e => {
      const n = liveCounts(e);
      const { sets, flags, note, ...head } = e;
      return { ...head, setsDone: n.done, setsLeft: n.left, sets, ...(flags ? { flags } : {}), ...(note ? { note } : {}) };
    })
  };
}

/** What was said in this session so far, oldest first: their lines and the Coach's, cut. The
 *  phone keeps the thread with the session; nothing of it is held here. */
function liveThread(v) {
  return list(v)
    .filter(m => m && typeof m === 'object' && typeof m.text === 'string' && m.text.trim())
    .map(m => ({ who: (m.who || m.role) === 'coach' ? 'coach' : (m.who || m.role) === 'user' ? 'user' : null, text: m.text.trim().slice(0, LIVE_THREAD_CHARS) }))
    .filter(m => m.who)
    .slice(-LIVE_THREAD_LINES);
}

/**
 * Build a job payload.
 *
 * @param {object} S      the profile's synced state
 * @param {object} opts   { handle, kind, intake?, note?, refine?, previous?, workoutId?, cohort?, lang?, week?, digests?, live?, focus?, thread? }
 *
 * `handle` is the opaque per-profile pseudonym the payload carries instead of a uid. It is
 * supplied rather than derived because the two runtimes mint it differently: the server keys
 * an HMAC on its instance secret (api/coach/handle.js), the phone draws a random one once and
 * keeps it. Either way it is 16 characters and never the uid.
 */
export function build(S, opts = {}) {
  if (typeof opts.handle !== 'string' || !opts.handle) throw new Error('payload.build: opts.handle is required');
  const coach = S.coach || {};
  const profile = opts.intake || coach.profile || null;
  const p = {
    coach_contract: CONTRACT,
    task: opts.kind === 'review' ? 'review' : opts.kind === 'debrief' ? 'debrief' : opts.kind === 'digest' ? 'digest' : opts.kind === 'adjust' ? 'adjust' : opts.kind === 'live' ? 'live' : 'create',
    meta: {
      profile: opts.handle,
      // Both are short codes in any real state; cut anyway, since the state is the client's.
      // `opts.lang` is the language the app is showing when it asked: a profile that never
      // picked one has it worked out per device and never stored (#303).
      lang: langTag(opts.lang) || word(S.lang, 16) || 'en',
      unit: word(S.unit, 8) || 'kg',
      effortScale: effortOf(S),
      today: iso(new Date())
    },
    coachProfile: profile && typeof profile === 'object' ? cleanProfile(profile) : null,
    plan: cleanPlan(S)
  };
  // A week is written up as it stood when it ended, which for a week caught up on later is not
  // today: the block's week number and its checkpoint are placed on that day.
  const week = opts.kind === 'digest' && opts.week && typeof opts.week === 'object' ? { from: day(opts.week.from), to: day(opts.week.to) } : null;
  const charter = cleanCharter(S, coach, week?.to || p.meta.today);
  if (charter) p.charter = charter;

  // What the user already turned down, so the Coach does not re-propose it without new
  // evidence (FR-26). Summaries only — the log's full before/after stays on the device.
  const declined = (coach.log || [])
    // `why` was the Coach's own sentence, but it comes back from the synced state, which the
    // client writes; it is cut at the length the intake allows a note.
    .flatMap(e => (e.decisions || []).filter(d => d.status === 'rejected').map(d => ({ type: word(d.type, PROFILE_WORD_MAX), why: text(d.why, PROFILE_TEXT_MAX.notes) })))
    .slice(-15);
  // A note on a week proposes nothing, so there is nothing for it to propose again.
  if (declined.length && opts.kind !== 'digest' && opts.kind !== 'adjust' && opts.kind !== 'live') p.previouslyDeclined = declined;

  if (opts.kind === 'digest') {
    // One week, read whole: every session in full, the stall and mark picture as it stood on
    // the week's last day, what was changed and said during it, and the notes on the weeks
    // before, so a third week of the same thing can be called a third week. No library — a
    // note names nothing new.
    const workouts = week?.from && week?.to ? weekWorkouts(S, week.from, week.to) : [];
    const then = { ...S, workouts: list(S.workouts).filter(w => w && day(w.d) && week?.to && day(w.d) <= week.to) };
    p.week = { from: week?.from || null, to: week?.to || null, ...weekFacts(S, week?.from, week?.to), workouts: workouts.map(cleanWorkout) };
    const inWeek = new Set(workouts.flatMap(w => [...entriesOf(w), ...skippedOf(w)].map(en => ident(en.id))));
    const agg = aggregates(then, workouts);
    p.aggregates = { ...agg, exercises: agg.exercises.filter(e => inWeek.has(e.id)) };
    const seen = observations(then, inWeek);
    if (seen) p.observations = seen;
    if (week?.to) {
      const since = new Date(week.to + 'T12:00:00');
      since.setDate(since.getDate() - 28);
      p.bodyweight = { goal: num(S.targetW) ?? null, series: Number.isFinite(since.getTime()) ? weighIns(S, iso(since), week.to) : [] };
      const changed = recentChanges(S, coach).filter(c => c.on && c.on >= week.from && c.on <= week.to);
      if (changed.length) p.recentChanges = changed;
      const read = pastDebriefs(coach, week.from, week.to);
      if (read.length) p.debriefs = read;
      const before = digestsOf(coach, opts.digests).filter(g => g.to < week.from).slice(-3);
      if (before.length) p.digests = before;
    }
  } else if (opts.kind === 'adjust') {
    // The daily look at a cycle that is running: the weeks still to train as they stand, what
    // was trained lately, what each lift is at, and the programme the cycle follows, so every
    // weight can be held against that programme's own arithmetic. No library — a look changes
    // numbers, never exercises.
    const cyc = cycleState(S, coach, p.plan);
    if (cyc) {
      p.cycle = cycleForPayload(cyc, p.plan, p.meta.today, { full: true });
      const entry = cyc.program?.id ? programBrief(cyc.program.id) : null;
      if (entry) p.program = entry;
    } else p.cycle = null;
    const since = new Date(); since.setDate(since.getDate() - ADJUST_WINDOW_DAYS);
    const recent = list(S.workouts).filter(w => w && day(w.d) && day(w.d) >= iso(since)).slice(-ADJUST_SESSIONS);
    const detailFrom = Math.max(0, recent.length - FULL_DETAIL_SESSIONS);
    p.window = {
      from: day(recent[0]?.d), to: day(recent[recent.length - 1]?.d),
      workouts: [...recent.slice(0, detailFrom).map(compactWorkout), ...recent.slice(detailFrom).map(cleanWorkout)]
    };
    p.aggregates = aggregates(S, recent);
    const inCycle = new Set(list(p.plan.routines).filter(r => cyc?.routines.includes(r.id)).flatMap(r => r.ex.map(e => e.id)));
    const facts = lifts(S, inCycle);
    if (facts.length) p.lifts = facts;
    const seen = observations(S, inCycle);
    if (seen) p.observations = seen;
    p.bodyweight = { goal: num(S.targetW) ?? null, series: weighIns(S, iso(since), null) };
    if (opts.note) p.userNote = String(opts.note).slice(0, MAX_NOTE_CHARS);
  } else if (opts.kind === 'live') {
    // A question asked during a session: the session as it stands, and for its exercises what
    // the log says — the last times they were trained, what each lift is at, how often they
    // stalled, what was marked on them. Kept small on purpose: someone is standing between two
    // sets, and the answer is worth less with every second it takes.
    const live = liveContext(S, opts.live);
    p.live = live ? liveForPayload(live, opts.focus) : null;
    const inSession = new Set(live ? live.entries.map(e => e.id) : []);
    const before = list(S.workouts)
      .filter(w => w && typeof w === 'object' && day(w.d) && entriesOf(w).some(en => inSession.has(ident(en.id))))
      .slice(-LIVE_PREVIOUS);
    p.previous = before.map(w => {
      const c = cleanWorkout(w);
      return { ...c, entries: c.entries.filter(en => inSession.has(en.id)) };
    });
    const stalled = aggregates(S, []).exercises.filter(e => inSession.has(e.id));
    if (stalled.length) p.aggregates = { exercises: stalled };
    const facts = lifts(S, inSession);
    if (facts.length) p.lifts = facts;
    const seen = observations(S, inSession);
    if (seen) p.observations = seen;
    // Asked before the session: the days behind it, whatever was trained on them.
    if (live?.pre) {
      const since = new Date(); since.setDate(since.getDate() - PRE_RECENT_DAYS);
      p.recent = list(S.workouts).filter(w => w && typeof w === 'object' && day(w.d) && day(w.d) >= iso(since)).slice(-PRE_RECENT_SESSIONS).map(compactWorkout);
    }
    // Where the plan stands: the week of the cycle and what it is for, and the programme it
    // follows, so a load asked about can be held against that programme's own arithmetic.
    const cyc = cycleState(S, coach, p.plan);
    if (cyc) {
      p.cycle = cycleForPayload(cyc, p.plan, p.meta.today, { full: false });
      const entry = cyc.program?.id ? programBrief(cyc.program.id) : null;
      if (entry) p.program = entry;
    }
    if (opts.note) p.userNote = String(opts.note).slice(0, MAX_NOTE_CHARS);
    const said = liveThread(opts.thread);
    if (said.length) p.thread = said;
    // What a swap can bring in: the session's own exercises, the movements they just named, and
    // other exercises of the movement they are asking about — a taken bench is answered with
    // another press, and that has to be among the candidates.
    const asked = live?.entries.find(e => e.entry === p.live.at);
    p.library = librarySlice(S, p.coachProfile?.equipment, { keep: [...inSession], max: 60, texts: [opts.note, asked?.name] });
  } else if (opts.kind === 'debrief') {
    // One session, read closely: the workout itself, the last few times the same routine was
    // trained, and the stall picture for the exercises in it. No library — a debrief changes
    // nothing and names nothing new.
    const w = findWorkout(S, opts.workoutId);
    if (w) {
      const all = (S.workouts || []).filter(x => x && x.d);
      const idx = all.indexOf(w);
      const previous = all.slice(0, idx).filter(x => x.name && x.name === w.name).slice(-3);
      p.session = { id: ident(w.id) || null, ...cleanWorkout(w) };
      p.previous = previous.map(cleanWorkout);
      const inSession = new Set([...entriesOf(w), ...skippedOf(w)].map(en => ident(en.id)));
      const agg = aggregates(S, [w]);
      p.aggregates = { ...agg, exercises: agg.exercises.filter(e => inSession.has(e.id)) };
      // What was marked on this session's exercises before, so a second time reads as one.
      const seen = observations(S, inSession);
      if (seen) p.observations = seen;
      // The four weeks before the session. A session whose date does not parse has no "before",
      // and used to throw here instead.
      const on = day(w.d);
      const since = new Date(on + 'T12:00:00');
      since.setDate(since.getDate() - 28);
      const dated = !!on && Number.isFinite(since.getTime());
      p.bodyweight = { goal: num(S.targetW) ?? null, series: dated ? weighIns(S, iso(since), on) : [] };
    } else {
      p.session = null;
      p.previous = [];
    }
    if (opts.cohort) p.cohort = cleanCohort(opts.cohort);
  } else if (opts.kind === 'review') {
    const workouts = reviewWindow(S, coach.lastReview?.at ? String(coach.lastReview.at).slice(0, 10) : null);
    const detailFrom = Math.max(0, workouts.length - FULL_DETAIL_SESSIONS);
    // The weeks already written up. They reach back past the window — the window starts at the
    // last review, the notes do not — and inside it they stand in for the one-line sessions of
    // the weeks they cover. The last few sessions keep their sets whatever week they fall in,
    // and a week nobody wrote up keeps its lines.
    const written = digestsOf(coach, opts.digests).slice(-DIGESTS_SENT);
    const inNote = w => written.some(g => day(w.d) >= g.from && day(w.d) <= g.to);
    const lines = workouts.slice(0, detailFrom).filter(w => !inNote(w));
    p.window = {
      from: day(workouts[0]?.d),
      to: day(workouts[workouts.length - 1]?.d),
      workouts: [...lines.map(compactWorkout), ...workouts.slice(detailFrom).map(cleanWorkout)]
    };
    // Sessions of the window that are in a note instead of in the list, so the count the model
    // reports as its evidence still adds up.
    if (detailFrom > lines.length) p.window.inDigests = detailFrom - lines.length;
    if (written.length) p.digests = written;
    p.aggregates = aggregates(S, workouts);
    // What the plan asks of a week, counted the way the validator will count the answer
    // (plan-load.js): work sets by body part, and each training day's estimated minutes. Worked
    // out from the cleaned plan above, so it holds nothing the plan does not.
    const load = planLoadForPayload(p.plan, customBodyParts(S.customEx));
    if (load) p.planLoad = load;
    p.bodyweight = { goal: num(S.targetW) ?? null, series: weighIns(S, p.window.from, null) };
    // Why the plan is the way it is, and what was said about the sessions in the window.
    const changed = recentChanges(S, coach);
    if (changed.length) p.recentChanges = changed;
    const read = pastDebriefs(coach, p.window.from);
    if (read.length) p.debriefs = read;
    // What they marked on exercises, counted over twelve weeks rather than over the window.
    const seen = observations(S);
    if (seen) p.observations = seen;
    // A cycle that is running sets the sets, reps and weights week by week; a review reads that
    // it is there and where it stands, and leaves those numbers to it.
    const cyc = cycleState(S, coach, p.plan);
    if (cyc) p.cycle = cycleForPayload(cyc, p.plan, p.meta.today, { full: false });
    if (opts.note) p.userNote = String(opts.note).slice(0, MAX_NOTE_CHARS);
    if (opts.cohort) p.cohort = cleanCohort(opts.cohort);
    // A review names mostly what is already trained; 60 candidates is plenty for a swap.
    p.library = librarySlice(S, p.coachProfile?.equipment, { keep: trainedIds(S, workouts), max: 60, texts: [opts.note] });
  } else {
    // What they named in their own plan, their likes or the message they just sent is looked up
    // in the catalogue, so the exercises they asked for are there to be chosen.
    p.library = librarySlice(S, p.coachProfile?.equipment, {
      keep: trainedIds(S, S.workouts || []),
      texts: [p.coachProfile?.ownPlan, p.coachProfile?.likes, opts.refine, opts.note]
    });
    // Creation for a returning user: what they have actually handled, so proposed baselines
    // start from evidence rather than optimism (B2/FR-20).
    const best = {};
    (S.workouts || []).forEach(w => (w.entries || []).forEach(en => en.sets?.forEach(s => {
      if (s.done && s.w > 0 && !isWarmupSet(s)) best[en.id] = Math.max(best[en.id] || 0, s.w);
    })));
    if (Object.keys(best).length) {
      p.history = {
        sessions: (S.workouts || []).length,
        since: day((S.workouts || [])[0]?.d),
        workingWeights: Object.entries(best).map(([id, w]) => ({ id: ident(id), name: libraryName(id), best: w }))
      };
    }
    // What each lift they have trained is at, worked out here, for the weights a cycle sets.
    const facts = lifts(S, null);
    if (facts.length) p.lifts = facts;
    // A new plan should not bring back what was marked as painful or disliked on the old one.
    const seen = observations(S);
    if (seen) p.observations = seen;
    // Programmes from the catalogue (kb.js): the ones that fit the intake answers, or the ones
    // their own plan names. Chosen by code from answers already in `coachProfile`, so this adds
    // nothing about the person that the payload did not hold.
    const programs = programsForPayload(p.coachProfile);
    if (programs) p.programs = programs;
    if (opts.refine && opts.previous) {
      p.refine = { text: String(opts.refine).slice(0, MAX_NOTE_CHARS), previous: opts.previous };
    } else if (opts.refine) {
      // "Refine" with nothing to refine: the first plan failed, or was dismissed, and the
      // person typed what they want instead. That is a fresh plan with a note, not a
      // revision of a plan that does not exist — refine.md would be reading `previous: null`.
      p.userNote = String(opts.refine).slice(0, MAX_NOTE_CHARS);
    }
  }
  // A weekly note and a session's debrief read no conversation; a daily look does, because
  // what they typed to the Coach yesterday is part of how they are doing. A question during a
  // session has a thread of its own.
  if (opts.kind !== 'debrief' && opts.kind !== 'digest' && opts.kind !== 'live') {
    const said = conversation(coach, [opts.note, opts.refine]);
    if (said.length) p.conversation = said;
  }
  return p;
}

// The last few lines of the chat, so "shorter, like last time" has something to point at.
// The user's own lines (data, never instruction — common.md rule 3) and the Coach's earlier
// verdicts; never proposals, errors or the intake card, which travel in their own fields or
// are noise. Six lines, cut short: enough to resolve a reference, not a transcript to argue
// with. The message being sent right now rides in userNote/refine, so it is left out here.
export const CONVERSATION_LINES = 6;
export const CONVERSATION_CHARS = 240;
function conversation(coach, current) {
  const now = new Set((current || []).filter(Boolean).map(x => String(x).trim()));
  return (coach.chat || [])
    .filter(m => m && typeof m.text === 'string' && m.text.trim()
      && ((m.role === 'user' && m.kind === 'text') || (m.role === 'coach' && (m.kind === 'nochange' || m.kind === 'text'))))
    .filter(m => !(m.role === 'user' && now.has(m.text.trim())))
    .slice(-CONVERSATION_LINES)
    .map(m => ({ who: m.role === 'user' ? 'user' : 'coach', text: m.text.trim().slice(0, CONVERSATION_CHARS) }));
}
