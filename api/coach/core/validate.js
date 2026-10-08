/* The gate between a language model's output and someone's training plan.
 *
 * Everything upstream of here is advisory — the prompt asks for a shape, the model usually
 * obliges. This file is where "usually" stops mattering. Nothing reaches a user that has not
 * resolved against the real exercise library, matched the closed list of change types, and
 * stayed inside the two things the Coach is allowed to touch (routines and the week).
 *
 * That closed list is the actual security boundary of the feature. A hostile note in a user's
 * free text can talk the model into saying anything at all; it cannot invent a change type,
 * and a change type that does not exist here does nothing. `parse.js` answers "is there JSON
 * in what the provider said"; this file is the only thing that answers "is it safe to act on".
 *
 * Errors are collected rather than thrown one at a time, because they are fed back to the
 * model verbatim for the one repair round (FR-48) — and a list of six problems produces a
 * better second attempt than the first of them does.
 */
import { libraryHas, libraryName, LIB_BY_ID } from './library.js';
import { glyphStr } from './glyphs.js';
import { planLoadFindings, findingErrors, advisoriesOf, isHardFinding, changeLoadErrors, customBodyParts } from './plan-load.js';
import { programCard } from './kb.js';
import { cleanCyclePlan, cleanChanges, planAt, baseOf, withChanges, CYCLE_WEEKS_MAX, ADJUST_SUMMARY_MAX, ADJUST_NOTES_MAX } from './cycle.js';
import { cleanOps, LIVE_REPLY_MAX } from './live.js';
// The marks an exercise can carry — the list the phone's own is pinned to.
import { FLAG_KINDS } from './payload.js';

// The closed list (FR-23 / C3). Adding a member here is a deliberate act with an apply
// implementation on the client to match; there is no default case anywhere.
export const CHANGE_TYPES = [
  'add-exercise', 'remove-exercise', 'swap-exercise',
  'sets', 'reps', 'repsMin', 'repsMax', 'sec', 'cardio',
  'reorder', 'superset',
  'routine-prog', 'exercise-prog', 'inc',
  'add-routine', 'remove-routine', 'rename-routine',
  'week'
];
const POLICIES = ['off', 'linear', 'greyskull', 'double', 'time'];
const MODES = ['reps', 'time', 'cardio'];
const MAX_INC = 50;
// A prescription, not a world record. Anything past this is a model slip or a hostile answer,
// and either way it reaches the plan, the progression engine and a printed line reading "∞ kg".
const MAX_WEIGHT = 1000;
const MAX_SPEED = 60;
// Ids that are object keys downstream (exIdMap/ridMap in plan-share.js). Assigning to them is
// silently ignored and reading them back yields Object.prototype, which persists into state as
// {} — a scheduled day that is forever rest, or an exercise that is forever "Unknown".
const RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];
const safeId = v => isStr(v) && !RESERVED_IDS.includes(v);
const MAX_CHANGES = 25;
const MAX_ROUTINES = 7;
const MAX_EX_PER_ROUTINE = 20;

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);
// Routine icons: an icon key the app knows or a legacy emoji, never free text (#311).
export { ROUTINE_GLYPHS } from './glyphs.js';

/* ---------- the two v1.2.4 flags, enforced rather than merely accepted ----------
   `prompts/common.md` tells the model that unilateral work is prescribed as the total across
   both sides and therefore steps in twos, and that a rep ceiling is what turns "+1 rep
   forever" into "add a set". A prompt that asks is not a guarantee; these are the two rules
   from it that have a single right answer, so they are checked here and the repair round gets
   a chance to fix them. Everything else in that file is coaching judgement and stays advisory. */
// #313: the review prompt now states this rule, and the message names it, the offending id and
// what to do instead — a bare "is already in routine" left a temperature-0 model nothing to
// act on, and it replayed the same answer in its one repair round.
const ALREADY_IN = (where, c, routine) =>
  `${where} (${c.type}) brings in after.id "${(c.after || {}).id}", which is already in routine "${routine.name}" `
  + `(routineId "${routine.id}") — a swap-exercise or add-exercise must bring in an exercise that routine does not have yet. `
  + `Its exercises now are: ${exIdsOf(routine)}. Pick a different library id, or leave this change out`;
const exIdsOf = routine => (routine.ex || []).map(e => `"${e.id}"`).join(', ') || '(none)';
const ODD_PER_SIDE = where =>
  `${where} is a per-side exercise, so reps are the total across both sides and must be an even number`;
const INVERTED_RANGE = where =>
  `${where} sets a rep ceiling below its own floor — repsMax must be at least repsMin`;

/* ---------- the two limits of prompts/principles.md, enforced the same way ----------
   Most of that file is judgement too. Two of its rules are arithmetic: the work sets a body
   part gets in a week (V2) and the minutes a training day comes to against the session length
   the person gave (V6). plan-load.js does the counting; a plan or a set of changes over either
   limit goes back for the repair round with the count, the limit and where the sets come from.
   For a review only what the changes themselves made worse is an error — a plan its owner
   edited past a limit by hand does not make every later proposal unusable.

   A new plan the person brought themselves (`ctx.ownPlan`: the intake carries a plan they want to
   train) is not turned away over either count. It is theirs, and a programme that asks for
   twenty-four sets of chest was not written by mistake. The counts travel on the bundle instead,
   as `advisories` the plan card words for them, beside the two counts that are only ever notes:
   a body part under the weekly minimum (V1) and one over its share of a single session (V3).
   Everything that is not a count is held exactly as before — ids, the week, the working weights. */

/* =============================== created plans =============================== */

/**
 * Validate a creation bundle into something `mergePlan` can consume unchanged.
 * Returns { ok, bundle } or { ok:false, errors }.
 */
export function validatePlan(data, ctx = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) return fail(['a plan was requested but the answer said "no change"']);
  if (!Array.isArray(data.routines) || !data.routines.length) errors.push('routines must be a non-empty array');

  // A custom id that shadows a library id is the one case where the screen and the plan
  // disagree: the approval card resolves the id against the catalogue and shows that exercise,
  // while mergePlan remaps it to the model's invention. Whatever was approved is not applied.
  (Array.isArray(data.customEx) ? data.customEx : []).forEach((c, i) => {
    if (c && isStr(c.id) && libraryHas(c.id)) errors.push(`customEx[${i}].id "${c.id}" is already a library exercise id — give your own exercises their own ids`);
  });
  const customEx = (Array.isArray(data.customEx) ? data.customEx : [])
    .filter(c => c && safeId(c.id) && !libraryHas(c.id) && isStr(c.n))
    .slice(0, 20)
    .map(c => ({ id: clampStr(c.id, 40), n: clampStr(c.n, 60), bp: clampStr(c.bp || 'waist', 30), ...(c.desc ? { desc: clampStr(c.desc, 400) } : {}) }));
  // Ids the plan may name: invented in this same answer, or already the user's own.
  const proposedIds = new Set([...customEx.map(c => c.id), ...(ctx.customIds || [])]);

  const routines = [];
  (Array.isArray(data.routines) ? data.routines : []).slice(0, MAX_ROUTINES).forEach((r, ri) => {
    if (!r || typeof r !== 'object') { errors.push(`routines[${ri}] is not an object`); return; }
    if (!isStr(r.name)) errors.push(`routines[${ri}].name is required`);
    if (r.prog != null && !POLICIES.includes(r.prog)) errors.push(`routines[${ri}].prog "${r.prog}" is not one of ${POLICIES.join(', ')}`);
    const ex = [];
    (Array.isArray(r.ex) ? r.ex : []).slice(0, MAX_EX_PER_ROUTINE).forEach((e, ei) => {
      const where = `routines[${ri}].ex[${ei}]`;
      if (!e || !isStr(e.id)) { errors.push(`${where}.id is required`); return; }
      // FR-16: an id that resolves to nothing invalidates the proposal rather than being
      // dropped into a plan that renders blank the first time it is trained.
      if (!libraryHas(e.id) && !proposedIds.has(e.id)) {
        errors.push(`${where}.id "${e.id}" is not in the exercise library and is not one of your own customEx entries — use an id from the library provided in the payload`);
        return;
      }
      const clean = { id: e.id, sets: isInt(e.sets, 1, 10) ? e.sets : 3 };
      const mode = MODES.includes(e.mode) ? e.mode : 'reps';
      const perSide = !!e.side;
      if (mode === 'cardio') {
        clean.min = isInt(e.min, 1, 180) ? e.min : 20;
        clean.speed = isNum(e.speed) && e.speed > 0 && e.speed <= MAX_SPEED ? e.speed : 8;
      } else if (mode === 'time') {
        clean.mode = 'time';
        clean.sec = isInt(e.sec, 5, 3600) ? e.sec : 45;
        if (isNum(e.weight) && e.weight > 0 && e.weight <= MAX_WEIGHT) clean.weight = e.weight;
      } else {
        clean.mode = 'reps';
        clean.reps = isInt(e.reps, 1, 100) ? e.reps : 10;
        if (perSide && clean.reps % 2) { errors.push(ODD_PER_SIDE(`${where}.reps`)); return; }
        if (isNum(e.weight) && e.weight > 0 && e.weight <= MAX_WEIGHT) clean.weight = e.weight;
      }
      if (e.prog != null) {
        if (!POLICIES.includes(e.prog)) errors.push(`${where}.prog "${e.prog}" is not one of ${POLICIES.join(', ')}`);
        else clean.prog = e.prog;
      }
      if (isNum(e.inc) && e.inc > 0 && e.inc <= MAX_INC) clean.inc = e.inc;
      if (isInt(e.repsMin, 1, 100)) clean.repsMin = e.repsMin;
      // The ceiling that makes bodyweight progression terminate (upstream #33): reaching it
      // adds a set and restarts the reps. Without it the Coach can neither see nor prescribe
      // how a push-up is meant to get harder.
      if (isInt(e.repsMax, 1, 100)) clean.repsMax = e.repsMax;
      if (clean.repsMax != null && clean.repsMin != null && clean.repsMax < clean.repsMin) {
        errors.push(INVERTED_RANGE(where)); return;
      }
      // Written out only when the plan disagrees with the catalogue, matching plan-share.js —
      // an absent flag means "whatever the exercise says", which is what every plan written
      // before these existed relies on.
      if (e.bodyweight != null) clean.bodyweight = !!e.bodyweight;
      if (perSide) clean.side = true;
      if (isStr(e.sg)) clean.sg = clampStr(e.sg, 20);
      if (isStr(e.why)) clean.why = clampStr(e.why, 400);
      // The same exercise twice in one routine has no honest reading: `reorder` can never be
      // satisfied again (it demands each id once), and every targeted change resolves to
      // whichever copy comes first.
      if (ex.some(x => x.id === clean.id)) {
        errors.push(`${where}.id "${e.id}" appears twice in "${r.name || ri}" — list each exercise once`);
        return;
      }
      ex.push(clean);
    });
    if (!ex.length) errors.push(`routines[${ri}] has no valid exercises`);
    // Two routines answering to one id make the week ambiguous: `known` is a Set, so the day
    // validates while pointing at either of them.
    const rid = safeId(r.id) ? clampStr(r.id, 40) : 'r' + ri;
    if (routines.some(x => x.id === rid)) {
      errors.push(`routines[${ri}].id "${rid}" is already used by another routine in this plan`);
      return;
    }
    routines.push({
      id: rid,
      name: clampStr(r.name || 'Routine', 40),
      emoji: glyphStr(r.emoji),
      ...(POLICIES.includes(r.prog) ? { prog: r.prog } : {}),
      ...(isStr(r.why) ? { why: clampStr(r.why, 400) } : {}),
      ex
    });
  });

  // The week may only point at routines this bundle actually defines.
  const known = new Set(routines.map(r => r.id));
  const week = {};
  Object.entries(data.week || {}).forEach(([d, rid]) => {
    const day = +d;
    if (!isInt(day, 0, 6)) { errors.push(`week key "${d}" is not a weekday number 0-6`); return; }
    if (!known.has(rid)) { errors.push(`week[${d}] points at "${rid}", which is not one of the routines in this plan`); return; }
    week[day] = rid;
  });

  // FR-20: never start someone above what they have actually lifted.
  const caps = new Map((ctx.workingWeights || []).map(w => [w.id, w.best]));
  routines.forEach(r => r.ex.forEach(e => {
    if (e.weight == null) return;
    const cap = caps.get(e.id);
    // No cap for THIS exercise means they have never lifted it, whether or not they have
    // lifted anything else. Either way the number is invented, and create.md already tells the
    // model to omit it: drop it and let the first session set the baseline, like the app does.
    if (cap == null) delete e.weight;
    else if (e.weight > cap) e.weight = cap;
  }));

  // FR-17: honour the number of training days the user asked for.
  const want = ctx.daysPerWeek;
  // An absent week used to slip through: the plan then schedules nothing at all, which is not
  // the number of days anyone asked for either.
  if (isInt(want, 1, 7) && Object.keys(week).length !== want) {
    errors.push(`the week schedules ${Object.keys(week).length} days but ${want} were asked for`);
  }

  // V2 and V6: the week this plan schedules, counted. Checked beside whatever else is wrong, so
  // the one repair round hears about all of it.
  const scheduled = { routines, week };
  const custom = new Map([...(ctx.custom || []), ...customBodyParts(customEx)]);
  const findings = planLoadFindings(scheduled, { sessionMin: ctx.sessionMin, custom });
  if (!ctx.ownPlan) errors.push(...findingErrors(scheduled, findings, custom));
  const advisories = advisoriesOf(scheduled, ctx.ownPlan ? findings : findings.filter(f => !isHardFinding(f)));

  // The programme the plan says it was built from has to be one this job was handed (kb.js).
  // Anything else is the model's memory of a programme, and the card would put the catalogue's
  // name and link under it. A revision is handed its own previous plan, where `program` is the
  // card object the first answer was given; the id inside one reads the same as an id.
  const named = data.program && typeof data.program === 'object' && !Array.isArray(data.program) ? data.program.id : data.program;
  let program = null;
  if (named != null && named !== '') {
    const offered = ctx.programIds || [];
    if (isStr(named) && offered.includes(named)) program = programCard(named);
    else {
      errors.push(`program "${clampStr(named, 60)}" is not one of the programmes in this payload (${offered.length ? offered.map(id => `"${id}"`).join(', ') : 'it holds none'}) — `
        + 'put one of those ids in "program", or leave "program" out and say in "basedOn" what the plan rests on');
    }
  }
  // Where their own plan departs from the principles in ways nothing here can count, in the
  // model's words. Only for a plan they brought: on one the Coach designed there is nothing to
  // depart from but its own choices, and `summary` is where those are argued.
  const differences = ctx.ownPlan
    ? (Array.isArray(data.differences) ? data.differences : []).filter(isStr).slice(0, 6).map(d => clampStr(d.trim(), 300))
    : [];

  // The block the plan is meant to run in: a number of weeks and a few lines on what they are
  // for. It changes nothing in the plan itself (the phone keeps it as the charter's block when
  // the plan is taken), so one that cannot be read is left out rather than failing a good plan
  // over it. The cap is payload.js's BLOCK_WEEKS_MAX.
  const block = data.block && typeof data.block === 'object' && isInt(data.block.weeks, 1, 26)
    ? { weeks: data.block.weeks, ...(isStr(data.block.outline) ? { outline: clampStr(data.block.outline, 600) } : {}) }
    : null;

  // The weeks, when they are not all the same week (cycle.js): what each routine's exercises
  // are done at in each week of the block — sets, reps and the weight. It runs as long as the
  // block does; a cycle with no block is as long as its last week. Each week that has numbers is
  // held to the same two counts as the plan itself, read with that week's numbers in place, so a
  // plan cannot be inside the limits in week one and far outside them in week five.
  let cycle = null;
  // A revision is handed its previous plan, where `cycle` is the object this function made of
  // the first answer; the weeks inside one read the same as a list of weeks.
  const rawCycle = Array.isArray(data.cycle) ? data.cycle : Array.isArray(data.cycle?.plan) ? data.cycle.plan : [];
  if (rawCycle.length) {
    const listed = rawCycle.map(w => (w && Number.isInteger(w.week) ? w.week : 0));
    const weeks = Math.min(CYCLE_WEEKS_MAX, block ? block.weeks : Math.max(1, ...listed));
    const read = cleanCyclePlan(rawCycle, routines, weeks);
    errors.push(...read.errors);
    if (!read.errors.length && read.plan.length) {
      cycle = { weeks, plan: read.plan };
      if (!ctx.ownPlan) errors.push(...cycleLoadErrors(scheduled, baseOf(routines), read.plan, read.plan.filter(w => w.sessions).map(w => w.week), { sessionMin: ctx.sessionMin, custom }));
    }
  }

  if (errors.length) return fail(errors);
  return {
    ok: true,
    bundle: {
      opengym_plan: 1,
      name: clampStr(data.name || 'Coach plan', 40),
      summary: clampStr(data.summary || '', 1200),
      basedOn: clampStr(data.basedOn || '', 400),
      ...(program ? { program } : {}),
      ...(ctx.ownPlan ? { own: true } : {}),
      ...(advisories.length ? { advisories } : {}),
      ...(differences.length ? { differences } : {}),
      ...(block ? { block } : {}),
      ...(cycle ? { cycle } : {}),
      week, routines, customEx
    }
  };
}

/* =============================== review change-sets =============================== */

/**
 * Validate a review answer. Returns { ok, nochange } | { ok, proposal } | { ok:false, errors }.
 * `plan` is the payload's cleaned plan — every target must resolve against it, so a change
 * aimed at a routine that no longer exists never reaches the review screen.
 */
export function validateReview(data, plan, ctx = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (data.nochange) {
    return { ok: true, nochange: true, reading: clampStr(data.reading || data.summary || '', 1200) };
  }
  const errors = [];
  const routines = new Map((plan?.routines || []).map(r => [r.id, r]));
  // payload.librarySlice offers the model the user's own exercises alongside the catalogue, so
  // rejecting them here made every proposal naming one fail — and burn the single repair round.
  const known = new Set(ctx.customIds || []);
  const knownEx = id => libraryHas(id) || known.has(id);
  const changes = [];
  const seenIds = new Set();
  const list = Array.isArray(data.changes) ? data.changes : null;
  if (!list) return fail(['changes must be an array (or set "nochange": true with a "reading")']);

  // A swap-exercise or add-exercise that brings in an exercise the routine already has (#313)
  // is the one refusal that is dropped rather than fatal when the rest of the answer is sound:
  // like a change that restates the plan, it is self-contained — nothing else in the set can
  // depend on an exercise that never arrives — and costing a whole review over it, when the
  // lifter can simply not be shown it, helps nobody. When it is the only thing proposed, or
  // something else is also wrong, it is reported with the rest so the repair round fixes both.
  // Self-contained is checked, not assumed: another change in the same routine that names the
  // exercise it swapped out or brought in was written with it in mind — "swap 0001 for 0007"
  // next to "remove 0007" means something else once the swap is gone — so then it is fatal.
  const dropped = [];
  const droppedRefs = [];
  const dropDuplicate = (msg, where, c) => {
    errors.push(msg); dropped.push(msg);
    const t = c.target || {};
    droppedRefs.push({ where, rid: t.routineId, ids: [t.exId, (c.after || {}).id].filter(isStr) });
  };

  list.slice(0, MAX_CHANGES).forEach((c, i) => {
    const where = `changes[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return; }
    if (!CHANGE_TYPES.includes(c.type)) {
      errors.push(`${where}.type "${c.type}" is not allowed — use one of: ${CHANGE_TYPES.join(', ')}`);
      return;
    }
    if (!isStr(c.why)) { errors.push(`${where}.why is required — every change must cite the evidence behind it`); return; }
    const target = c.target || {};
    const routine = target.routineId ? routines.get(target.routineId) : null;

    // Targets: everything but add-routine and week must name a routine that exists; anything
    // touching an exercise must name one that is actually in it.
    if (!['add-routine', 'week'].includes(c.type)) {
      if (!routine) { errors.push(`${where}.target.routineId "${target.routineId}" is not one of the routines in the plan`); return; }
    }
    const needsEx = ['remove-exercise', 'swap-exercise', 'sets', 'reps', 'repsMin', 'repsMax', 'sec', 'cardio', 'exercise-prog', 'inc', 'superset'];
    let planned = null;
    if (needsEx.includes(c.type)) {
      if (!target.exId) { errors.push(`${where}.target.exId is required for type "${c.type}"`); return; }
      planned = (routine.ex || []).find(e => e.id === target.exId) || null;
      if (!planned) {
        errors.push(`${where}.target.exId "${target.exId}" is not in routine "${routine.name}" (routineId "${routine.id}") — `
          + `a change's target.exId must be one of that routine's own exercises: ${exIdsOf(routine)}`); return;
      }
    }

    // Two changes under one id share a checkbox on the review screen: ticking one applies
    // both, and React renders the list on duplicate keys.
    let cid = isStr(c.id) ? clampStr(c.id, 40) : 'c' + i;
    if (seenIds.has(cid)) cid = `${cid}-${i}`;
    seenIds.add(cid);

    const out = {
      id: cid,
      type: c.type,
      target: {
        // Same reason as `evidence` below: this is copied into the synced log. For add-routine
        // and week nothing above ever looks at routineId, so it is otherwise unbounded.
        ...(isStr(target.routineId) ? { routineId: clampStr(target.routineId, 40) } : {}),
        ...(isStr(target.exId) ? { exId: clampStr(target.exId, 40) } : {}),
        ...(isInt(target.weekday, 0, 6) ? { weekday: target.weekday } : {})
      },
      why: clampStr(c.why, 600),
      // The screen had no way to say WHICH routine: "Remove a routine" was the entire card, and
      // approving one is irreversible from that screen. The name is right here; send it.
      ...(routine ? { routineName: clampStr(routine.name || '', 40) } : {}),
      before: currentOf(c.type, routine, planned, plan, target),
      after: c.after ?? null
    };

    // Per-type checks on `after`. `before` is not checked because it is not taken: it is read
    // off the plan above, which is the only copy either side should trust.
    switch (c.type) {
      case 'add-exercise': {
        // The bundle path forbids the same exercise twice in one routine; so must this. A
        // duplicate makes every later reorder unsatisfiable, makes each targeted change resolve
        // to whichever copy comes first, and makes one "drop it" delete both.
        if ((routine.ex || []).some(e => e.id === (c.after || {}).id)) {
          dropDuplicate(ALREADY_IN(where, c, routine), where, c); return;
        }
        const a = c.after || {};
        if (!isStr(a.id) || !knownEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        const perSide = !!a.side;
        if (perSide && isInt(a.reps, 1, 100) && a.reps % 2) { errors.push(ODD_PER_SIDE(`${where}.after.reps`)); return; }
        if (isInt(a.repsMax, 1, 100) && isInt(a.repsMin, 1, 100) && a.repsMax < a.repsMin) { errors.push(INVERTED_RANGE(`${where}.after`)); return; }
        out.after = {
          id: a.id, name: libraryName(a.id),
          sets: isInt(a.sets, 1, 10) ? a.sets : 3,
          ...(MODES.includes(a.mode) ? { mode: a.mode } : { mode: 'reps' }),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isInt(a.sec, 5, 3600) ? { sec: a.sec } : {}),
          ...(isNum(a.weight) && a.weight > 0 && a.weight <= MAX_WEIGHT ? { weight: a.weight } : {}),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ...(isInt(a.repsMin, 1, 100) ? { repsMin: a.repsMin } : {}),
          ...(isInt(a.repsMax, 1, 100) ? { repsMax: a.repsMax } : {}),
          ...(a.bodyweight != null ? { bodyweight: !!a.bodyweight } : {}),
          ...(perSide ? { side: true } : {}),
          ...(isInt(a.position, 0, MAX_EX_PER_ROUTINE) ? { position: a.position } : {})
        };
        break;
      }
      case 'swap-exercise': {
        // Same rule, minus the exercise being swapped out — replacing A with B when B is
        // already there is a duplicate, not a swap.
        if ((routine.ex || []).some(e => e.id === (c.after || {}).id && e.id !== target.exId)) {
          dropDuplicate(ALREADY_IN(where, c, routine), where, c); return;
        }
        const a = c.after || {};
        if (!isStr(a.id) || !knownEx(a.id)) { errors.push(`${where}.after.id must be an exercise id from the library`); return; }
        if (a.id === target.exId) { errors.push(`${where} swaps an exercise for itself`); return; }
        out.after = {
          id: a.id, name: libraryName(a.id),
          ...(isInt(a.sets, 1, 10) ? { sets: a.sets } : {}),
          ...(isInt(a.reps, 1, 100) ? { reps: a.reps } : {}),
          ...(isNum(a.weight) && a.weight > 0 && a.weight <= MAX_WEIGHT ? { weight: a.weight } : {})
        };
        break;
      }
      case 'remove-exercise':
      case 'remove-routine':
        out.after = null;
        break;
      case 'sets': if (!isInt(c.after, 1, 10)) { errors.push(`${where}.after must be a whole number of sets (1-10)`); return; } break;
      case 'reps':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number of reps (1-100)`); return; }
        // The plan is what says whether this exercise is unilateral, so the rule is checked
        // against the plan rather than against whatever the change claims about itself.
        if (planned?.side && c.after % 2) { errors.push(ODD_PER_SIDE(`${where}.after`)); return; }
        break;
      case 'repsMin':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number (1-100)`); return; }
        if (planned?.repsMax != null && c.after > planned.repsMax) { errors.push(INVERTED_RANGE(where)); return; }
        break;
      case 'repsMax':
        if (!isInt(c.after, 1, 100)) { errors.push(`${where}.after must be a whole number (1-100)`); return; }
        if (planned?.repsMin != null && c.after < planned.repsMin) { errors.push(INVERTED_RANGE(where)); return; }
        break;
      case 'sec': if (!isInt(c.after, 5, 3600) ) { errors.push(`${where}.after must be seconds (5-3600)`); return; } break;
      case 'cardio': {
        const a = c.after || {};
        if (!isInt(a.min, 1, 180) && !isNum(a.speed)) { errors.push(`${where}.after must carry min and/or speed`); return; }
        out.after = { ...(isInt(a.min, 1, 180) ? { min: a.min } : {}), ...(isNum(a.speed) && a.speed > 0 && a.speed <= MAX_SPEED ? { speed: a.speed } : {}) };
        break;
      }
      case 'inc': if (!isNum(c.after) || c.after <= 0 || c.after > MAX_INC) { errors.push(`${where}.after must be a positive increment no larger than ${MAX_INC}`); return; } break;
      case 'routine-prog':
      case 'exercise-prog':
        if (!POLICIES.includes(c.after)) { errors.push(`${where}.after must be one of ${POLICIES.join(', ')}`); return; }
        break;
      case 'reorder': {
        const order = Array.isArray(c.after) ? c.after : null;
        if (!order) { errors.push(`${where}.after must be an array of exercise ids in the new order`); return; }
        const have = (routine.ex || []).map(e => e.id);
        // Same ids, each exactly once. Length plus membership is not enough: a list that names
        // one exercise twice and omits another satisfies both, and a reorder is the one change
        // type with nothing to show in the diff column — so it deletes an exercise on apply
        // with no way for the person approving it to see that it would.
        if (order.length !== have.length || new Set(order).size !== order.length || order.some(id => !have.includes(id))) {
          errors.push(`${where}.after must list exactly the ${have.length} exercise ids already in "${routine.name}", each once, reordered`); return;
        }
        out.after = order;
        break;
      }
      case 'superset': {
        const a = c.after || {};
        if (a.link && !isStr(a.with)) { errors.push(`${where}.after.with is required when linking a superset`); return; }
        // Supersetting something with itself resolves to a real exercise and passes the
        // membership check below; the apply path then moves the anchor out from under itself.
        if (a.link && a.with === target.exId) { errors.push(`${where} supersets an exercise with itself`); return; }
        if (a.link && !(routine.ex || []).some(e => e.id === a.with)) { errors.push(`${where}.after.with "${a.with}" is not in routine "${routine.name}"`); return; }
        out.after = { link: !!a.link, ...(a.link ? { with: a.with } : {}) };
        break;
      }
      case 'add-routine': {
        const a = c.after || {};
        if (!isStr(a.name)) { errors.push(`${where}.after.name is required`); return; }
        // FR-16 again, and for the same reason it applies to a created plan: an id that
        // resolves to nothing invalidates the proposal. Filtering it out instead would build
        // the routine the model asked for minus the exercises it could not have, and hand that
        // to someone as if it were what they were shown.
        const listed = Array.isArray(a.ex) ? a.ex : [];
        const bad = listed.find(e => !e || !isStr(e.id) || !knownEx(e.id));
        if (bad) { errors.push(`${where}.after.ex "${bad.id}" is not in the exercise library — use an id from the library provided in the payload`); return; }
        const ex = listed.slice(0, MAX_EX_PER_ROUTINE);
        if (!ex.length) { errors.push(`${where}.after.ex must list at least one exercise from the library`); return; }
        const odd = ex.find(e => e.side && isInt(e.reps, 1, 100) && e.reps % 2);
        if (odd) { errors.push(ODD_PER_SIDE(`${where}.after.ex "${odd.id}"`)); return; }
        out.after = {
          name: clampStr(a.name, 40), emoji: glyphStr(a.emoji),
          ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
          ex: ex.map(e => ({
            id: e.id, name: libraryName(e.id),
            sets: isInt(e.sets, 1, 10) ? e.sets : 3,
            mode: MODES.includes(e.mode) ? e.mode : 'reps',
            ...(isInt(e.reps, 1, 100) ? { reps: e.reps } : {}),
            ...(isInt(e.sec, 5, 3600) ? { sec: e.sec } : {}),
            ...(isInt(e.repsMin, 1, 100) ? { repsMin: e.repsMin } : {}),
            ...(isInt(e.repsMax, 1, 100) ? { repsMax: e.repsMax } : {}),
            ...(POLICIES.includes(e.prog) ? { prog: e.prog } : {}),
            ...(isNum(e.inc) && e.inc > 0 && e.inc <= MAX_INC ? { inc: e.inc } : {}),
            ...(e.bodyweight != null ? { bodyweight: !!e.bodyweight } : {}),
            ...(e.side ? { side: true } : {})
          }))
        };
        break;
      }
      case 'rename-routine':
        if (!isStr(c.after)) { errors.push(`${where}.after must be the new routine name`); return; }
        out.after = clampStr(c.after, 40);
        break;
      case 'week': {
        if (!isInt(target.weekday, 0, 6)) { errors.push(`${where}.target.weekday must be 0-6`); return; }
        // null/'rest' clears the day; anything else has to be a routine that exists.
        if (c.after != null && c.after !== 'rest' && !routines.has(c.after)) {
          errors.push(`${where}.after must be a routine id from the plan, "rest", or null`); return;
        }
        out.after = c.after ?? null;
        break;
      }
    }
    changes.push(out);
  });

  const namesOf = ch => {
    const a = ch.after && typeof ch.after === 'object' && !Array.isArray(ch.after) ? ch.after : {};
    return [ch.target.exId, a.id, a.with].filter(isStr);
  };
  droppedRefs.forEach(d => {
    const dep = changes.find(ch => ch.target.routineId === d.rid && namesOf(ch).some(id => d.ids.includes(id)));
    if (dep) {
      const id = namesOf(dep).find(x => d.ids.includes(x));
      errors.push(`${d.where} cannot just be left out: change "${dep.id}" (${dep.type}) in the same routine also names exercise "${id}", `
        + `and without ${d.where} it would do something other than what was meant — propose these changes again as one set that holds together`);
    }
  });
  if (errors.length > dropped.length) return fail(errors);
  if (dropped.length && !changes.length) return fail(errors);
  errors.length = 0;
  // Everything above validates one change against the ORIGINAL plan. These are the things that
  // are only wrong in company — each one validates alone, and together they are incoherent or
  // destructive. The user approves a screen, not a change, so the screen has to be coherent.
  const SCALAR = ['sets', 'reps', 'repsMin', 'repsMax', 'sec', 'inc', 'routine-prog', 'exercise-prog', 'rename-routine', 'week'];
  const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const byRoutine = new Map();
  const weekdays = new Set();
  const removedRoutines = new Set();
  const addsPerRoutine = new Map();
  let addedRoutines = 0;

  // A change whose `after` already equals the plan is dropped rather than refused: one
  // redundant entry should not cost the whole review, and as padding around something
  // destructive it is exactly what should not reach the screen. If they all go, the answer was
  // "no change" and is reported as such below.
  const kept = changes.filter(ch => !(SCALAR.includes(ch.type) && sameValue(ch.before, ch.after)));

  // Checked per change above against the plan as it stands; two changes that each bring the
  // same exercise into one routine pass that alone and duplicate it together.
  const incoming = new Map();
  kept.forEach(ch => {
    const rid = ch.target.routineId;
    if (['add-exercise', 'swap-exercise'].includes(ch.type)) {
      const key = rid + '\u0000' + ch.after.id;
      if (incoming.has(key)) {
        errors.push(`changes "${incoming.get(key)}" and "${ch.id}" both bring exercise "${ch.after.id}" into routine "${routines.get(rid)?.name || rid}" — an exercise can appear in a routine only once, so keep one of them`);
      } else incoming.set(key, ch.id);
    }
    if (rid) {
      if (!byRoutine.has(rid)) byRoutine.set(rid, []);
      byRoutine.get(rid).push(ch.type);
    }
    if (ch.type === 'remove-routine') removedRoutines.add(rid);
    if (ch.type === 'add-routine') addedRoutines++;
    if (ch.type === 'add-exercise') addsPerRoutine.set(rid, (addsPerRoutine.get(rid) || 0) + 1);
    if (ch.type === 'week') {
      const d = ch.target.weekday;
      if (weekdays.has(d)) errors.push(`two changes both reschedule weekday ${d} — only one can win`);
      weekdays.add(d);
    }
  });

  byRoutine.forEach((types, rid) => {
    // A reorder is a permutation of the list as it stands. Applied after something that added,
    // removed or replaced an exercise it no longer describes that list, and the client throws
    // mid-apply — which discards the whole approved set and blames the app.
    if (types.includes('reorder') && types.some(t => ['add-exercise', 'remove-exercise', 'swap-exercise'].includes(t))) {
      errors.push(`routine "${routines.get(rid)?.name || rid}" is both reordered and restructured in one review — propose the reorder next time, against the list it will actually have`);
    }
    if (removedRoutines.has(rid) && types.some(t => t !== 'remove-routine')) {
      errors.push(`routine "${routines.get(rid)?.name || rid}" is removed and also changed in the same review`);
    }
  });

  // The bundle path bounds these; the change path did not, so 25 changes could walk past both.
  addsPerRoutine.forEach((n, rid) => {
    const have = (routines.get(rid)?.ex || []).length;
    if (have + n > MAX_EX_PER_ROUTINE) errors.push(`routine "${routines.get(rid)?.name || rid}" would end up with ${have + n} exercises, more than the ${MAX_EX_PER_ROUTINE} allowed`);
  });
  if (routines.size + addedRoutines - removedRoutines.size > MAX_ROUTINES) {
    errors.push(`the plan would end up with more than the ${MAX_ROUTINES} routines allowed`);
  }

  // V2 and V6: what the changes add up to, once they are all applied.
  errors.push(...changeLoadErrors(plan, kept, { sessionMin: ctx.sessionMin, custom: ctx.custom }));

  if (errors.length) return fail([...errors, ...dropped]);

  // Everything that was proposed turned out to duplicate an exercise or restate the plan. With
  // a duplicate among them this is not an honest "no change" — the summary still describes the
  // swap — so it goes back for repair rather than out as a reading.
  if (!kept.length && dropped.length) return fail(dropped);
  if (!kept.length) {
    // An empty change list and "no changes" are the same outcome; treat it as the latter
    // rather than showing someone an empty proposal screen (FR-25).
    return { ok: true, nochange: true, reading: clampStr(data.summary || data.reading || '', 1200) };
  }
  return {
    ok: true,
    proposal: {
      summary: clampStr(data.summary || '', 1200),
      evidence: {
        // Clamped because this is stored verbatim in the synced coach log, and trim() cannot
        // shrink a single oversized entry — one answer could push a profile permanently over
        // the state-sync limit.
        from: isStr(data.evidence?.from) ? clampStr(data.evidence.from, 40) : null,
        to: isStr(data.evidence?.to) ? clampStr(data.evidence.to, 40) : null,
        sessions: isInt(data.evidence?.sessions, 0, 10000) ? data.evidence.sessions : null
      },
      changes: kept,
      notes: (Array.isArray(data.notes) ? data.notes : []).filter(isStr).slice(0, 6).map(n => clampStr(n, 600))
    }
  };
}

/**
 * What the plan says right now for whatever a change is about — the `before` the client checks
 * for staleness. Read off the plan rather than copied from the answer, because the model's idea
 * of the current value is the one field on a change that nothing else constrains: an object of
 * any size passes through into the proposal and then into the synced Coach log, and a merely
 * mistyped one ("3 sets" where the plan holds 3) makes markStale() disable a change that was
 * perfectly good. The plan is already in scope here, and it is not a matter of opinion.
 *
 * Mirrors `currentValue` in frontend/src/lib/coach.js — structural changes have no single
 * scalar to compare and get null, which that function reads as "nothing to check".
 */
function currentOf(type, routine, planned, plan, target) {
  switch (type) {
    case 'sets': return planned?.sets ?? null;
    case 'reps': return planned?.reps ?? null;
    case 'repsMin': return planned?.repsMin ?? null;
    case 'repsMax': return planned?.repsMax ?? null;
    case 'sec': return planned?.sec ?? null;
    case 'inc': return planned?.inc ?? null;
    case 'exercise-prog': return planned?.prog ?? null;
    case 'routine-prog': return routine?.prog ?? null;
    case 'rename-routine': return routine?.name ?? null;
    case 'week': return plan?.week?.[target?.weekday] ?? null;
    default: return null;
  }
}

function fail(errors) { return { ok: false, errors }; }

/* =============================== a cycle's weeks =============================== */

/**
 * What the weeks of a cycle ask for beyond the two counted limits, as errors for the repair
 * round. A limit broken the same way in several weeks is reported once, for its worst week, with
 * the other weeks named — six copies of one sentence help nobody fix it.
 */
function cycleLoadErrors(plan, base, cyclePlan, weeks, limits, before) {
  const read = (cp, week) => {
    const at = planAt(plan, base, cp, week);
    return planLoadFindings(at, limits).filter(isHardFinding).map(f => ({
      key: f.code + '|' + (f.bp || f.session.key), size: f.code === 'weekly-over' ? f.sets : f.minutes,
      line: findingErrors(at, [f], limits.custom)[0]
    }));
  };
  const worst = new Map();
  for (const week of weeks) {
    // With the weeks as they stood given, only what the new numbers made worse counts: a cycle
    // its owner had already taken past a limit does not make every later correction unusable.
    const was = before ? new Map(read(before, week).map(f => [f.key, f.size])) : null;
    for (const f of read(cyclePlan, week)) {
      if (was && was.get(f.key) >= f.size) continue;
      const had = worst.get(f.key);
      if (!had) worst.set(f.key, { ...f, week, also: [] });
      else if (f.size > had.size) worst.set(f.key, { ...f, week, also: [...had.also, had.week] });
      else had.also.push(week);
    }
  }
  return [...worst.values()].map(x =>
    `in week ${x.week} of the cycle${x.also.length ? ` (and in week${x.also.length > 1 ? 's' : ''} ${x.also.sort((a, b) => a - b).join(', ')})` : ''}, ${x.line}`);
}

/**
 * Validate a daily look at a running cycle: changes to the numbers of weeks not yet trained.
 *
 * It can move sets, reps, seconds and weights of exercises the cycle's routines already hold,
 * and reword what a week is for. It cannot add, remove or swap an exercise or move a day — those
 * are a review's, and the person's to approve; `notes` is where it says one is called for.
 *
 * `ctx.cycle` is payload.js cycleContext: the cycle as it stands, with the week it is in.
 * Returns { ok, nochange, reading } | { ok, proposal:{ summary, changes, focus, notes } } | { ok:false, errors }.
 */
export function validateAdjust(data, ctx = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  const cyc = ctx.cycle;
  if (!cyc) return fail(['no cycle is running, so there is nothing to adjust']);
  const notes = (Array.isArray(data.notes) ? data.notes : []).filter(isStr).slice(0, ADJUST_NOTES_MAX).map(n => clampStr(n.trim(), 300));
  const nothing = () => ({ ok: true, nochange: true, reading: clampStr(data.reading || data.summary || '', ADJUST_SUMMARY_MAX), ...(notes.length ? { notes } : {}) });
  if (data.nochange) return nothing();
  if (data.changes != null && !Array.isArray(data.changes)) return fail(['changes must be an array (or set "nochange": true with a "reading")']);
  const read = cleanChanges(data, cyc, cyc.week);
  const errors = [...read.errors];
  // A change that sets what the week already holds is no change; all of them gone is "nothing
  // to change", said honestly.
  const numbers = new Map();
  const at = n => { if (!numbers.has(n)) numbers.set(n, planAt({ routines: cyc.routines, week: cyc.schedule }, cyc.base, cyc.plan, n)); return numbers.get(n); };
  const kept = read.changes.filter(c => {
    const now = at(c.week).routines.find(r => r.id === c.routine)?.ex.find(e => e.id === c.exId) || {};
    return ['sets', 'reps', 'sec', 'weight'].some(k => c[k] != null && Number(now[k] ?? 0) !== c[k]);
  });
  if (!errors.length && !ctx.ownPlan && kept.length) {
    const weeks = [...new Set(kept.map(c => c.week))].sort((a, b) => a - b);
    errors.push(...cycleLoadErrors({ routines: cyc.routines, week: cyc.schedule }, cyc.base, withChanges(cyc.plan, kept, []), weeks,
      { sessionMin: ctx.sessionMin, custom: ctx.custom }, cyc.plan));
  }
  if (errors.length) return fail(errors);
  if (!kept.length && !read.focus.length) return nothing();
  if (!isStr(data.summary)) return fail(['summary is required — one or two sentences on what you saw in the log and what you changed']);
  return {
    ok: true,
    proposal: {
      summary: clampStr(data.summary.trim(), ADJUST_SUMMARY_MAX),
      changes: kept,
      ...(read.focus.length ? { focus: read.focus } : {}),
      ...(notes.length ? { notes } : {})
    }
  };
}

/* =============================== a session under way =============================== */

/**
 * Validate an answer given during a session: a few sentences, and ops on the session itself.
 *
 * The ops are core/live.js's closed list and reach no further than the session the phone sent.
 * The plan and the cycle cannot be changed from here; an answer that tries is refused, so that
 * what the reply says was done and what the cards offer cannot come apart. A weight is held to
 * being a weight and no more: whether it is the right one is the Coach's to judge against the
 * programme and the log, as in a cycle.
 *
 * `ctx.live` is payload.js liveContext; `ctx.customIds` and `ctx.names` are the person's own
 * exercises, which a swap may bring in as well as the catalogue's.
 * Returns { ok, proposal:{ reply, ops, flags } } | { ok:false, errors }.
 */
export function validateLive(data, ctx = {}) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  if (!ctx.live) return fail(['no session is under way, so there is nothing to answer about']);
  const errors = [];
  if (!isStr(data.reply)) errors.push('reply is required — answer what they asked in a few sentences, the conclusion and its number first');
  if (Array.isArray(data.changes) && data.changes.length) {
    errors.push('an answer during a session carries no plan changes — what should change today goes in "ops"; what should change in the plan is a review\'s, so say it in "reply"');
  }
  const own = new Set(ctx.customIds || []);
  const names = ctx.names || {};
  const lookup = id => (libraryHas(id) ? { name: libraryName(id), cardio: LIB_BY_ID.get(id).bp === 'cardio' }
    : own.has(id) ? { name: isStr(names[id]) ? clampStr(names[id], 80) : null, cardio: false } : null);
  const read = cleanOps(data, ctx.live, { lookup, flagKinds: FLAG_KINDS });
  errors.push(...read.errors);
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { reply: cutText(data.reply, LIVE_REPLY_MAX), ops: read.ops, flags: read.flags } };
}

/* =============================== workout debriefs =============================== */

const DEBRIEF_LISTS = ['highlights', 'watch', 'nextTime'];
const MAX_DEBRIEF_ITEMS = 5;

/**
 * Validate a debrief — a reading of one session with nothing to apply. Strings and short lists
 * only: the closed list of change types does not apply because a debrief cannot carry a change
 * at all, and one that tries is refused rather than trimmed.
 * Returns { ok, proposal:{ summary, score, highlights, watch, nextTime } } | { ok:false, errors }.
 */
export function validateDebrief(data) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  const errors = [];
  if (data.nochange) errors.push('a debrief was requested — "nochange" is not an answer here; read the session and say what you saw');
  if (Array.isArray(data.changes) && data.changes.length) errors.push('a debrief carries no plan changes — drop "changes" and put advice into "nextTime"');
  if (!isStr(data.summary)) errors.push('summary is required — two or three sentences on how the session went');
  let score = null;
  if (typeof data.score === 'number' && Number.isFinite(data.score)) score = Math.max(1, Math.min(10, Math.round(data.score)));
  else errors.push('score must be a whole number from 1 to 10');
  const lists = {};
  DEBRIEF_LISTS.forEach(k => {
    const v = data[k];
    if (v != null && !Array.isArray(v)) { errors.push(`${k} must be an array of short strings`); lists[k] = []; return; }
    lists[k] = (v || []).filter(isStr).map(x => clampStr(x.trim(), 300)).slice(0, MAX_DEBRIEF_ITEMS);
  });
  if (!DEBRIEF_LISTS.some(k => lists[k].length)) errors.push('at least one of highlights, watch or nextTime must have an item');
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { summary: clampStr(data.summary.trim(), 600), score, ...lists } };
}

/* =============================== the week, written up =============================== */

// The same limits payload.js reads a kept note back at (DIGEST_*); api/test/digest.test.js pins
// them together. A note is read again by every review for months, so it is held to its size here.
export const DIGEST_LISTS = ['progress', 'issues', 'carry'];
export const DIGEST_SUMMARY_MAX = 500;
export const DIGEST_ITEMS_MAX = 4;
export const DIGEST_ITEM_MAX = 160;

/** Text held to a length without stopping mid-sentence where it can be helped: back to the last
 *  full stop when that keeps at least half of what was allowed, and at the limit otherwise. A
 *  note cut off at "the squat sto" would be read back that way for twelve weeks. */
function cutText(v, n) {
  const s = String(v).trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const end = Math.max(...['. ', '! ', '? ', '。', '！', '？'].map(m => head.lastIndexOf(m)));
  return end >= n / 2 ? head.slice(0, end + 1).trim() : head;
}

/**
 * Validate a weekly note — a few sentences and three short lists about one week, with nothing
 * to apply and nothing to decide. Like a debrief it cannot carry a change, and one that tries is
 * refused rather than trimmed. The week's counts are not asked of the model at all: the caller
 * attaches them from the log (payload.js weekFacts).
 * Returns { ok, proposal:{ summary, progress, issues, carry } } | { ok:false, errors }.
 */
export function validateDigest(data) {
  if (!data || typeof data !== 'object') return fail(['the answer was not an object']);
  const errors = [];
  if (data.nochange) errors.push('a note on the week was requested — "nochange" is not an answer here; write down what happened');
  if (Array.isArray(data.changes) && data.changes.length) errors.push('a note on the week carries no plan changes — drop "changes" and put what a review should look at into "carry"');
  if (!isStr(data.summary)) errors.push('summary is required — three or four sentences on how the week went, with its numbers');
  const lists = {};
  DIGEST_LISTS.forEach(k => {
    const v = data[k];
    if (v != null && !Array.isArray(v)) { errors.push(`${k} must be an array of short strings`); lists[k] = []; return; }
    lists[k] = (v || []).filter(isStr).slice(0, DIGEST_ITEMS_MAX).map(x => cutText(x, DIGEST_ITEM_MAX));
  });
  if (errors.length) return fail(errors);
  return { ok: true, proposal: { summary: cutText(data.summary, DIGEST_SUMMARY_MAX), ...lists } };
}
