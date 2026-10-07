/* The weekly note: which week is due, what the model is handed, what it may answer, and where
   the answer goes.

   The scheduling half is pure and is tested with the clock handed in. The job half runs through
   the real queue against a provider on localhost that answers at once — an HTTPS provider spawns
   nothing, so these run wherever the suite does. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const payload = await import('../coach/core/payload.js');
const validate = await import('../coach/core/validate.js');
const { SCHEMAS } = await import('../coach/core/schemas.js');
const { dueWeek, keep, unfetched, CATCH_UP_WEEKS, KEPT_MAX, RETRY_AFTER_MS, MAX_TRIES } = await import('../coach/digest.js');
const { queueDigest } = await import('../coach/cadence.js');

const DAY = 86400000;
const HOUR = 3600000;
const shift = (on, n) => new Date(Date.parse(on + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
const session = (d, over = {}) => ({
  id: 'w' + d, d, name: 'Full body A', start: 1000, end: 1000 + 45 * 60000, prs: [],
  entries: [{ id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: [{ w: 20, r: 10, done: true }, { w: 20, r: 10, done: true }, { w: 20, r: 9, done: true }] }],
  ...over
});
const note = (week, over = {}) => ({
  id: 'n' + week.from, from: week.from, to: week.to, at: 1, sessions: 3, planned: 3, sets: 30, minutes: 150, prs: 1,
  summary: 'Week of ' + week.from, progress: ['p'], issues: [], carry: ['c'], ...over
});

/* ---------- the calendar ---------- */

test('a week runs from the day the app starts its weeks on', () => {
  // 7 October 2026 is a Wednesday.
  assert.deepEqual(payload.weekBounds('2026-10-07', 1), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(payload.weekBounds('2026-10-07', 0), { from: '2026-10-04', to: '2026-10-10' });
  // A Sunday ends a Monday week and begins a Sunday one.
  assert.deepEqual(payload.weekBounds('2026-10-11', 1), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(payload.weekBounds('2026-10-11', 0), { from: '2026-10-11', to: '2026-10-17' });
  // Anything but Sunday is Monday, as the app reads the setting.
  assert.deepEqual(payload.weekBounds('2026-10-07', undefined), payload.weekBounds('2026-10-07', 1));
  for (const bad of [null, '', 'soon', '2026-13-45', 20261007]) assert.equal(payload.weekBounds(bad, 1), null);
});

/* ---------- which week is due ---------- */

const WED = '2026-10-07';
const LAST = { from: '2026-09-28', to: '2026-10-04' };
const stateWith = (days, over = {}) => sampleState({ workouts: days.map(d => session(d)), ...over });
const NOW = Date.UTC(2026, 9, 7, 12);
const failed = (week, errorClass, ago) => ({ kind: 'digest', outcome: 'failed', errorClass, week, at: NOW - ago });

test('the week that just ended is due once it was trained, and not before it is over', () => {
  assert.deepEqual(dueWeek(stateWith(['2026-09-30']), {}, WED), LAST);
  assert.equal(dueWeek(stateWith(['2026-10-06']), {}, WED), null, 'this week is still running');
  assert.equal(dueWeek(stateWith([]), {}, WED), null, 'a week nobody trained has nothing to write up');
  assert.equal(dueWeek(stateWith(['2026-09-30']), {}, '2026-10-04'), null, 'on its own last day the week is not over');
  assert.deepEqual(dueWeek(stateWith(['2026-09-30']), {}, '2026-10-05'), LAST, 'and the day after, it is');
});

test('without a timezone the week is left one more day', () => {
  const S = stateWith(['2026-09-30']);
  assert.equal(dueWeek(S, {}, '2026-10-05', { tzKnown: false }), null, 'Monday by the server\'s clock may still be Sunday evening for them');
  assert.deepEqual(dueWeek(S, {}, '2026-10-06', { tzKnown: false }), LAST);
});

test('a week of the app\'s own shape: Sunday to Saturday when that is the setting', () => {
  assert.deepEqual(dueWeek(stateWith(['2026-09-30'], { weekStart: 0 }), {}, WED), { from: '2026-09-27', to: '2026-10-03' });
  assert.equal(dueWeek(stateWith(['2026-10-04'], { weekStart: 0 }), {}, WED), null, 'that Sunday opens the week still running');
});

test('weeks missed while the server was off are caught up, oldest first, and only so far back', () => {
  assert.deepEqual(dueWeek(stateWith(['2026-09-15', '2026-09-30']), {}, WED), { from: '2026-09-14', to: '2026-09-20' });
  const oldest = shift(LAST.from, -7 * (CATCH_UP_WEEKS - 1));
  assert.deepEqual(dueWeek(stateWith([oldest]), {}, WED), payload.weekBounds(oldest, 1));
  assert.equal(dueWeek(stateWith([shift(oldest, -1)]), {}, WED), null, 'a week further back than that stays unwritten');
});

test('a week is written up once: a note in the synced state or still held here means done', () => {
  const S = stateWith(['2026-09-15', '2026-09-30']);
  const first = { from: '2026-09-14', to: '2026-09-20' };
  assert.deepEqual(dueWeek({ ...S, coach: { ...S.coach, digests: [note(first)] } }, {}, WED), LAST, 'the phone has the first, the second is next');
  assert.deepEqual(dueWeek(S, { digests: [note(first)] }, WED), LAST, 'held here counts the same');
  assert.equal(dueWeek({ ...S, coach: { ...S.coach, digests: [note(first)] } }, { digests: [note(LAST)] }, WED), null);
  // Whatever a client wrote where the notes go, it is not a reason to throw on every tick.
  for (const junk of ['x', { from: LAST.from }, [null, 7, 'x']]) assert.deepEqual(dueWeek({ ...stateWith(['2026-09-30']), coach: { digests: junk } }, { digests: junk, history: junk }, WED), LAST);
});

test('a week that failed is tried again later, a few times, and never when the answer was paid for', () => {
  const S = stateWith(['2026-09-30']);
  const due = history => dueWeek(S, { history }, WED, { now: NOW });
  assert.equal(due([failed(LAST.from, 'provider', HOUR)]), null, 'not a minute later');
  assert.deepEqual(due([failed(LAST.from, 'provider', RETRY_AFTER_MS + 1)]), LAST);
  assert.equal(due([...Array(MAX_TRIES)].map(() => failed(LAST.from, 'timeout', 10 * RETRY_AFTER_MS))), null, 'and then it is given up');
  for (const final of ['unusable', 'toolarge', 'noworkout']) assert.equal(due([failed(LAST.from, final, 10 * RETRY_AFTER_MS)]), null, final);
  // Somebody else's failure is not this week's.
  assert.deepEqual(due([failed('2026-09-21', 'unusable', HOUR), { kind: 'review', outcome: 'failed', errorClass: 'unusable', at: NOW }]), LAST);
  // A week that cannot be written does not hold up the one after it.
  const two = stateWith(['2026-09-22', '2026-09-30']);
  assert.deepEqual(dueWeek(two, { history: [failed('2026-09-21', 'unusable', HOUR)] }, WED, { now: NOW }), LAST);
});

test('a date that is not one is no reason to queue anything', () => {
  for (const bad of [null, undefined, '', 'today', 20261007]) assert.equal(dueWeek(stateWith(['2026-09-30']), {}, bad), null);
  assert.equal(dueWeek(null, {}, WED), null);
});

test('what is held: one note a week, the newest few, and only until the phone has them', () => {
  const weeks = [...Array(KEPT_MAX + 3)].map((_, i) => payload.weekBounds(shift('2026-01-05', 7 * i), 1));
  let held = [];
  for (const w of [...weeks].reverse()) held = keep(held, note(w));
  assert.equal(held.length, KEPT_MAX);
  assert.deepEqual(held.map(g => g.from), weeks.slice(-KEPT_MAX).map(w => w.from), 'oldest first, the oldest dropped');
  const again = keep(held, note(weeks.at(-1), { summary: 'written again' }));
  assert.equal(again.length, KEPT_MAX);
  assert.equal(again.at(-1).summary, 'written again');
  assert.deepEqual(keep('junk', note(weeks[0])).map(g => g.from), [weeks[0].from]);

  const S = { coach: { digests: [note(weeks.at(-1)), note(weeks.at(-2))] } };
  assert.deepEqual(unfetched(held, S).map(g => g.from), held.slice(0, -2).map(g => g.from));
  assert.equal(unfetched(held, {}).length, KEPT_MAX);
  assert.deepEqual(unfetched(null, S), []);
});

/* ---------- what the model may answer ---------- */

test('the three places a note is measured agree on its size', () => {
  assert.equal(validate.DIGEST_SUMMARY_MAX, payload.DIGEST_SUMMARY_CHARS);
  assert.equal(validate.DIGEST_ITEMS_MAX, payload.DIGEST_ITEMS);
  assert.equal(validate.DIGEST_ITEM_MAX, payload.DIGEST_ITEM_CHARS);
  assert.deepEqual(validate.DIGEST_LISTS, payload.DIGEST_LISTS);
  for (const k of validate.DIGEST_LISTS) assert.equal(SCHEMAS.digest.properties[k].maxItems, validate.DIGEST_ITEMS_MAX);
  assert.ok(KEPT_MAX >= payload.DIGESTS_SENT, 'a review that reads twelve finds twelve held');
});

test('a note is a summary and three short lists, and nothing else gets through', () => {
  const ok = validate.validateDigest({
    coach_contract: 1, summary: '  Three of three sessions. Squat 100x5, up from 97.5x5.  ',
    progress: ['Squat 100x5', '', 7, '  Bench held at 60x8  '], issues: [], carry: ['Check the bench again'],
    score: 9, changes: [], week: { sessions: 99 }, from: '1999-01-01'
  });
  assert.deepEqual(ok, { ok: true, proposal: {
    summary: 'Three of three sessions. Squat 100x5, up from 97.5x5.',
    progress: ['Squat 100x5', 'Bench held at 60x8'], issues: [], carry: ['Check the bench again']
  } });
  assert.deepEqual(validate.validateDigest({ summary: 'Only this.' }).proposal, { summary: 'Only this.', progress: [], issues: [], carry: [] });

  const bad = v => validate.validateDigest(v);
  assert.equal(bad(null).ok, false);
  assert.ok(bad({ progress: ['x'] }).errors.some(e => e.includes('summary is required')));
  assert.ok(bad({ summary: 's', nochange: true }).errors.some(e => e.includes('nochange')));
  assert.ok(bad({ summary: 's', changes: [{ type: 'sets' }] }).errors.some(e => e.includes('no plan changes')));
  assert.ok(bad({ summary: 's', issues: 'one string' }).errors.some(e => e.includes('issues must be an array')));
});

test('a note that runs long is cut to size, at the end of a sentence where there is one', () => {
  const sentence = 'Squat went from 97.5x5 to 100x5 this week. ';
  const long = validate.validateDigest({ summary: sentence.repeat(40), progress: [...Array(9)].map((_, i) => 'item ' + i), carry: ['c'.repeat(900)] }).proposal;
  assert.ok(long.summary.length <= validate.DIGEST_SUMMARY_MAX);
  assert.ok(long.summary.endsWith('this week.'), 'whole sentences');
  assert.ok(long.summary.includes('97.5x5'), 'and a decimal point is not the end of one');
  assert.equal(long.progress.length, validate.DIGEST_ITEMS_MAX);
  assert.equal(long.carry[0].length, validate.DIGEST_ITEM_MAX, 'nowhere to stop: cut at the limit');
  const zh = validate.validateDigest({ summary: '本周完成三次训练，深蹲从97.5公斤升到100公斤。'.repeat(40) }).proposal.summary;
  assert.ok(zh.length <= validate.DIGEST_SUMMARY_MAX && zh.endsWith('。'));
});

/* ---------- what the model is handed ---------- */

const today = new Date().toISOString().slice(0, 10);
// Dated from today: the marks are counted over the last twelve weeks of the clock.
const W = k => payload.weekBounds(shift(today, -7 * k), 1);
const build = (S, opts) => payload.build(S, { handle: 'h'.repeat(16), ...opts });

test('a digest payload is one week in full, as it stood when the week ended', () => {
  const sets = [{ w: 20, r: 10, done: true }, { w: 20, r: 10, done: true }, { w: 20, r: 8, done: false }];
  const week = W(1);
  const S = sampleState({ bodyweight: [{ d: shift(week.from, -40), w: 77 }, { d: shift(week.from, -5), w: 78 }, { d: week.to, w: 78.4 }, { d: shift(week.to, 1), w: 79 }] });
  S.workouts = [
    { id: 'before', d: shift(week.from, -3), name: 'Full body A', start: 1, end: 1 + 30 * 60000, entries: [{ id: '0001', sets, flags: ['equipment'] }] },
    {
      id: 'a', d: week.from, name: 'Full body A', start: 1, end: 1 + 40 * 60000, prs: ['x'],
      entries: [
        { id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets, flags: ['equipment'], note: 'rack taken' },
        { id: '0007', sets: [{ sec: 10, done: true, warmup: true }, { sec: 45, done: true }] }
      ]
    },
    { id: 'b', d: shift(week.from, 3), name: 'Full body A', start: 1, end: 1 + 50 * 60000, entries: [{ id: '0001', sets }], skipped: [{ id: '0025', flags: ['pain'], note: 'shoulder' }] },
    { id: 'after', d: shift(week.to, 1), name: 'Full body A', start: 1, end: 2, entries: [{ id: '0001', sets, flags: ['heavy'] }] }
  ];
  const stamp = d => Date.parse(d + 'T12:00:00Z');
  const change = (d, why, status = 'accepted') => ({ kind: 'review', at: stamp(d), proposalId: 'p' + d + status, decisions: [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 4, after: 3, why, status }] });
  const debrief = (id, d) => ({ kind: 'debrief', at: stamp(d), workout: { id, d, name: 'Full body A' }, summary: 'About ' + id, score: 7, watch: ['w'], nextTime: ['n'] });
  S.coach.log = [change(shift(week.from, -9), 'before the week'), change(shift(week.from, 1), 'in the week'), change(shift(week.from, 2), 'turned down', 'rejected'), change(shift(week.to, 1), 'after the week'), debrief('a', week.from), debrief('after', shift(week.to, 1))];
  S.coach.chat = [{ role: 'user', kind: 'text', text: 'shorter please' }];
  S.coach.charter = { goal: 'Squat 140', blockWeeks: 4, startedAt: week.from, checkpoint: shift(week.from, 28) };
  S.coach.digests = [note(W(5)), note(W(4)), note(W(3)), note(W(2)), note(week, { summary: 'this very week, written before' })];

  const p = build(S, { kind: 'digest', week });
  assert.equal(p.task, 'digest');
  assert.deepEqual({ ...p.week, workouts: null }, { from: week.from, to: week.to, sessions: 2, planned: 3, sets: 5, minutes: 90, prs: 1, marks: { pain: 1, equipment: 1 }, workouts: null });
  assert.deepEqual(p.week.workouts.map(w => w.d), [week.from, shift(week.from, 3)]);
  assert.ok(p.week.workouts.every(w => !w.compact && Array.isArray(w.entries[0].sets)), 'every session of the week keeps its sets');
  assert.equal(p.week.workouts[0].entries[0].note, 'rack taken');
  assert.deepEqual(p.week.workouts[1].skipped, [{ id: '0025', name: payload.libraryName('0025'), flags: ['pain'], note: 'shoulder' }]);

  // The marks counted up to the week's last day: twice on the bench, and nothing from after.
  assert.deepEqual(p.observations.exercises.map(x => [x.id, x.flag, x.times]), [['0025', 'pain', 1], ['0001', 'equipment', 2]]);
  assert.equal(p.observations.to, shift(week.from, 3));
  assert.ok(p.aggregates.exercises.every(e => ['0001', '0007', '0025'].includes(e.id)));
  assert.deepEqual(p.bodyweight.series.map(b => b.w), [78, 78.4], 'four weeks of weigh-ins, up to the week\'s end');

  assert.deepEqual(p.recentChanges.map(c => c.why), ['in the week']);
  assert.deepEqual(p.debriefs.map(d => d.summary), ['About a']);
  assert.deepEqual(p.digests.map(g => g.from), [W(4).from, W(3).from, W(2).from], 'the three notes before it, oldest first, and never its own');
  assert.deepEqual(p.digests[0], { from: W(4).from, to: W(4).to, sessions: 3, planned: 3, sets: 30, minutes: 150, prs: 1, summary: 'Week of ' + W(4).from, progress: ['p'], carry: ['c'] });

  // The block is placed on the week's last day, not on the day the note happens to be written.
  assert.equal(p.charter.week, 1);
  assert.equal(p.charter.checkpointDue, false);
  assert.ok(p.plan.routines.length && p.coachProfile);
  for (const k of ['library', 'previouslyDeclined', 'conversation', 'window', 'session', 'history']) assert.equal(k in p, false, k);
});

test('a digest for no week, or for one nobody trained, is an empty week and not a crash', () => {
  for (const week of [undefined, null, 'last', { from: 'x', to: 'y' }, { from: '2020-01-06', to: '2020-01-12' }]) {
    const p = build(sampleState(), { kind: 'digest', week });
    assert.equal(p.week.sessions, 0);
    assert.deepEqual(p.week.workouts, []);
  }
});

test('a review reads the notes on earlier weeks, and they stand in for the one-line sessions they cover', () => {
  const S = sampleState();
  S.workouts = [
    session(W(3).from), session(shift(W(3).from, 2)),       // written up
    session(W(2).from), session(shift(W(2).from, 2)),       // not written up
    session(W(1).from), session(shift(W(1).from, 2)), session(shift(W(1).from, 4))   // written up, and the last three
  ];
  // No note, no change: every session is in the list, as it was before there were notes.
  const plain = build(S, { kind: 'review' });
  assert.equal(plain.window.workouts.length, 7);
  assert.equal('inDigests' in plain.window, false);
  assert.equal('digests' in plain, false);

  S.coach.digests = [note(W(8)), note(W(3)), { from: 'not a week' }, 'junk', null];
  const p = build(S, { kind: 'review', digests: [note(W(1), { summary: 'held on the server' }), note(W(3), { summary: 'the copy held wins' })] });
  assert.deepEqual(p.digests.map(g => [g.from, g.summary]), [
    [W(8).from, 'Week of ' + W(8).from],                    // further back than the window reaches
    [W(3).from, 'the copy held wins'],
    [W(1).from, 'held on the server']
  ]);
  assert.deepEqual(p.window.workouts.map(w => [w.d, !!w.compact]), [
    [W(2).from, true], [shift(W(2).from, 2), true],
    [W(1).from, false], [shift(W(1).from, 2), false], [shift(W(1).from, 4), false]
  ], 'the unwritten week keeps its lines, the last three keep their sets');
  assert.equal(p.window.inDigests, 2);
  assert.equal(p.window.from, W(3).from, 'the window is still the whole of what was read');
  assert.equal(p.aggregates.adherence.sessionsInWindow, 7, 'and the counts are still taken from every session');

  // Notes travel on a review only; and the last review does not cut them off.
  S.coach.lastReview = { at: shift(W(1).from, 3) };
  assert.equal(build(S, { kind: 'review' }).digests.length, 2);
  for (const kind of ['create', 'debrief']) assert.equal('digests' in build(S, { kind }), false);
});

test('only the most recent notes travel, each read by name and cut', () => {
  const HUGE = 'x'.repeat(200_000);
  const S = sampleState();
  S.coach.digests = [...Array(40)].map((_, i) => ({
    ...note(W(40 - i)), id: HUGE, extra: HUGE, from: W(40 - i).from + HUGE, summary: HUGE, sessions: HUGE, sets: -1, minutes: 1.5, prs: 1e9,
    marks: { pain: 2, made: 3, heavy: HUGE, equipment: 0 }, progress: [...Array(500)].map(() => HUGE), issues: HUGE, carry: [HUGE, 7, null, '  kept  ']
  }));
  const p = build(S, { kind: 'review' });
  assert.equal(p.digests.length, payload.DIGESTS_SENT);
  assert.equal(p.digests.at(-1).from, W(1).from);
  assert.ok(JSON.stringify(p.digests).length < 20_000, 'twelve notes stay small (' + JSON.stringify(p.digests).length + ')');
  const g = p.digests[0];
  assert.deepEqual(Object.keys(g), ['from', 'to', 'planned', 'marks', 'summary', 'progress', 'carry'], 'a count that is not one is absent');
  assert.deepEqual(g.marks, { pain: 2 });
  assert.equal(g.summary.length, payload.DIGEST_SUMMARY_CHARS);
  assert.equal(g.progress.length, payload.DIGEST_ITEMS);
  assert.ok(g.progress.every(x => x.length === payload.DIGEST_ITEM_CHARS));
  assert.deepEqual(g.carry, ['x'.repeat(payload.DIGEST_ITEM_CHARS), 'kept']);
});

/* ---------- the job ---------- */

/** A provider on localhost that answers every request at once with whatever `reply` makes of the
 *  payload it was sent. */
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
      // 404, not 500: the adapter waits and retries a 5xx, and this is about what happens after.
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
const trained = (over = {}) => sampleState({ reminder: { tz: 'UTC' }, workouts: [session(W(1).from)], ...over });
const NOTE = { coach_contract: 1, summary: 'One of three sessions. Bench 20x10, 20x10, 20x9.', progress: ['Bench 20x10 twice'], issues: ['Two planned days untrained'], carry: ['See whether three days fit'] };
const NOCHANGE = { coach_contract: 1, nochange: true, reading: 'Steady.' };

test('a trained week is written up once, held for the phone, and let go when the phone has it', async () => {
  const p = await provider(sent => (sent.task === 'digest' ? NOTE : NOCHANGE));
  const notified = [];
  jobs.setProposalHook(uid => notified.push(uid));
  try {
    const uid = 'u-week';
    const S = trained();
    writeState(DIR, uid, S);
    // A proposal nobody has answered yet: the note must neither wait for it nor replace it.
    fs.mkdirSync(path.join(DIR, 'coach'), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'coach', uid + '.json'), JSON.stringify({ pending: { id: 'p1', kind: 'review', expiresAt: Date.now() + DAY, changes: [] } }));

    assert.equal(queueDigest(uid, S, deps), true);
    assert.equal(jobs.status(uid).job.kind, 'digest');
    assert.equal(queueDigest(uid, S, deps), false, 'not twice while it runs');
    await settle(uid);

    assert.equal(p.seen.length, 1);
    assert.equal(p.seen[0].task, 'digest');
    assert.deepEqual([p.seen[0].week.from, p.seen[0].week.sessions], [W(1).from, 1]);

    const rec = jobs.readUser(uid);
    assert.equal(rec.digests.length, 1);
    const { id, at, ...kept } = rec.digests[0];
    assert.ok(id && at > Date.now() - 60000);
    assert.deepEqual(kept, {
      from: W(1).from, to: W(1).to, sessions: 1, planned: 3, sets: 3, minutes: 45, prs: 0,
      summary: NOTE.summary, progress: NOTE.progress, issues: NOTE.issues, carry: NOTE.carry
    }, 'the counts are the log\'s, the sentences the model\'s');
    assert.equal(rec.pending.id, 'p1', 'the proposal is still waiting');
    assert.deepEqual(notified, [], 'and nobody is notified about a note');
    assert.deepEqual({ kind: rec.history.at(-1).kind, outcome: rec.history.at(-1).outcome, week: rec.history.at(-1).week }, { kind: 'digest', outcome: 'kept', week: W(1).from });

    const st = jobs.status(uid);
    assert.equal(st.digests.length, 1, 'the poll hands it over');
    assert.equal(st.last, null, 'and does not report it as the answer to anything');
    assert.equal(queueDigest(uid, S, deps), false, 'a week is written up once');
    assert.equal(p.seen.length, 1);

    // A review that runs before any phone has looked still reads the note.
    jobs.enqueue(uid, { kind: 'review' });
    await settle(uid);
    assert.deepEqual(p.seen[1].digests.map(g => g.summary), [NOTE.summary]);
    assert.equal(jobs.status(uid).last.outcome, 'nochange');

    // The phone takes it into its state and syncs; the next tick stops holding it.
    const synced = { ...S, coach: { ...S.coach, digests: [rec.digests[0]] } };
    writeState(DIR, uid, synced);
    assert.equal(queueDigest(uid, synced, deps), false);
    assert.deepEqual(jobs.readUser(uid).digests, []);
    assert.equal('digests' in jobs.status(uid), false);
  } finally {
    jobs.setProposalHook(null);
    p.close();
  }
});

test('a provider that is down costs one try now and another later, not one a minute', async () => {
  const p = await provider(() => null);
  try {
    const uid = 'u-down';
    const S = trained();
    writeState(DIR, uid, S);
    assert.equal(queueDigest(uid, S, deps), true);
    await settle(uid);
    const rec = jobs.readUser(uid);
    assert.deepEqual(rec.digests, []);
    assert.deepEqual({ outcome: rec.history.at(-1).outcome, week: rec.history.at(-1).week }, { outcome: 'failed', week: W(1).from });
    assert.notEqual(rec.history.at(-1).errorClass, 'unusable');
    assert.equal(queueDigest(uid, S, deps), false, 'the next tick leaves it alone');
    assert.equal(p.seen.length, 1);
  } finally { p.close(); }
});

test('an answer that cannot be used is paid for once and the week is left unwritten', async () => {
  const p = await provider(() => ({ coach_contract: 1, changes: [{ type: 'sets' }] }));
  try {
    const uid = 'u-unusable-note';
    const S = trained();
    writeState(DIR, uid, S);
    assert.equal(queueDigest(uid, S, deps), true);
    await settle(uid);
    assert.equal(p.seen.length, 2, 'the one repair round every job gets');
    assert.equal(jobs.readUser(uid).history.at(-1).errorClass, 'unusable');
    assert.equal(dueWeek(S, jobs.readUser(uid), today, { now: Date.now() + 30 * DAY }), null, 'however long it waits');
  } finally { p.close(); }
});

test('a note that cannot be queued does not throw into the tick, and a week trained nowhere queues nothing', async () => {
  const p = await provider(() => NOCHANGE);
  try {
    const uid = 'u-capped';
    const S = trained();
    writeState(DIR, uid, S);
    cfg.save({ caps: { perProfileDaily: 1, instanceDaily: 0 } });
    jobs.enqueue(uid, { kind: 'review' });
    await settle(uid);
    assert.equal(queueDigest(uid, S, deps), false, 'the day\'s cap is spent');
    assert.equal(p.seen.length, 1);
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0 } });

    const idle = trained({ workouts: [session(shift(today, -200))] });
    writeState(DIR, 'u-idle', idle);
    assert.equal(queueDigest('u-idle', idle, deps), false);
    // No timezone on the profile: the server's own date, and no call into a zone that is not there.
    const nowhere = trained({ reminder: undefined, workouts: [] });
    writeState(DIR, 'u-nowhere', nowhere);
    assert.equal(queueDigest('u-nowhere', nowhere, { userNow: () => { throw new Error('not asked'); } }), false);
  } finally { p.close(); }
});

test('forgetting a profile drops its notes, and removing the profile leaves no file at all', async () => {
  const p = await provider(sent => (sent.task === 'digest' ? NOTE : NOCHANGE));
  try {
    const file = uid => path.join(DIR, 'coach', uid + '.json');
    for (const uid of ['u-forgets', 'u-removed']) {
      const S = trained();
      writeState(DIR, uid, S);
      assert.equal(queueDigest(uid, S, deps), true);
      await settle(uid);
      assert.equal(jobs.readUser(uid).digests.length, 1);
    }
    jobs.clearUser('u-forgets');
    assert.deepEqual(jobs.readUser('u-forgets').digests, []);
    assert.ok(fs.existsSync(file('u-forgets')), 'the day\'s count is what stays');
    jobs.removeUser('u-removed');
    assert.equal(fs.existsSync(file('u-removed')), false);
  } finally { p.close(); }
});
