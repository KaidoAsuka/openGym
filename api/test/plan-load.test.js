/* The two limits the principles prompt states as arithmetic, and the counting behind them.
 *
 * A limit the validator enforces is a promise in two directions: a plan over it never reaches
 * anyone, and a sound plan is never turned away. So next to the refusals this file keeps the
 * plans that must go through — an ordinary six-day split, a plan its owner had already edited
 * past a limit — because a gate that rejects those costs someone a job and tells them nothing.
 *
 * The frontend's coach-load.test.js holds projectPlan against the phone's own apply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempData } from './helpers.mjs';

tempData();
const {
  planLoad, planLoadForPayload, projectPlan, planLoadErrors, changeLoadErrors, customBodyParts,
  WEEKLY_SETS_MAX, SET_MINUTES, SUPERSET_SET_MINUTES, TIMED_REST_SEC, TIMED_SUPERSET_REST_SEC
} = await import('../coach/core/plan-load.js');
const { validatePlan, validateReview } = await import('../coach/core/validate.js');
const { build } = await import('../coach/core/payload.js');
const { LIB_BY_ID } = await import('../coach/core/library.js');
const { runPipeline } = await import('../coach/core/pipeline.js');

// Catalogue ids by the body part the count goes to. The first assertion below pins them, so a
// regenerated dataset that moved one fails there and not three tests later.
const BENCH = '0025', INCLINE = '0047', FLY = '0308', DIP = '0251';          // chest
const SQUAT = '0043', DEADLIFT = '0032', LEGPRESS = '0739', LEGCURL = '0586'; // upper legs
const ROW = '0027', PULLUP = '0652', PULLDOWN = '0198';                       // back
const PRESS = '0091', RAISE = '0334';                                         // shoulders
const CURL = '0031', PUSHDOWN = '0201';                                       // upper arms
const CALF = '0594';                                                          // lower legs
const SITUP = '0001';                                                         // waist
const BURPEE = '1160';                                                        // cardio
const STRETCH = '1512';                                                       // upper legs, a stretch

const x = (id, sets, over = {}) => ({ id, sets, mode: 'reps', reps: 8, ...over });
const change = over => ({ id: 'c1', type: 'sets', target: { routineId: 'push', exId: BENCH }, before: 4, after: 5, why: 'three clean sessions', ...over });

// Six days, 19-20 sets each: the plan a gate like this must never turn away.
const PPL = {
  routines: [
    { id: 'push', name: 'Push', ex: [x(BENCH, 4), x(PRESS, 3), x(INCLINE, 3), x(RAISE, 3), x(PUSHDOWN, 3), x(FLY, 3)] },
    { id: 'pull', name: 'Pull', ex: [x(ROW, 4), x(PULLDOWN, 3), x(PULLUP, 3), x(CURL, 3), x(CURL + 'x', 3), x(CALF, 3)] },
    { id: 'legs', name: 'Legs', ex: [x(SQUAT, 4), x(DEADLIFT, 3), x(LEGPRESS, 3), x(LEGCURL, 3), x(CALF, 4), x(SITUP, 3)] }
  ],
  week: { 1: ['push'], 2: ['pull'], 3: ['legs'], 4: ['push'], 5: ['pull'], 6: ['legs'] }
};

test('the ids this file counts with are the body parts it says they are', () => {
  const bp = id => LIB_BY_ID.get(id)?.bp;
  for (const id of [BENCH, INCLINE, FLY, DIP]) assert.equal(bp(id), 'chest', id);
  for (const id of [SQUAT, DEADLIFT, LEGPRESS, LEGCURL, STRETCH]) assert.equal(bp(id), 'upper legs', id);
  for (const id of [ROW, PULLUP, PULLDOWN]) assert.equal(bp(id), 'back', id);
  for (const id of [PRESS, RAISE]) assert.equal(bp(id), 'shoulders', id);
  for (const id of [CURL, PUSHDOWN]) assert.equal(bp(id), 'upper arms', id);
  assert.equal(bp(CALF), 'lower legs');
  assert.equal(bp(SITUP), 'waist');
  assert.equal(bp(BURPEE), 'cardio');
});

/* ---------------- counting ---------------- */

test('sets count once toward their body part, over the week as scheduled', () => {
  const load = planLoad(PPL);
  // Push is trained twice: (4 + 3 + 3) chest sets a day.
  assert.equal(load.weeklySets.chest, 20);
  assert.equal(load.weeklySets.shoulders, 12);
  assert.equal(load.weeklySets.back, 20);
  // Pushdowns on push days, curls on pull days; the id nobody knows counts toward nothing.
  assert.equal(load.weeklySets['upper arms'], 12);
  assert.equal(load.weeklySets['upper legs'], 26);
  assert.equal(load.weeklySets['lower legs'], 14);
  assert.equal(load.sessions.length, 6);
  assert.deepEqual(load.sessions[0], { key: 'day:1', weekday: 1, routines: ['push'], sets: 19, minutes: 48 });
});

test('a routine no day holds adds nothing to the week and is still a session', () => {
  const load = planLoad({ routines: [{ id: 'a', name: 'A', ex: [x(BENCH, 4)] }, { id: 'b', name: 'B', ex: [x(SQUAT, 6)] }], week: { 1: 'a' } });
  assert.deepEqual(load.weeklySets, { chest: 4 });
  assert.deepEqual(load.sessions.map(s => s.key), ['day:1', 'routine:b']);
  assert.equal(load.sessions[1].minutes, 15);
});

test('a combined day is one session, a bundle\'s bare id and a payload\'s list read alike', () => {
  const routines = [{ id: 'a', name: 'A', ex: [x(BENCH, 4)] }, { id: 'b', name: 'B', ex: [x(SQUAT, 4)] }];
  const combined = planLoad({ routines, week: { 2: ['a', 'b'], 4: ['a', 'gone'] } });
  assert.deepEqual(combined.sessions.map(s => [s.weekday, s.sets, s.minutes]), [[2, 8, 20], [4, 4, 10]]);
  assert.deepEqual(combined.weeklySets, { chest: 8, 'upper legs': 4 });
  assert.deepEqual(planLoad({ routines, week: { 1: 'a' } }).weeklySets, planLoad({ routines, week: { 1: ['a'] } }).weeklySets);
});

test('cardio and stretches take time and count toward no body part; a person\'s own exercise counts by the body part they gave it', () => {
  const plan = {
    routines: [{ id: 'a', name: 'A', ex: [
      x(BURPEE, 2, { mode: 'cardio', min: 10 }), x(STRETCH, 3, { mode: 'time', sec: 30 }), x('mine', 3), x('other', 3)
    ] }],
    week: { 1: ['a'] }
  };
  const load = planLoad(plan, customBodyParts([{ id: 'mine', bp: 'Back', custom: true }, { id: 'other', bp: 'somewhere' }]));
  assert.deepEqual(load.weeklySets, { back: 3 });
  // 2 x 10 of cardio, three half-minute holds with their minute of rest, six straight sets.
  assert.equal(load.sessions[0].minutes, Math.round(20 + 3 * 1.5 + 6 * 2.5));
  assert.equal(load.sessions[0].sets, 9);
});

test('minutes: a straight set, a set in a superset, a hold with its rest', () => {
  const day = ex => planLoad({ routines: [{ id: 'a', ex }], week: { 1: ['a'] } }).sessions[0].minutes;
  assert.equal(day([x(BENCH, 4)]), 4 * SET_MINUTES);
  assert.equal(day([x(BENCH, 4, { sg: 's' }), x(ROW, 4, { sg: 's' })]), 8 * SUPERSET_SET_MINUTES);
  // A tag with no neighbour sharing it is not a superset.
  assert.equal(day([x(BENCH, 4, { sg: 's' }), x(ROW, 4)]), 8 * SET_MINUTES);
  assert.equal(day([x(SITUP, 4, { mode: 'time', sec: 60 })]), 4 * (60 + TIMED_REST_SEC) / 60);
  assert.equal(day([x(SITUP, 4, { mode: 'time', sec: 60, sg: 's' }), x(BENCH, 2, { sg: 's' })]), 4 * (60 + TIMED_SUPERSET_REST_SEC) / 60 + 2 * SUPERSET_SET_MINUTES);
  // Numbers the app wrote as strings are still numbers; nonsense is nothing.
  assert.equal(day([x(BENCH, '4'), x(ROW, 'many')]), 10);
});

test('the principles prompt states the limits the code holds', () => {
  const md = fs.readFileSync(new URL('../coach/prompts/principles.md', import.meta.url), 'utf8');
  for (const [bp, max] of Object.entries(WEEKLY_SETS_MAX)) assert.ok(md.includes('`' + bp + '` ' + max), `${bp} ${max}`);
  assert.ok(md.includes(`${SET_MINUTES} minutes per straight set`));
  assert.ok(md.includes(`${SUPERSET_SET_MINUTES} per set of an exercise in a superset`));
  assert.equal(TIMED_REST_SEC, 60);            // "its seconds plus one minute"
  assert.equal(TIMED_SUPERSET_REST_SEC, 30);   // "half a minute in a superset"
  // create.md repeats the two set costs where the plan is built.
  const create = fs.readFileSync(new URL('../coach/prompts/create.md', import.meta.url), 'utf8');
  assert.ok(create.includes(`${SET_MINUTES} minutes per straight set, ${SUPERSET_SET_MINUTES} per set of an exercise in a superset`));
});

/* ---------------- a new plan ---------------- */

test('an ordinary six-day split is inside both limits', () => {
  assert.deepEqual(planLoadErrors(PPL, { sessionMin: 60 }), []);
});

test('a plan over a body part\'s ceiling is refused with the count, the limit and where the sets come from', () => {
  const plan = { routines: [{ id: 'c', name: 'Chest day', ex: [x(BENCH, 5), x(INCLINE, 4), x(FLY, 4)] }], week: { 1: 'c', 4: 'c' } };
  const [err, ...rest] = planLoadErrors(plan);
  assert.equal(rest.length, 0);
  assert.match(err, /"chest" 26 work sets a week, over the 20/);
  assert.match(err, /principle V2/);
  assert.match(err, new RegExp(`"${BENCH}" 5 x2 in "Chest day"`));
  assert.match(err, /at least 6 of those sets/);
});

test('a day that does not fit the session length is refused, and only when a length was given', () => {
  const plan = { routines: [{ id: 'a', name: 'Long', ex: [x(BENCH, 5), x(ROW, 5), x(SQUAT, 5), x(PRESS, 5), x(CURL, 5)] }], week: { 3: 'a' } };
  assert.deepEqual(planLoadErrors(plan), []);
  assert.deepEqual(planLoadErrors(plan, { sessionMin: 65 }), []);
  const [err] = planLoadErrors(plan, { sessionMin: 45 });
  assert.match(err, /Wednesday \("Long"\) comes to about 63 minutes/);
  assert.match(err, /over the 45 minutes/);
  assert.match(err, /principle V6/);
  assert.match(err, /about 8 sets/);
});

test('validatePlan holds a created plan to both, and says so beside whatever else is wrong', () => {
  const plan = (sets, over = {}) => ({
    name: 'P', week: { 1: 'r1', 4: 'r1' },
    routines: [{ id: 'r1', name: 'Chest', ex: [{ id: BENCH, sets, reps: 8 }, { id: INCLINE, sets, reps: 10 }, { id: FLY, sets, reps: 12 }] }],
    ...over
  });
  assert.equal(validatePlan(plan(3)).ok, true);
  const over = validatePlan(plan(4));
  assert.equal(over.ok, false);
  assert.ok(over.errors.some(e => /"chest" 24 work sets a week/.test(e)));
  // 9 sets is about 23 minutes: fine for half an hour, not for twenty minutes.
  assert.equal(validatePlan(plan(3), { sessionMin: 30 }).ok, true);
  const long = validatePlan(plan(3), { sessionMin: 20 });
  assert.ok(long.errors.some(e => /comes to about 23 minutes/.test(e)));
  // The repair round hears about the limit and the bad id together.
  const both = validatePlan(plan(4, { week: { 1: 'r1', 4: 'r1', 5: 'nope' } }));
  assert.ok(both.errors.some(e => /"chest" 24/.test(e)) && both.errors.some(e => /nope/.test(e)));
});

test('an exercise a new plan invents counts by the body part the plan gave it', () => {
  const r = validatePlan({
    week: { 1: 'r1', 3: 'r1', 5: 'r1' },
    routines: [{ id: 'r1', name: 'A', ex: [{ id: 'cx1', sets: 8, reps: 10 }] }],
    customEx: [{ id: 'cx1', n: 'Sandbag press', bp: 'chest' }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /"chest" 24 work sets a week/.test(e)));
});

/* ---------------- a review's changes ---------------- */

test('projectPlan applies what moves a count and leaves the plan it was given alone', () => {
  const plan = {
    routines: [
      { id: 'a', name: 'A', ex: [x(BENCH, 3), x(ROW, 3, { sg: 's' }), x(CURL, 3, { sg: 's' }), x(SITUP, 3, { mode: 'time', sec: 30 })] },
      { id: 'b', name: 'B', ex: [x(SQUAT, 3)] }
    ],
    week: { 1: ['a'], 3: ['b'] }
  };
  const frozen = JSON.stringify(plan);
  const after = changes => projectPlan(plan, changes.map((c, i) => ({ id: 'c' + i, ...c })));
  const exA = p => p.routines[0].ex;

  assert.equal(exA(after([{ type: 'sets', target: { routineId: 'a', exId: BENCH }, after: 5 }]))[0].sets, 5);
  assert.equal(exA(after([{ type: 'sec', target: { routineId: 'a', exId: SITUP }, after: 60 }]))[3].sec, 60);
  const added = exA(after([{ type: 'add-exercise', target: { routineId: 'a' }, after: { id: FLY, position: 2 } }]));
  assert.deepEqual([added[2].id, added[2].sets, added.length], [FLY, 3, 5]);
  // Dropped between the pair, the new exercise splits the superset; so does removing a partner.
  assert.ok(!added.some(e => e.sg));
  const removed = exA(after([{ type: 'remove-exercise', target: { routineId: 'a', exId: CURL } }]));
  assert.ok(removed.length === 3 && !removed.some(e => e.sg));
  // A swap keeps the prescription unless the change says otherwise.
  const swapped = exA(after([{ type: 'swap-exercise', target: { routineId: 'a', exId: BENCH }, after: { id: PRESS } }]));
  assert.deepEqual([swapped[0].id, swapped[0].sets], [PRESS, 3]);
  assert.equal(exA(after([{ type: 'swap-exercise', target: { routineId: 'a', exId: BENCH }, after: { id: PRESS, sets: 5 } }]))[0].sets, 5);
  // Linking moves the partner next to the anchor and tags both.
  const linked = exA(after([{ type: 'superset', target: { routineId: 'a', exId: BENCH }, after: { link: true, with: SITUP } }]));
  assert.deepEqual(linked.map(e => e.id), [BENCH, SITUP, ROW, CURL]);
  assert.ok(linked[0].sg && linked[0].sg === linked[1].sg && linked[0].sg !== linked[2].sg);
  assert.ok(!exA(after([{ type: 'superset', target: { routineId: 'a', exId: ROW }, after: { link: false } }])).some(e => e.sg));
  const reordered = exA(after([{ type: 'reorder', target: { routineId: 'a' }, after: [ROW, BENCH, CURL, SITUP] }]));
  assert.ok(!reordered.some(e => e.sg));

  assert.deepEqual(after([{ type: 'week', target: { weekday: 5 }, after: 'b' }]).week, { 1: ['a'], 3: ['b'], 5: ['b'] });
  assert.deepEqual(after([{ type: 'week', target: { weekday: 1 }, after: 'rest' }]).week, { 3: ['b'] });
  const gone = after([{ type: 'remove-routine', target: { routineId: 'b' } }]);
  assert.deepEqual([gone.routines.length, gone.week], [1, { 1: ['a'] }]);
  const grown = after([{ type: 'add-routine', target: {}, after: { name: 'C', ex: [{ id: DEADLIFT }, { id: SITUP, mode: 'time', sets: 2 }] } }]);
  assert.deepEqual(grown.routines[2].ex.map(e => [e.sets, e.reps ?? e.sec]), [[3, 10], [2, 45]]);
  // Nothing that only changes a target, a policy or a name moves anything.
  for (const c of [{ type: 'reps', after: 12 }, { type: 'repsMin', after: 6 }, { type: 'inc', after: 5 }, { type: 'exercise-prog', after: 'double' }]) {
    assert.deepEqual(planLoad(after([{ target: { routineId: 'a', exId: BENCH }, ...c }])), planLoad(plan));
  }
  assert.equal(JSON.stringify(plan), frozen);
});

test('a review is refused only for what its own changes made worse', () => {
  // Chest at the ceiling, one more set tips it.
  const more = changeLoadErrors(PPL, [change()]);
  assert.equal(more.length, 1);
  assert.match(more[0], /"chest" goes from 20 to 22 work sets a week, over the 20/);
  assert.match(more[0], /principle V2/);
  // The same set taken from somewhere else in the body part pays for it.
  assert.deepEqual(changeLoadErrors(PPL, [change(), change({ id: 'c2', target: { routineId: 'push', exId: FLY }, after: 2 })]), []);
  // A plan its owner already pushed past the ceiling: other changes still go through, and so
  // does one that brings it down without bringing it all the way.
  const heavy = { ...PPL, routines: PPL.routines.map(r => (r.id === 'push' ? { ...r, ex: [...r.ex, x(DIP, 4)] } : r)) };
  assert.equal(planLoad(heavy).weeklySets.chest, 28);
  assert.deepEqual(changeLoadErrors(heavy, [change({ target: { routineId: 'legs', exId: SQUAT }, after: 5 })]), []);
  assert.deepEqual(changeLoadErrors(heavy, [change({ target: { routineId: 'push', exId: DIP }, before: 4, after: 2 })]), []);
  assert.equal(changeLoadErrors(heavy, [change()]).length, 1);
  // Scheduling a routine once more is adding its sets.
  const again = changeLoadErrors(PPL, [{ id: 'c1', type: 'week', target: { weekday: 0 }, after: 'push', why: 'w' }]);
  assert.match(again[0], /"chest" goes from 20 to 30/);
});

test('a review may not lengthen a day past the session, and may shorten one that is already past it', () => {
  // Push is 19 sets, about 48 minutes.
  assert.deepEqual(changeLoadErrors(PPL, [change({ target: { routineId: 'push', exId: RAISE }, before: 3, after: 4 })], { sessionMin: 60 }), []);
  const tight = changeLoadErrors(PPL, [change({ target: { routineId: 'push', exId: RAISE }, before: 3, after: 4 })], { sessionMin: 48 });
  // Both push days, and nothing about chest: the raise is shoulders.
  assert.equal(tight.length, 2);
  assert.match(tight[0], /Monday \("Push"\) goes from about 48 to about 50 minutes/);
  assert.match(tight[0], /over the 48 minutes/);
  assert.match(tight[0], /principle V6/);
  // Already over at 45 minutes: a change elsewhere, a cut, and a superset that buys time all pass.
  const o = { sessionMin: 45 };
  assert.deepEqual(changeLoadErrors(PPL, [change({ type: 'reps', after: 10 })], o), []);
  assert.deepEqual(changeLoadErrors(PPL, [change({ target: { routineId: 'push', exId: FLY }, before: 3, after: 2 })], o), []);
  assert.deepEqual(changeLoadErrors(PPL, [{ id: 'c1', type: 'superset', target: { routineId: 'push', exId: RAISE }, after: { link: true, with: PUSHDOWN }, why: 'w' }], o), []);
  // An added set paid for by a superset in the same session is no longer.
  assert.deepEqual(changeLoadErrors(PPL, [
    change({ target: { routineId: 'push', exId: RAISE }, before: 3, after: 4 }),
    { id: 'c2', type: 'superset', target: { routineId: 'push', exId: RAISE }, after: { link: true, with: PUSHDOWN }, why: 'w' }
  ], { sessionMin: 48 }), []);
  // A new routine is a session of its own.
  const big = { name: 'Everything', ex: [BENCH, ROW, SQUAT, PRESS, CURL, CALF, SITUP].map(id => ({ id, sets: 4, reps: 8 })) };
  const added = changeLoadErrors(PPL, [{ id: 'c1', type: 'add-routine', target: {}, after: big, why: 'w' }], { sessionMin: 60 });
  assert.match(added[0], /routine "Everything" goes from about 0 to about 70 minutes/);
});

test('validateReview sends a change-set over a limit back for repair, and lets the same set through when it fits', () => {
  const answer = changes => ({ coach_contract: 1, summary: 's', changes });
  const r = validateReview(answer([change()]), PPL, { sessionMin: 60 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /"chest" goes from 20 to 22/.test(e)));
  const fits = validateReview(answer([change({ target: { routineId: 'pull', exId: ROW } })]), PPL, { sessionMin: 60 });
  assert.equal(fits.ok, true);
  assert.equal(fits.proposal.changes.length, 1);
  // A change that restates the plan is dropped before the count, so it cannot pay for another.
  const padded = validateReview(answer([change(), change({ id: 'c2', target: { routineId: 'push', exId: FLY }, before: 3, after: 3 })]), PPL);
  assert.equal(padded.ok, false);
  // The person's own exercise counts by the body part the library slice gave for it.
  const own = { routines: [{ id: 'r', name: 'R', ex: [x('mine', 9)] }], week: { 1: ['r'], 4: ['r'] } };
  const custom = customBodyParts([{ id: 'mine', bp: 'chest', custom: true }]);
  const grown = validateReview(answer([change({ target: { routineId: 'r', exId: 'mine' }, before: 9, after: 10 })]), own, { customIds: ['mine'], custom });
  assert.equal(grown.ok, true);
  const tipped = validateReview(answer([change({ target: { routineId: 'r', exId: 'mine' }, before: 9, after: 10 }), { id: 'c2', type: 'add-exercise', target: { routineId: 'r' }, after: { id: BENCH, sets: 1, reps: 8 }, why: 'w' }]), own, { customIds: ['mine'], custom });
  assert.equal(tipped.ok, false);
});

/* ---------------- what the model is given, and the whole loop ---------------- */

const state = (over = {}) => ({
  lang: 'en', unit: 'kg', customEx: [{ id: 'mine', n: 'Sandbag press', bp: 'chest' }],
  routines: [
    { id: 'push', name: 'Push', ex: [{ id: BENCH, sets: 4, reps: 8 }, { id: 'mine', sets: 3, reps: 10 }, { id: BURPEE, sets: 1, min: 10, mode: 'cardio' }] },
    { id: 'legs', name: 'Legs', ex: [{ id: SQUAT, sets: 4, reps: 5 }] }
  ],
  week: { 1: ['push'], 4: ['push', 'legs'] },
  workouts: [], bodyweight: [],
  coach: { consent: { agreedAt: 'x', version: 1 }, profile: { goal: 'muscle', sessionMin: 30, equipment: [] }, log: [] },
  ...over
});

test('a review is handed the plan already counted; no other task is, and an unscheduled plan has no week to count', () => {
  const p = build(state(), { handle: 'h', kind: 'review' });
  assert.deepEqual(p.planLoad, {
    weeklySets: { chest: 14, 'upper legs': 4 },
    days: [
      { weekday: 1, routines: ['push'], sets: 7, minutes: 28 },
      { weekday: 4, routines: ['push', 'legs'], sets: 11, minutes: 38 }
    ]
  });
  for (const kind of ['create', 'debrief', 'digest']) assert.equal(build(state(), { handle: 'h', kind }).planLoad, undefined, kind);
  assert.equal(build(state({ week: {} }), { handle: 'h', kind: 'review' }).planLoad, undefined);
});

test('the pipeline holds an answer to the session length in the payload, and one repair round can fix it', async () => {
  const payload = build(state({ week: { 1: ['push'] } }), { handle: 'h', kind: 'review' });
  const answer = after => JSON.stringify({ coach_contract: 1, summary: 's', changes: [{ id: 'c1', type: 'sets', target: { routineId: 'push', exId: BENCH }, after, why: 'clean for three sessions' }] });
  const prompts = [];
  const adapter = replies => ({ spawns: false, invoke: async ({ prompt }) => { prompts.push(prompt); return { code: 0, text: replies.shift() }; } });
  // 28 minutes now; two more sets is 33, over the 30 they have.
  const fixed = await runPipeline({ adapter: adapter([answer(6), answer(5)]), cfg: {}, kind: 'review', payload });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.result.changes[0].after, 5);
  assert.match(prompts[1], /REPAIR REQUEST/);
  assert.match(prompts[1], /Monday \("Push"\) goes from about 28 to about 33 minutes/);
  const stuck = await runPipeline({ adapter: adapter([answer(6), answer(6)]), cfg: {}, kind: 'review', payload });
  assert.deepEqual([stuck.ok, stuck.errorClass], [false, 'unusable']);
});

test('planLoadForPayload is null without a scheduled day', () => {
  assert.equal(planLoadForPayload({ routines: [{ id: 'a', ex: [x(BENCH, 3)] }], week: {} }), null);
});
