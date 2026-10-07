/* Which exercises reach the model.
 *
 * The model may only name what is in the slice it is handed, so the slice decides what a plan
 * can be made of. It used to be filled in the catalogue's order, which is alphabetical: with five
 * kinds of equipment ticked, 99 of the 160 rows were barbell exercises and one was a dumbbell
 * exercise, and there was no pull-up, no dumbbell bench press and no leg press to choose. These
 * tests hold the slice to what a plan is actually built from, and to what a person named.
 *
 * api/test/payload.test.js keeps the older promises: the cap, the weighted lanes, no stretches,
 * the same slice every time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';

tempData();
const { LIBRARY, LIB_BY_ID, librarySlice, isCommon, isStretch, MAX_LIBRARY } = await import('../coach/core/library.js');
const { exerciseHints, takeTurns, MOVEMENTS, HINTS_PER_MOVEMENT, HINTS_MAX } = await import('../coach/core/exercise-hints.js');
const { COMMON_IDS } = await import('../coach/core/common-data.js');
const { build } = await import('../coach/core/payload.js');

const FIVE = ['barbell', 'dumbbell', 'cable', 'leverage machine', 'body weight'];
const eqOf = e => LIB_BY_ID.get(e.id).eq;
const byKind = list => { const n = {}; list.forEach(e => { n[eqOf(e)] = (n[eqOf(e)] || 0) + 1; }); return n; };
const names = list => list.map(e => e.n);
const idOf = n => LIBRARY.find(e => e.n === n).id;

test('the mainstream list is made of catalogue rows, and is neither empty nor everything', () => {
  assert.ok(COMMON_IDS.length > 150 && COMMON_IDS.length < LIBRARY.length / 3);
  assert.ok(COMMON_IDS.every(id => LIB_BY_ID.has(id)));
  assert.deepEqual(COMMON_IDS, [...new Set(COMMON_IDS)].sort(), 'each once, in a fixed order');
  for (const n of ['pull-up', 'barbell bench press', 'dumbbell bench press', 'barbell full squat', 'barbell deadlift', 'dumbbell lateral raise']) {
    assert.ok(isCommon({ id: idOf(n) }), n);
  }
});

test('every kind of equipment someone ticked gets a real share of the slice', () => {
  const slice = librarySlice({}, FIVE);
  assert.equal(slice.length, MAX_LIBRARY);
  const n = byKind(slice);
  // It was barbell 99, dumbbell 1. No kind may be squeezed out again, and none may take over.
  for (const kind of FIVE) assert.ok(n[kind] >= 20, `${kind}: ${n[kind]} of ${MAX_LIBRARY}`);
  assert.ok(Math.max(...Object.values(n)) <= MAX_LIBRARY / 3, JSON.stringify(n));
  assert.ok(Object.keys(n).every(k => FIVE.includes(k)), 'nothing outside what was ticked');
});

test('the exercises people actually train are in it', () => {
  const have = names(librarySlice({}, FIVE));
  for (const n of ['pull-up', 'chin-up', 'barbell bench press', 'dumbbell bench press', 'dumbbell incline bench press', 'dumbbell fly',
    'dumbbell biceps curl', 'dumbbell lateral raise', 'barbell full squat', 'barbell deadlift', 'lever leg extension', 'lever lying leg curl']) {
    assert.ok(have.includes(n), n + ' is not offered');
  }
  // And with nothing ticked the whole catalogue is drawn on the same way, not band and barbell first.
  const all = byKind(librarySlice({}, []));
  for (const kind of ['barbell', 'dumbbell', 'cable', 'leverage machine', 'body weight']) assert.ok(all[kind] >= 15, `${kind}: ${all[kind]}`);
});

test('mainstream rows fill a lane before the rest, and the same answers get the same slice', () => {
  const slice = librarySlice({}, FIVE);
  const chest = slice.filter(e => e.bp === 'chest');
  const firstOther = chest.findIndex(e => !isCommon(e));
  assert.ok(firstOther < 0 || chest.slice(firstOther).every(e => !isCommon(e)), 'a mainstream chest exercise came after an obscure one');
  assert.deepEqual(librarySlice({}, FIVE).map(e => e.id), slice.map(e => e.id));
  assert.deepEqual(librarySlice({}, [...FIVE].reverse()).map(e => e.id), slice.map(e => e.id), 'the order they ticked in changes nothing');
});

test('kinds take turns, each keeping its own order', () => {
  const list = [{ id: 1, eq: 'b' }, { id: 2, eq: 'b' }, { id: 3, eq: 'a' }, { id: 4, eq: 'b' }, { id: 5, eq: 'a' }, { id: 6 }];
  assert.deepEqual(takeTurns(list).map(e => e.id), [6, 3, 1, 5, 2, 4]);
  assert.deepEqual(takeTurns([]), []);
});

/* ---------------- what they named ---------------- */

const OWN = '周一、周四练胸和手臂：杠铃卧推 5 组 8 次、上斜哑铃卧推 4 组 10 次、哑铃飞鸟 4 组 12 次、绳索下压 3 组 12 次、哑铃弯举 3 组 12 次。'
  + '周二练背：引体向上 4 组、杠铃划船 4 组 8 次、高位下拉 3 组 10 次。周五练腿：深蹲 4 组 6 次、腿举 3 组 10 次、提踵 2 组 15 次。';

test('a plan written in Chinese brings in the exercises it names', () => {
  const have = names(librarySlice({}, FIVE, { texts: [OWN] }));
  for (const n of ['barbell bench press', 'dumbbell incline bench press', 'dumbbell fly', 'cable pushdown', 'dumbbell biceps curl',
    'pull-up', 'barbell bent over row', 'barbell full squat', 'barbell standing calf raise']) {
    assert.ok(have.includes(n), n + ' was named and is not offered');
  }
  assert.ok(have.some(n => /pulldown/.test(n)));
  // The ordinary leg press is filed under "sled machine", which they did not tick. They named it.
  assert.ok(have.includes('sled 45° leg press'));
  assert.equal(have.length, MAX_LIBRARY, 'named exercises take slots, they do not add to the cap');
});

test('the same in English, and a movement on equipment the text names comes first', () => {
  const pool = LIBRARY.filter(e => FIVE.includes(e.eq) && !isStretch(e));
  const hint = text => exerciseHints([text], pool, isCommon, LIBRARY).map(id => LIB_BY_ID.get(id));
  const curls = hint('dumbbell curls and hammer curls');
  assert.ok(curls.length && curls.slice(0, HINTS_PER_MOVEMENT).every(e => e.eq === 'dumbbell' && e.bp === 'upper arms'), names(curls).join(', '));
  assert.ok(names(hint('lying leg curls')).some(n => /leg curl/.test(n)));
  const press = names(hint('bench press 5x5'));
  assert.equal(press.length, HINTS_PER_MOVEMENT);
  assert.ok(press.includes('barbell bench press') && press.includes('dumbbell bench press'), 'kinds take turns: ' + press.join(', '));
});

test('every movement in the glossary is one the catalogue has rows for', () => {
  // A term that matches no row would look like it works and pin nothing.
  for (const [said, name, bp] of MOVEMENTS) {
    const rows = LIBRARY.filter(e => name.test(e.n) && (!bp || e.bp === bp) && !isStretch(e));
    assert.ok(rows.length, `${said} finds nothing under ${name}${bp ? ' in ' + bp : ''}`);
  }
});

test('nothing named, nothing pinned; and a wall of text names a bounded number', () => {
  const pool = LIBRARY.filter(e => !isStretch(e));
  for (const t of [[], [''], [null, undefined, 7, {}], ['I just want to get stronger'], ['想变壮一点']]) assert.deepEqual(exerciseHints(t, pool, isCommon, LIBRARY), []);
  const everything = '卧推 上斜 下斜 飞鸟 俯卧撑 双杠 引体 chin-up 下拉 划船 硬拉 罗马尼亚 深蹲 腿举 腿屈伸 腿弯举 箭步 臀推 提踵 推举 侧平举 前平举 面拉 俯身飞鸟 耸肩 弯举 锤式 下压 臂屈伸 卷腹 平板支撑 举腿 高翻 swing '.repeat(500);
  const ids = exerciseHints([everything], pool, isCommon, LIBRARY);
  assert.ok(ids.length <= HINTS_MAX);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => LIB_BY_ID.has(id)));
});

test('a word inside another word names nothing', () => {
  const pool = LIBRARY.filter(e => !isStretch(e));
  assert.deepEqual(exerciseHints(['my brows furrowed, I curled up; a flyer about dipsticks'], pool, isCommon, LIBRARY), []);
});

/* ---------------- on the payload ---------------- */

const state = profile => { const S = sampleState(); S.coach.profile = profile; S.workouts = []; S.routines = []; S.week = {}; return S; };

test('a plan request reads their own plan, their likes and the message they just sent', () => {
  const base = { goal: 'muscle', experience: 'regular', daysPerWeek: 4, equipment: ['barbell'] };
  const has = (p, n) => p.library.some(e => e.n === n);
  const plain = build(state(base), { handle: 'h'.repeat(16), kind: 'create' });
  assert.ok(!has(plain, 'pull-up') && !has(plain, 'sled 45° leg press'), 'barbell only: neither is offered unasked');
  const own = build(state({ ...base, ownPlan: '引体向上和腿举' }), { handle: 'h'.repeat(16), kind: 'create' });
  assert.ok(has(own, 'pull-up') && has(own, 'sled 45° leg press'));
  const liked = build(state({ ...base, likes: 'pull-ups' }), { handle: 'h'.repeat(16), kind: 'create' });
  assert.ok(has(liked, 'pull-up'));
  // "Swap it back to a pull-up" can only be honoured if the pull-up is there to swap to.
  const reply = build(state(base), { handle: 'h'.repeat(16), kind: 'create', refine: '把助力引体换回引体向上', previous: { name: 'P' } });
  assert.ok(has(reply, 'pull-up'));
  const review = build(state(base), { handle: 'h'.repeat(16), kind: 'review', note: 'can we add lateral raises?' });
  assert.ok(review.library.some(e => /lateral raise/.test(e.n)));
  assert.ok(review.library.length <= 60);
});
