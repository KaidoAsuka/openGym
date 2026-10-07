/* A cycle: the weeks of a plan when they are not all the same week, and the daily look that
   corrects the ones still to come.

   What a week is trained at is arithmetic over a list (core/cycle.js) and is tested as that.
   What the model may write into one — when the plan is made, and after each session — goes
   through the validator, and is tested as the answers that must be turned away and the ones that
   must not. The job half runs through the real queue against a provider on localhost, as the
   weekly note's does. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tempData, writeState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const cyc = await import('../coach/core/cycle.js');
const payload = await import('../coach/core/payload.js');
const { validatePlan, validateAdjust } = await import('../coach/core/validate.js');
const { runPipeline } = await import('../coach/core/pipeline.js');
const { buildPromptParts } = await import('../coach/core/prompt.js');
const { PROMPTS } = await import('../coach/core/prompts.js');
const { SCHEMAS } = await import('../coach/core/schemas.js');
const { dueLook, keep, unfetched, KEPT_MAX } = await import('../coach/adjust.js');
const { queueLook } = await import('../coach/cadence.js');

const SQUAT = '0043', BENCH = '0025', ROW = '0027', FLY = '0308', INCLINE = '0047', HOLD = '0001';
const DAY = 86400000;
const today = new Date().toISOString().slice(0, 10);
const ago = n => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Two squat days that differ, and a bench that only the base knows about.
const ROUTINES = [
  { id: 'a', name: 'Day A', ex: [{ id: SQUAT, sets: 6, reps: 2, mode: 'reps' }] },
  { id: 'b', name: 'Day B', ex: [{ id: SQUAT, sets: 6, reps: 3, mode: 'reps' }, { id: BENCH, sets: 3, reps: 8, mode: 'reps' }, { id: HOLD, sets: 2, sec: 30, mode: 'time' }] }
];
const WEEKS = [
  { week: 1, focus: 'Start at 80.', sessions: [{ routine: 'a', ex: [{ id: SQUAT, weight: 80 }] }, { routine: 'b', ex: [{ id: SQUAT, weight: 80 }] }] },
  { week: 2, focus: 'Fives.', sessions: [{ routine: 'b', ex: [{ id: SQUAT, reps: 5 }] }] },
  { week: 4, focus: 'Heavier.', sessions: [{ routine: 'b', ex: [{ id: SQUAT, sets: 5, reps: 5, weight: 85 }] }] },
  { week: 6, focus: 'Test.' }
];

/* ---------------- what a week is trained at ---------------- */

test('a week stands on the weeks before it, and before any of them on the base', () => {
  const base = cyc.baseOf(ROUTINES);
  const at = n => Object.fromEntries([...cyc.numbersAt(base, WEEKS, n)].map(([rid, m]) => [rid, Object.fromEntries(m)]));
  assert.deepEqual(at(1).b[SQUAT], { sets: 6, reps: 3, weight: 80, set: 1 });
  assert.deepEqual(at(2).b[SQUAT], { sets: 6, reps: 5, weight: 80, set: 2 }, 'only the reps were said; the rest carries');
  assert.deepEqual(at(3).b[SQUAT], at(2).b[SQUAT], 'a week that says nothing is trained as the one before');
  assert.deepEqual(at(4).b[SQUAT], { sets: 5, reps: 5, weight: 85, set: 4 });
  assert.deepEqual(at(6).a[SQUAT], { sets: 6, reps: 2, weight: 80, set: 1 });
  assert.deepEqual(at(6).b[BENCH], { sets: 3, reps: 8 }, 'never mentioned: as the routine held it');
  assert.deepEqual(at(6).b[HOLD], { sets: 2, sec: 30 });
});

test('a plan read at a week is a copy with that week\'s numbers; the plan given is not touched', () => {
  const plan = { routines: ROUTINES, week: { 1: ['a'], 3: ['b'] } };
  const w4 = cyc.planAt(plan, cyc.baseOf(ROUTINES), WEEKS, 4);
  assert.deepEqual(w4.routines[1].ex[0], { id: SQUAT, sets: 5, reps: 5, mode: 'reps', weight: 85 });
  assert.deepEqual(ROUTINES[1].ex[0], { id: SQUAT, sets: 6, reps: 3, mode: 'reps' });
  assert.equal(w4.week, plan.week);
});

test('which week it is: whole weeks from the day it began', () => {
  assert.equal(cyc.cycleWeekOn('2026-10-05', '2026-10-05'), 1);
  assert.equal(cyc.cycleWeekOn('2026-10-05', '2026-10-11'), 1);
  assert.equal(cyc.cycleWeekOn('2026-10-05', '2026-10-12'), 2);
  assert.equal(cyc.cycleWeekOn('2026-10-05', '2026-11-16'), 7, 'past the last week it keeps counting; the caller knows how long the cycle is');
  for (const [a, b] of [['2026-10-05', '2026-10-04'], ['soon', '2026-10-05'], [null, null]]) assert.equal(cyc.cycleWeekOn(a, b), null);
});

/* ---------------- reading the weeks someone wrote ---------------- */

test('the weeks are read by name, sorted, and a week of intent alone is kept', () => {
  const { plan, errors } = cyc.cleanCyclePlan([WEEKS[2], WEEKS[0], { ...WEEKS[3], extra: 'x'.repeat(5000) }, { week: 5, focus: 'f'.repeat(900) }, { week: 3 }], ROUTINES, 6);
  assert.deepEqual(errors, []);
  assert.deepEqual(plan.map(w => w.week), [1, 4, 5, 6], 'a week that says nothing at all is not a week');
  assert.deepEqual(plan[3], { week: 6, focus: 'Test.' });
  assert.equal(plan[2].focus.length, cyc.CYCLE_FOCUS_MAX);
  assert.deepEqual(plan[1].sessions, [{ routine: 'b', ex: [{ id: SQUAT, sets: 5, reps: 5, weight: 85 }] }]);
});

test('what a week may not say, each with a line the repair round can act on', () => {
  const bad = (week, why) => {
    const { errors } = cyc.cleanCyclePlan([week], ROUTINES, 6);
    assert.match(errors.join('\n'), why, JSON.stringify(week));
  };
  const s = ex => ({ week: 2, sessions: [{ routine: 'b', ex: [ex] }] });
  bad({ week: 7, focus: 'x' }, /must be a week of this cycle, 1 to 6/);
  bad({ week: 2, sessions: [{ routine: 'nope', ex: [] }] }, /is not one of the routines of this plan \("a", "b"\)/);
  bad(s({ id: ROW, sets: 3 }), /is not an exercise of routine "b"/);
  bad(s({ id: SQUAT, sets: 0 }), /sets must be a whole number of sets/);
  bad(s({ id: SQUAT, reps: 2.5 }), /reps must be a whole number of reps/);
  bad(s({ id: SQUAT, weight: -5 }), /weight must be a positive number/);
  bad(s({ id: SQUAT, weight: 5000 }), /no larger than 1000/);
  bad(s({ id: SQUAT, weight: '80' }), /weight must be a positive number/);
  bad(s({ id: HOLD, reps: 10 }), /logged by time \(use "sec"\)/);
  bad(s({ id: SQUAT, sec: 30 }), /not a timed hold/);
  const twice = cyc.cleanCyclePlan([WEEKS[1], WEEKS[1]], ROUTINES, 6);
  assert.match(twice.errors[0], /week 2 is listed twice/);
  const side = cyc.cleanCyclePlan([{ week: 1, sessions: [{ routine: 'r', ex: [{ id: SQUAT, reps: 15 }] }] }], [{ id: 'r', ex: [{ id: SQUAT, side: true }] }], 2);
  assert.match(side.errors[0], /per-side exercise/);
  // A quarter-kilo plate is a plate; a third decimal is not.
  assert.equal(cyc.cleanCyclePlan([s({ id: SQUAT, weight: 82.126 })], ROUTINES, 6).plan[0].sessions[0].ex[0].weight, 82.13);
});

test('changes are laid into the weeks as a copy, making the week and the session they need', () => {
  const next = cyc.withChanges(WEEKS, [{ week: 3, routine: 'a', exId: SQUAT, weight: 82.5, why: 'w' }, { week: 2, routine: 'b', exId: SQUAT, reps: 4 }], [{ week: 5, focus: 'Hold.' }]);
  assert.deepEqual(next.map(w => w.week), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(next[2], { week: 3, sessions: [{ routine: 'a', ex: [{ id: SQUAT, weight: 82.5 }] }] }, 'the reason is not a number');
  assert.equal(next[1].sessions[0].ex[0].reps, 4);
  assert.equal(next[4].focus, 'Hold.');
  assert.equal(WEEKS[1].sessions[0].ex[0].reps, 5, 'the weeks given are as they were');
});

/* ---------------- a new plan that carries a cycle ---------------- */

const PLAN = {
  coach_contract: 1, name: 'Russian squat', summary: 's', basedOn: 'b',
  block: { weeks: 6, outline: 'Six weeks.' },
  routines: ROUTINES.map(r => ({ ...r, ex: r.ex.map(e => ({ ...e })) })),
  week: { 1: 'a', 3: 'b', 5: 'a' },
  cycle: WEEKS
};

test('a plan may carry its weeks; they run as long as its block', () => {
  const r = validatePlan(PLAN, { sessionMin: 60 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.bundle.cycle.weeks, 6);
  assert.deepEqual(r.bundle.cycle.plan.map(w => w.week), [1, 2, 4, 6]);
  // Without a block the cycle is as long as its last week.
  const { block, ...loose } = PLAN;
  assert.equal(validatePlan(loose, {}).bundle.cycle.weeks, 6);
  // A plan that says nothing about weeks has none, and the bundle is what it always was.
  const { cycle, ...flat } = PLAN;
  assert.equal('cycle' in validatePlan(flat, {}).bundle, false);
  assert.equal('cycle' in validatePlan({ ...PLAN, cycle: [] }, {}).bundle, false);
});

test('a revision hands its weeks back in the shape it was given them', () => {
  const first = validatePlan(PLAN, {}).bundle;
  const again = validatePlan({ ...PLAN, cycle: first.cycle }, {});
  assert.equal(again.ok, true);
  assert.deepEqual(again.bundle.cycle, first.cycle);
});

test('a weight the cycle sets is taken as written; one on the routine itself is still brought down', () => {
  const heavy = { ...PLAN, routines: PLAN.routines.map(r => ({ ...r, ex: r.ex.map(e => (e.id === SQUAT ? { ...e, weight: 150 } : e)) })) };
  const r = validatePlan(heavy, { workingWeights: [{ id: SQUAT, best: 80 }] });
  assert.equal(r.bundle.routines[0].ex[0].weight, 80, 'the routine\'s own starting weight: never above their best');
  assert.equal(r.bundle.cycle.plan[2].sessions[0].ex[0].weight, 85, 'week four of a cycle is past their best on purpose');
});

test('the weeks are held to the two counted limits, each breach said once for its worst week', () => {
  const big = [x => 6, x => 8, x => 10].map((f, i) => ({ week: i + 2, sessions: [{ routine: 'c', ex: [{ id: BENCH, sets: f() }, { id: INCLINE, sets: f() }, { id: FLY, sets: f() }] }] }));
  const plan = { ...PLAN, routines: [{ id: 'c', name: 'Chest', ex: [{ id: BENCH, sets: 4, reps: 8 }, { id: INCLINE, sets: 4, reps: 8 }, { id: FLY, sets: 4, reps: 8 }] }], week: { 1: 'c' }, cycle: big };
  const r = validatePlan(plan, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, r.errors.join('\n'));
  assert.match(r.errors[0], /^in week 4 of the cycle \(and in week 3\), the plan gives "chest" 30 work sets a week, over the 20/);
  // Their own plan is told, not refused — and the weeks are kept.
  const own = validatePlan(plan, { ownPlan: true });
  assert.equal(own.ok, true);
  assert.equal(own.bundle.cycle.plan.length, 3);
  // A cycle that cannot be read goes back for repair with the plan's other errors.
  const broken = validatePlan({ ...PLAN, cycle: [{ week: 9, focus: 'x' }, { week: 1, sessions: [{ routine: 'zz', ex: [] }] }] }, {});
  assert.equal(broken.ok, false);
  assert.equal(broken.errors.length, 2);
});

/* ---------------- the daily look ---------------- */

const context = (over = {}) => ({ weeks: 6, week: 2, base: cyc.baseOf(ROUTINES), plan: WEEKS, routines: ROUTINES, schedule: { 1: ['a'], 3: ['b'], 5: ['a'] }, ...over });
const look = (changes, over = {}) => validateAdjust({ coach_contract: 1, summary: 'Missed the fives; one step back.', changes, ...over }, { cycle: context(), sessionMin: 60 });
const change = (over = {}) => ({ week: 3, routine: 'b', exId: SQUAT, weight: 77.5, why: 'Two of six sets missed at 80.', ...over });

test('a look may move the numbers of weeks still to come', () => {
  const r = look([change(), change({ week: 2, routine: 'a', sets: 5, weight: undefined, why: 'Short on time twice.' })], { weeks: [{ week: 3, focus: 'A step back.' }], notes: ['The bench has not been trained for two weeks.', '  '] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.proposal.changes, [
    { week: 3, routine: 'b', exId: SQUAT, weight: 77.5, why: 'Two of six sets missed at 80.' },
    { week: 2, routine: 'a', exId: SQUAT, sets: 5, why: 'Short on time twice.' }
  ]);
  assert.deepEqual(r.proposal.focus, [{ week: 3, focus: 'A step back.' }]);
  assert.deepEqual(r.proposal.notes, ['The bench has not been trained for two weeks.']);
  assert.deepEqual(Object.keys(r.proposal), ['summary', 'changes', 'focus', 'notes']);
});

test('"nothing to change" is an answer, and so is a set of changes that changes nothing', () => {
  const none = validateAdjust({ coach_contract: 1, nochange: true, reading: 'Made every set; the plan stands.' }, { cycle: context() });
  assert.deepEqual(none, { ok: true, nochange: true, reading: 'Made every set; the plan stands.' });
  // Week three trains the squat at 6x5 at 80 already.
  const same = look([change({ weight: 80, reps: 5 })]);
  assert.equal(same.nochange, true);
  assert.equal(validateAdjust({ coach_contract: 1, changes: [] }, { cycle: context() }).nochange, true);
});

test('what a look may not do', () => {
  const bad = (c, why, over) => {
    const r = look([c], over);
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.match(r.errors.join('\n'), why);
  };
  bad(change({ week: 1 }), /still to come or under way, 2 to 6 — earlier weeks have been trained/);
  bad(change({ week: 7 }), /2 to 6/);
  bad(change({ routine: 'z' }), /is not one of the cycle's routines/);
  bad(change({ exId: ROW }), /is not an exercise of routine "b"/);
  bad(change({ why: '' }), /why is required/);
  bad({ week: 3, routine: 'b', exId: SQUAT, why: 'because' }, /sets nothing/);
  bad(change({ weight: 0 }), /positive number/);
  bad(change({ exId: HOLD, reps: 12, weight: undefined }), /logged by time/);
  const twice = look([change(), change({ weight: 75 })]);
  assert.match(twice.errors[0], /same exercise in the same week/);
  assert.match(validateAdjust({ coach_contract: 1, changes: [change()] }, { cycle: context() }).errors[0], /summary is required/);
  assert.match(validateAdjust({ coach_contract: 1, changes: 'x' }, { cycle: context() }).errors[0], /changes must be an array/);
  assert.match(validateAdjust({ coach_contract: 1, nochange: true }, {}).errors[0], /no cycle is running/);
  // Anything that is not a number of an exercise the cycle holds has nowhere to go.
  const smuggled = look([change({ type: 'swap-exercise', after: { id: ROW }, target: { routineId: 'b' } })]);
  assert.deepEqual(Object.keys(smuggled.proposal.changes[0]), ['week', 'routine', 'exId', 'weight', 'why']);
});

test('a look is refused only for what it made worse', () => {
  const chest = [{ id: 'c', name: 'Chest', ex: [{ id: BENCH, sets: 8, reps: 8, mode: 'reps' }, { id: INCLINE, sets: 8, reps: 8, mode: 'reps' }, { id: FLY, sets: 4, reps: 8, mode: 'reps' }] }];
  const ctx = { cycle: { weeks: 4, week: 1, base: cyc.baseOf(chest), plan: [], routines: chest, schedule: { 1: ['c'] } }, sessionMin: 120 };
  const ask = c => validateAdjust({ coach_contract: 1, summary: 's', changes: [c] }, ctx);
  const more = ask({ week: 2, routine: 'c', exId: FLY, sets: 6, why: 'w' });
  assert.equal(more.ok, false);
  assert.match(more.errors[0], /^in week 2 of the cycle, the plan gives "chest" 22 work sets a week, over the 20/);
  // Already at twenty: a weight moves no count, and fewer sets is always allowed.
  assert.equal(ask({ week: 2, routine: 'c', exId: BENCH, weight: 60, why: 'w' }).ok, true);
  assert.equal(ask({ week: 2, routine: 'c', exId: BENCH, sets: 6, why: 'w' }).ok, true);
  // A cycle its owner already took past the limit can still be corrected downward or sideways.
  const over = { ...ctx, cycle: { ...ctx.cycle, base: cyc.baseOf([{ ...chest[0], ex: chest[0].ex.map(e => ({ ...e, sets: 10 })) }]) } };
  assert.equal(validateAdjust({ coach_contract: 1, summary: 's', changes: [{ week: 2, routine: 'c', exId: FLY, sets: 9, why: 'w' }] }, over).ok, true);
  // Their own plan is theirs.
  assert.equal(validateAdjust({ coach_contract: 1, summary: 's', changes: [{ week: 2, routine: 'c', exId: FLY, sets: 6, why: 'w' }] }, { ...ctx, ownPlan: true }).ok, true);
});

/* ---------------- what the model is handed ---------------- */

const squats = (d, sets, id = 'w' + d) => ({
  id, d, name: 'Day B', start: Date.parse(d + 'T10:00:00Z'), end: Date.parse(d + 'T10:50:00Z'), prs: [], routineIds: ['b'],
  entries: [{ id: SQUAT, target: { sets: 6, reps: 5, weight: 80 }, sets }]
});
const made = n => [...Array(n)].map(() => ({ w: 80, r: 5, done: true, rir: 1 }));
const state = (over = {}) => ({
  lang: 'en', unit: 'kg', effort: 'rir', customEx: [], bodyweight: [],
  routines: ROUTINES.map(r => ({ ...r, ex: r.ex.map(e => ({ ...e })) })),
  week: { 1: ['a'], 3: ['b'], 5: ['a'] },
  workouts: [squats(ago(9), [{ w: 80, r: 3, done: true }, { w: 20, r: 10, done: true, warmup: true }]), squats(ago(1), [...made(4), { w: 80, r: 3, done: true, rir: 0 }, { w: 80, r: 2, done: true, rir: 0 }])],
  coach: {
    consent: { agreedAt: 'x', version: 1 }, log: [],
    profile: { goal: 'strength', experience: 'regular', daysPerWeek: 3, sessionMin: 60, equipment: [] },
    cycle: {
      id: 'p1', name: 'Russian squat', startedAt: ago(8), weeks: 6, program: { id: 'russian-squat-routine', name: 'Russian Squat Routine' },
      routines: ['a', 'b', 'gone'], base: cyc.baseOf(ROUTINES), plan: WEEKS, applied: [], lastCheck: { at: Date.now() - 2 * DAY, reading: 'Fine so far.' },
      history: [{ id: 'h1', at: Date.now() - 3 * DAY, summary: 'One step back.', changes: [{}, {}], undone: true, prev: 'x'.repeat(9000) }]
    }
  },
  ...over
});

test('what each lift is at is counted from the log, loaded work sets only', () => {
  const p = payload.build(state(), { handle: 'h'.repeat(16), kind: 'adjust' });
  assert.deepEqual(p.lifts, [{ id: SQUAT, name: 'barbell full squat', sessions: 2, e1rm: 93.5, best: { d: ago(1), set: '80x5@RIR1' }, last: { d: ago(1), sets: ['80x5@RIR1', '80x5@RIR1', '80x5@RIR1', '80x5@RIR1', '80x3@RIR0', '80x2@RIR0'] } }]);
  // A plan request is handed the same, for every lift on record.
  const create = payload.build(state(), { handle: 'h'.repeat(16), kind: 'create' });
  assert.equal(create.lifts[0].e1rm, 93.5);
  assert.equal(payload.build(state({ workouts: [] }), { handle: 'h'.repeat(16), kind: 'create' }).lifts, undefined);
});

test('a daily look is handed the weeks still to come, each exercise at that week\'s numbers', () => {
  const p = payload.build(state(), { handle: 'h'.repeat(16), kind: 'adjust' });
  assert.equal(p.task, 'adjust');
  const { plan, ...head } = p.cycle;
  assert.deepEqual(head, {
    name: 'Russian squat', weeks: 6, week: 2, startedAt: ago(8), program: 'Russian Squat Routine',
    routines: [{ id: 'a', name: 'Day A', weekdays: [1, 5] }, { id: 'b', name: 'Day B', weekdays: [3] }],
    adjusted: [{ on: ago(3), summary: 'One step back.', changes: 2, undone: true }],
    lastCheck: { on: ago(2), reading: 'Fine so far.' }
  });
  assert.deepEqual(plan.map(w => w.week), [2, 3, 4, 5, 6], 'from this week on; week one has been trained');
  assert.equal(plan[0].focus, 'Fives.');
  assert.deepEqual(plan[0].sessions[1].ex[0], { id: SQUAT, name: 'barbell full squat', sets: 6, reps: 5, weight: 80, set: 2 });
  assert.deepEqual(plan[1].sessions[1].ex[0], plan[0].sessions[1].ex[0], 'week three says nothing, so it carries');
  assert.deepEqual(plan[2].sessions[1].ex[0], { id: SQUAT, name: 'barbell full squat', sets: 5, reps: 5, weight: 85, set: 4 });
  assert.deepEqual(plan[0].sessions[1].ex[1], { id: BENCH, name: 'barbell bench press', sets: 3, reps: 8 }, 'no `set`: as the routine held it');
  // The programme it follows travels as an entry, so a weight can be held against its rule.
  assert.equal(p.program.id, 'russian-squat-routine');
  assert.match(p.program.structure, /80 %/);
  assert.equal(p.library, undefined, 'a look names nothing new');
  assert.equal(p.window.workouts.length, 2);
  assert.ok(!JSON.stringify(p).includes('x'.repeat(100)), 'what the phone keeps for undo does not travel');
});

test('a review is told a cycle runs, in short; a plan with none carries nothing', () => {
  const p = payload.build(state(), { handle: 'h'.repeat(16), kind: 'review' });
  assert.deepEqual(p.cycle, {
    name: 'Russian squat', weeks: 6, week: 2, startedAt: ago(8), program: 'Russian Squat Routine', routines: ['a', 'b'],
    focus: [{ week: 1, focus: 'Start at 80.' }, { week: 2, focus: 'Fives.' }, { week: 4, focus: 'Heavier.' }, { week: 6, focus: 'Test.' }]
  });
  const none = state(); none.coach.cycle = null;
  assert.equal(payload.build(none, { handle: 'h'.repeat(16), kind: 'review' }).cycle, undefined);
  assert.equal(payload.build(none, { handle: 'h'.repeat(16), kind: 'adjust' }).cycle, null);
  assert.equal(payload.cycleContext(none), null);
});

test('a cycle past its last week says so, and one that is not a cycle reads as none', () => {
  const late = state(); late.coach.cycle.startedAt = ago(50);
  const p = payload.build(late, { handle: 'h'.repeat(16), kind: 'adjust' });
  assert.deepEqual([p.cycle.week, p.cycle.over], [6, true]);
  for (const bad of ['yes', 7, [], { weeks: 6 }, { startedAt: today, weeks: 0, routines: ['a'] }, { startedAt: 'soon', weeks: 6, routines: ['a'] }, { startedAt: today, weeks: 6, routines: ['nowhere'] }]) {
    const S = state(); S.coach.cycle = bad;
    assert.equal(payload.cycleContext(S), null, JSON.stringify(bad));
  }
  // Megabytes in it stay where they are.
  const fat = state(); fat.coach.cycle.name = 'n'.repeat(100000); fat.coach.cycle.plan = [...WEEKS, { week: 5, focus: 'f'.repeat(100000) }];
  assert.ok(JSON.stringify(payload.build(fat, { handle: 'h'.repeat(16), kind: 'adjust' }).cycle).length < 6000);
});

test('the check a look is held to knows the week and the routines as they are now', () => {
  const c = payload.cycleContext(state());
  assert.deepEqual([c.weeks, c.week, c.routines.map(r => r.id)], [6, 2, ['a', 'b']]);
  assert.deepEqual(c.schedule, { 1: ['a'], 3: ['b'], 5: ['a'] });
  assert.deepEqual(c.base.b[BENCH], { sets: 3, reps: 8 });
});

/* ---------------- the whole loop ---------------- */

test('the pipeline checks a look against the cycle, and one repair round can fix it', async () => {
  const S = state();
  const p = payload.build(S, { handle: 'h'.repeat(16), kind: 'adjust' });
  const prompts = [];
  const replies = [{ coach_contract: 1, summary: 's', changes: [change({ week: 1 })] }, { coach_contract: 1, summary: 'A step back after two missed sets.', changes: [change()] }];
  const adapter = { spawns: false, invoke: async ({ prompt, system, schema }) => { prompts.push({ prompt, system, schema }); return { code: 0, text: JSON.stringify(replies.shift()) }; } };
  const r = await runPipeline({ adapter, cfg: {}, kind: 'adjust', payload: p, cycle: payload.cycleContext(S) });
  assert.equal(r.ok, true);
  assert.equal(r.result.changes[0].weight, 77.5);
  assert.match(prompts[1].prompt, /earlier weeks have been trained/);
  assert.equal(prompts[0].system, PROMPTS.common + '\n\n---\n\n' + PROMPTS.principles + '\n\n---\n\n' + PROMPTS.adjust);
  assert.equal(prompts[0].schema, SCHEMAS.adjust);
  assert.equal(buildPromptParts('adjust', p, null).task, 'adjust');
});

test('the prompts say what the code does about loads', () => {
  assert.match(PROMPTS.common, /\*\*A load is set in one place at a time\.\*\*/);
  assert.match(PROMPTS.principles, /## W — the weights of a cycle/);
  assert.match(PROMPTS.principles, /`e1rm` ÷ \(1 \+ \(reps \+ RIR\) ÷ 30\)/);
  assert.match(PROMPTS.create, /A lift with no record in `lifts` gets no `weight`/);
  assert.match(PROMPTS.adjust, /You cannot add, remove or swap an exercise, or move a day/);
  assert.match(PROMPTS.adjust, /take effect without being approved/);
  assert.match(PROMPTS.review, /A running cycle owns its numbers/);
  assert.match(PROMPTS.refine, /refine\.previous\.cycle\.plan/);
});

/* ---------------- when a look is due, and who holds it ---------------- */

test('a look is due once for each session of the cycle that comes in', () => {
  const S = state();
  const key = dueLook(S, {}, today);
  assert.ok(key && key.startsWith('w' + ago(1) + ':'));
  assert.equal(dueLook(S, { adjustSeen: key }, today), null, 'looked at once, whatever became of the job');
  const more = state({ workouts: [...S.workouts, squats(today, made(6))] });
  assert.notEqual(dueLook(more, { adjustSeen: key }, today), null, 'a new session is a new look');
  // Nothing to look at: no cycle, nothing trained since it began, a session still open.
  const none = state(); none.coach.cycle = null;
  assert.equal(dueLook(none, {}, today), null);
  assert.equal(dueLook(state({ workouts: [squats(ago(20), made(6))] }), {}, today), null);
  assert.equal(dueLook(state({ workouts: [{ ...squats(today, made(6)), end: null }] }), {}, today), null);
  // A week past its end it is still read, to be told it is over; after that it is history.
  const ended = n => { const x = state(); x.coach.cycle.startedAt = ago(n); x.workouts = [squats(ago(1), made(6))]; return x; };
  assert.notEqual(dueLook(ended(6 * 7 + 3), {}, today), null);
  assert.equal(dueLook(ended(7 * 7 + 3), {}, today), null);
});

test('looks are held in order, and let go once the phone applied them', () => {
  const a = n => ({ id: 'l' + n, cycle: 'p1', at: n });
  let held = [];
  for (let i = 0; i < KEPT_MAX + 3; i++) held = keep(held, a(i));
  assert.equal(held.length, KEPT_MAX);
  assert.equal(held.at(-1).id, 'l' + (KEPT_MAX + 2));
  assert.equal(keep(held, a(KEPT_MAX + 2)).length, KEPT_MAX, 'the same look twice is one look');
  const S = state(); S.coach.cycle.applied = ['l5', 'l6'];
  assert.deepEqual(unfetched([a(5), a(6), a(7)], S).map(x => x.id), ['l7']);
  assert.deepEqual(unfetched([{ ...a(8), cycle: 'another' }], S), [], 'a look made for a cycle that was replaced has nowhere to go');
  const none = state(); none.coach.cycle = null;
  assert.deepEqual(unfetched([a(1)], none), []);
});

/* ---------------- the job ---------------- */

async function provider(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const sent = JSON.parse(body || '{}');
      const m = /```json\n([\s\S]*?)\n```/.exec(sent.messages?.at(-1)?.content || '');
      const p = m ? JSON.parse(m[1]) : {};
      seen.push(p);
      const out = reply(p);
      if (out === null) { res.statusCode = 404; return res.end('{"error":"nothing here"}'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(out) } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  cfg.save({ enabled: true, provider: 'compatible', providerOptions: { compatible: { baseUrl: `http://127.0.0.1:${server.address().port}` } }, models: { compatible: 'local-model' } });
  return { seen, close: () => { server.close(); server.closeAllConnections(); } };
}
async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!jobs.status(uid).job) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}
const deps = { userNow: () => ({ date: today }) };
const LOOK = { coach_contract: 1, summary: 'Two of six sets missed at 80; next week holds at 77.5.', changes: [change()] };

test('a session of the cycle is looked at once, the answer held for the phone and let go when it is applied', async () => {
  const p = await provider(sent => (sent.task === 'adjust' ? LOOK : { coach_contract: 1, nochange: true, reading: 'Steady.' }));
  const notified = [];
  jobs.setProposalHook(uid => notified.push(uid));
  try {
    const uid = 'u-cycle';
    const S = state({ reminder: { tz: 'UTC' } });
    writeState(DIR, uid, S);
    // A proposal nobody has answered: the look neither waits for it nor replaces it.
    fs.mkdirSync(path.join(DIR, 'coach'), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'coach', uid + '.json'), JSON.stringify({ pending: { id: 'p9', kind: 'review', expiresAt: Date.now() + DAY, changes: [] } }));

    assert.equal(queueLook(uid, S, deps), true);
    assert.equal(jobs.status(uid).job.kind, 'adjust');
    await settle(uid);
    assert.equal(queueLook(uid, S, deps), false, 'the same session is not looked at twice');
    assert.equal(p.seen.length, 1);
    assert.deepEqual([p.seen[0].task, p.seen[0].cycle.week], ['adjust', 2]);

    const rec = jobs.readUser(uid);
    assert.equal(rec.adjustments.length, 1);
    const { id, at, ...kept } = rec.adjustments[0];
    assert.ok(id && at > Date.now() - 60000);
    assert.deepEqual(kept, { cycle: 'p1', week: 2, summary: LOOK.summary, changes: [{ week: 3, routine: 'b', exId: SQUAT, weight: 77.5, why: 'Two of six sets missed at 80.' }] });
    assert.equal(rec.pending.id, 'p9', 'the proposal is still waiting');
    assert.deepEqual(notified, [], 'and nobody is notified: it takes effect by itself');
    assert.deepEqual([rec.history.at(-1).kind, rec.history.at(-1).outcome], ['adjust', 'kept']);

    const st = jobs.status(uid);
    assert.equal(st.adjustments.length, 1, 'the poll hands it over');
    assert.equal(st.last, null, 'and does not report it as the answer to anything');

    // The phone applies it and syncs; the next tick stops holding it.
    const synced = { ...S, coach: { ...S.coach, cycle: { ...S.coach.cycle, applied: [id] } } };
    writeState(DIR, uid, synced);
    assert.equal(queueLook(uid, synced, deps), false);
    assert.deepEqual(jobs.readUser(uid).adjustments, []);
    assert.equal('adjustments' in jobs.status(uid), false);

    // The next session is a new look. Asked for by hand, "nothing to change" is kept and marked.
    p.seen.length = 0;
    const next = { ...synced, workouts: [...synced.workouts, squats(today, made(6))] };
    writeState(DIR, uid, next);
    jobs.enqueue(uid, { kind: 'adjust', trigger: 'manual' });
    await settle(uid);
    const asked = jobs.readUser(uid).adjustments.at(-1);
    assert.equal(asked.manual, true);
    assert.equal(p.seen[0].window.workouts.length, 3);
  } finally {
    jobs.setProposalHook(null);
    p.close();
  }
});

test('"the plan stands" is kept as what the Coach said; a look with no cycle fails quietly', async () => {
  const p = await provider(() => ({ coach_contract: 1, nochange: true, reading: 'Every set made; the plan stands.' }));
  try {
    const uid = 'u-stands';
    const S = state({ reminder: { tz: 'UTC' } });
    writeState(DIR, uid, S);
    assert.equal(queueLook(uid, S, deps), true);
    await settle(uid);
    const rec = jobs.readUser(uid);
    assert.deepEqual({ nochange: rec.adjustments[0].nochange, reading: rec.adjustments[0].reading, cycle: rec.adjustments[0].cycle }, { nochange: true, reading: 'Every set made; the plan stands.', cycle: 'p1' });
    assert.equal(rec.history.at(-1).outcome, 'nochange');

    const bare = 'u-bare';
    const none = state(); none.coach.cycle = null;
    writeState(DIR, bare, none);
    assert.equal(queueLook(bare, none, deps), false, 'nothing is queued where no cycle runs');
    jobs.enqueue(bare, { kind: 'adjust', trigger: 'manual' });
    await settle(bare);
    const failed = jobs.readUser(bare).history.at(-1);
    assert.deepEqual([failed.outcome, failed.errorClass], ['failed', 'nocycle']);
    assert.equal(jobs.status(bare).last.errorClass, 'nocycle', 'asked for by hand, the failure is said');
    assert.equal(p.seen.length, 1, 'and no provider was called for it');
  } finally { p.close(); }
});
