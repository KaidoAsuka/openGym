/* What a new plan says it rests on, and what the app says about a plan someone brought.
 *
 * Two things the validator decides beside the plan itself. The programme a plan names has to be
 * one the job was handed, because the card puts the catalogue's name and link under it. And a
 * plan the person wrote themselves is not refused over the two counted limits: the counts go on
 * the bundle as notes, for the card to word. Both are written here as the answers that must be
 * turned away and the ones that must not be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { validatePlan } = await import('../coach/core/validate.js');
const {
  planLoadFindings, findingErrors, advisoriesOf, planLoadErrors, isHardFinding,
  WEEKLY_SETS_MAX, WEEKLY_SETS_MIN, SESSION_SETS_MAX, ADVISORIES_MAX
} = await import('../coach/core/plan-load.js');
const { build } = await import('../coach/core/payload.js');
const { runPipeline } = await import('../coach/core/pipeline.js');
const { PROMPTS } = await import('../coach/core/prompts.js');

const BENCH = '0025', INCLINE = '0047', FLY = '0308';   // chest
const SQUAT = '0043', ROW = '0027', CALF = '0594';      // upper legs, back, lower legs
const x = (id, sets, over = {}) => ({ id, sets, mode: 'reps', reps: 8, ...over });

// Two days, everything inside every range: nothing to say about it.
const SOUND = {
  coach_contract: 1, name: 'Two days', summary: 's', basedOn: 'b',
  routines: [
    { id: 'a', name: 'Upper', ex: [x(BENCH, 4), x(ROW, 4)] },
    { id: 'b', name: 'Lower', ex: [x(SQUAT, 4), x(CALF, 4)] }
  ],
  week: { 1: 'a', 4: 'b' }
};
// The plan somebody brings: a chest day twice a week at 24 sets a session.
const CHEST = {
  ...SOUND,
  routines: [{ id: 'a', name: 'Chest', ex: [x(BENCH, 10), x(INCLINE, 8), x(FLY, 6), x(CALF, 1)] }],
  week: { 1: 'a', 4: 'a' }
};

/* ---------------- the programme a plan names ---------------- */

test('a plan may name a programme it was handed, and the card reads the catalogue, not the answer', () => {
  const r = validatePlan({ ...SOUND, program: 'phul' }, { programIds: ['phul', 'lyle-generic-bulking'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bundle.program, { id: 'phul', name: 'PHUL', author: 'Brandon Campbell', source: 'https://www.liftosaur.com/programs/phul' });
  // A revision is handed its previous plan, where `program` is that card object.
  const again = validatePlan({ ...SOUND, program: { id: 'phul', name: 'Something else', source: 'https://evil.example/' } }, { programIds: ['phul'] });
  assert.equal(again.bundle.program.name, 'PHUL');
  assert.equal(again.bundle.program.source, 'https://www.liftosaur.com/programs/phul');
});

test('a programme the job was not handed is an error the repair round can act on', () => {
  for (const program of ['531-original', 'made-up', 42, { id: 'smolov' }, ['phul']]) {
    const r = validatePlan({ ...SOUND, program }, { programIds: ['phul', 'gzclp'] });
    assert.equal(r.ok, false, JSON.stringify(program));
    assert.match(r.errors.join('\n'), /is not one of the programmes in this payload \("phul", "gzclp"\)/);
  }
  const none = validatePlan({ ...SOUND, program: 'phul' }, {});
  assert.match(none.errors.join('\n'), /it holds none/);
  // The real id of a real programme is still refused when it was only mentioned as unavailable.
  assert.equal(validatePlan({ ...SOUND, program: 'nsuns-531-lp' }, { programIds: ['phul'] }).ok, false);
});

test('a plan that names nothing carries nothing: no program, no notes, the bundle as it always was', () => {
  for (const program of [undefined, null, '']) {
    const r = validatePlan({ ...SOUND, program }, { programIds: ['phul'] });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.bundle), ['opengym_plan', 'name', 'summary', 'basedOn', 'week', 'routines', 'customEx']);
  }
});

/* ---------------- the counts, as facts ---------------- */

test('the four findings, each with its numbers and nothing worded', () => {
  const plan = { routines: CHEST.routines, week: { 1: ['a'], 4: ['a'] } };
  const f = planLoadFindings(plan, { sessionMin: 45 });
  assert.deepEqual(f.map(a => a.code), ['weekly-over', 'session-over', 'session-over', 'weekly-under', 'session-part-over', 'session-part-over']);
  assert.deepEqual(f.filter(isHardFinding).map(a => a.code), ['weekly-over', 'session-over', 'session-over']);
  assert.deepEqual(advisoriesOf(plan, f), [
    { code: 'weekly-over', bp: 'chest', sets: 48, max: 20 },
    { code: 'session-over', routine: 'Chest', sets: 25, minutes: 63, cap: 45, weekdays: [1, 4] },
    { code: 'weekly-under', bp: 'lower legs', sets: 2, min: WEEKLY_SETS_MIN },
    { code: 'session-part-over', bp: 'chest', routine: 'Chest', sets: 24, max: SESSION_SETS_MAX.chest, weekdays: [1, 4] }
  ]);
  // The repair round still reads the two hard ones as the sentences it always read.
  assert.deepEqual(findingErrors(plan, f), planLoadErrors(plan, { sessionMin: 45 }));
  assert.equal(planLoadErrors(plan, { sessionMin: 45 }).length, 3);
});

test('the per-session share is half the weekly ceiling, and a body part left out is not "under"', () => {
  for (const [bp, max] of Object.entries(WEEKLY_SETS_MAX)) assert.equal(SESSION_SETS_MAX[bp], max / 2, bp);
  const f = planLoadFindings({ routines: SOUND.routines, week: { 1: ['a'], 4: ['b'] } }, { sessionMin: 60 });
  assert.deepEqual(f, [], 'four sets each, and chest, back, legs and calves are all it trains');
  // A routine no day schedules is a session someone can start, by name alone.
  const loose = { routines: CHEST.routines, week: {} };
  assert.deepEqual(advisoriesOf(loose, planLoadFindings(loose, {})), [{ code: 'session-part-over', bp: 'chest', routine: 'Chest', sets: 24, max: 10 }]);
});

test('a card is handed a bounded list, with a routine name cut like any other', () => {
  const routines = [...Array(7)].map((_, i) => ({ id: 'r' + i, name: 'N'.repeat(300) + i, ex: [x(BENCH, 10), x(INCLINE, 10), x(FLY, 10)] }));
  const plan = { routines, week: Object.fromEntries(routines.map((r, i) => [i, [r.id]])) };
  const notes = advisoriesOf(plan, planLoadFindings(plan, { sessionMin: 30 }));
  assert.equal(notes.length, ADVISORIES_MAX);
  assert.ok(notes.every(a => !a.routine || a.routine.length <= 80));
});

/* ---------------- a plan the Coach designed, and one they brought ---------------- */

test('a plan the Coach designed is still refused over a count, and told of the two that are only notes', () => {
  const r = validatePlan(CHEST, { sessionMin: 45 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0], /"chest" 48 work sets a week, over the 20/);
  // Inside both limits, under one range: a plan, with a note on it.
  const thin = validatePlan({ ...SOUND, routines: [{ id: 'a', name: 'Upper', ex: [x(BENCH, 3), x(ROW, 4)] }, SOUND.routines[1]] }, { sessionMin: 60 });
  assert.equal(thin.ok, true);
  assert.deepEqual(thin.bundle.advisories, [{ code: 'weekly-under', bp: 'chest', sets: 3, min: 4 }]);
  assert.equal(thin.bundle.own, undefined);
});

test('a plan they brought themselves is laid out as written, with the counts as notes', () => {
  const r = validatePlan({ ...CHEST, differences: ['Every set to failure (V5).', '  ', 7, 'x'.repeat(900)] }, { sessionMin: 45, ownPlan: true });
  assert.equal(r.ok, true);
  assert.equal(r.bundle.own, true);
  assert.deepEqual(r.bundle.advisories.map(a => a.code), ['weekly-over', 'session-over', 'weekly-under', 'session-part-over']);
  assert.deepEqual(r.bundle.differences.map(d => d.length), [26, 300], 'their lines, the blanks and non-strings dropped, each cut');
  assert.deepEqual(r.bundle.routines[0].ex.map(e => e.sets), [10, 8, 6, 1], 'nothing trimmed');
});

test('"their own plan" loosens the two counts and nothing else', () => {
  const own = { sessionMin: 45, ownPlan: true };
  const bad = [
    [{ ...CHEST, routines: [{ id: 'a', name: 'Chest', ex: [x('not-a-real-id', 3)] }] }, /not in the exercise library/],
    [{ ...CHEST, week: { 1: 'a', 4: 'nowhere' } }, /not one of the routines in this plan/],
    [{ ...CHEST, routines: [{ id: 'a', name: 'Chest', ex: [x(BENCH, 3, { side: true, reps: 7 })] }] }, /per-side exercise/],
    [{ ...CHEST, program: 'smolov' }, /not one of the programmes/]
  ];
  for (const [answer, why] of bad) {
    const r = validatePlan(answer, own);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), why);
  }
  assert.match(validatePlan(CHEST, { ...own, daysPerWeek: 3 }).errors.join('\n'), /schedules 2 days but 3 were asked for/);
  // And a weight above anything they have lifted is still brought down to it.
  const heavy = validatePlan({ ...CHEST, routines: [{ id: 'a', name: 'Chest', ex: [x(BENCH, 10, { weight: 200 })] }] }, { ...own, workingWeights: [{ id: BENCH, best: 80 }] });
  assert.equal(heavy.bundle.routines[0].ex[0].weight, 80);
});

test('the Coach\'s own lines belong to a plan they brought; on one it designed they are dropped', () => {
  const r = validatePlan({ ...SOUND, differences: ['Looks fine.'] }, {});
  assert.equal(r.ok, true);
  assert.equal(r.bundle.differences, undefined);
  const many = validatePlan({ ...SOUND, differences: [...Array(20)].map((_, i) => 'line ' + i) }, { ownPlan: true });
  assert.equal(many.bundle.differences.length, 6);
  assert.equal(validatePlan({ ...SOUND, differences: 'one string' }, { ownPlan: true }).bundle.differences, undefined);
});

/* ---------------- the whole loop ---------------- */

const state = profile => ({
  lang: 'en', unit: 'kg', customEx: [], routines: [], week: {}, workouts: [], bodyweight: [],
  coach: { consent: { agreedAt: 'x', version: 1 }, profile, log: [] }
});
const adapter = (replies, prompts = []) => ({ spawns: false, invoke: async ({ prompt, system }) => { prompts.push({ prompt, system }); return { code: 0, text: JSON.stringify(replies.shift()) }; } });

test('the pipeline holds "program" to what the payload offered, and one repair round can fix it', async () => {
  const payload = build(state({ goal: 'strength', experience: 'regular', daysPerWeek: 2, sessionMin: 60, equipment: [] }), { handle: 'h', kind: 'create' });
  const offered = payload.programs.candidates.map(c => c.id);
  assert.ok(offered.length, 'something to choose from');
  const prompts = [];
  const fixed = await runPipeline({ adapter: adapter([{ ...SOUND, program: '531-original' }, { ...SOUND, program: offered[0] }], prompts), cfg: {}, kind: 'create', payload });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.result.bundle.program.id, offered[0]);
  assert.match(prompts[1].prompt, /REPAIR REQUEST/);
  assert.match(prompts[1].prompt, /program "531-original" is not one of the programmes in this payload/);
  // The programmes are in the payload half of the prompt; the rules half does not change with them.
  assert.ok(prompts[0].prompt.includes('"programs":{"matched":"answers"'));
  assert.equal(prompts[0].system, PROMPTS.common + '\n\n---\n\n' + PROMPTS.principles + '\n\n---\n\n' + PROMPTS.create);
});

test('with a plan of their own in the intake, the same over-limit answer goes through, noted', async () => {
  const profile = { goal: 'muscle', experience: 'regular', daysPerWeek: 2, sessionMin: 45, equipment: [] };
  const refused = await runPipeline({ adapter: adapter([CHEST, CHEST]), cfg: {}, kind: 'create', payload: build(state(profile), { handle: 'h', kind: 'create' }) });
  assert.deepEqual([refused.ok, refused.errorClass], [false, 'unusable']);
  const own = build(state({ ...profile, ownPlan: 'Chest twice a week, ten sets of bench, the way I always have.' }), { handle: 'h', kind: 'create' });
  assert.equal(own.programs, undefined, 'it names no programme, so none is sent');
  const taken = await runPipeline({ adapter: adapter([{ ...CHEST, differences: ['Chest only (V1).'] }]), cfg: {}, kind: 'create', payload: own });
  assert.equal(taken.ok, true);
  assert.equal(taken.result.bundle.own, true);
  assert.ok(taken.result.bundle.advisories.some(a => a.code === 'weekly-over' && a.bp === 'chest' && a.sets === 48));
  assert.deepEqual(taken.result.bundle.differences, ['Chest only (V1).']);
});

test('the prompts say what the code does: who is refused over a count, and what "program" may hold', () => {
  assert.match(PROMPTS.create, /Never put an id there that is not in `candidates`/);
  assert.match(PROMPTS.create, /not held against a plan they brought/);
  assert.match(PROMPTS.create, /`programs\.unavailable`[^\n]*Do not build from them/);
  assert.match(PROMPTS.refine, /`coachProfile\.ownPlan`/);
  assert.match(PROMPTS.refine, /Never put an id in `program` that is not in `programs\.candidates`/);
  assert.match(PROMPTS.review, /A plan they brought themselves stays theirs/);
  assert.match(PROMPTS.common, /`ownPlan`, `charter\.goal`/, 'their plan is data, like every other text they typed');
});
