/* Asking the Coach before a workout is started.
 *
 * What is pinned here is what the person relies on when they tap Start afterwards: the workout
 * they were shown is the one that opens, with what they took of the answer already in it; a
 * suggestion for the day is written the way the day sheet writes one, for today only; and what
 * was prepared is let go as soon as the plan under it has moved.
 */
import { describe, expect, it } from 'vitest'
import {
  DAY_FROM_MAX, DAY_WHY_CHARS, buildPre, prepFor, canPrepare, preToStart, startFromPre, dayView, fitDay, takeDay, cleanCoachedDay,
} from './coach-pre.js'
import { canAskLive, talkOf, threadFor, addQuestion, addAnswer, takeOp } from './coach-live.js'
import { DAY_OPS } from '../../../api/coach/core/live.js'
import * as serverPayload from '../../../api/coach/core/payload.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { buildCombinedEntries } from './session-merge.js'
import { effectiveRoutineIds } from './history.js'

// Real ids from the catalogue: the ops are checked against it, as on the server.
const SQUAT = '0043', BENCH = '0025', DB_BENCH = '0289', LEG_EXT = '0585'
const TODAY = '2026-10-08'
const ME = 'u1'
const everyDay = id => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [id]]))
const ex = (id, sets, reps, weight) => ({ id, sets, reps, weight, prog: 'off' })
const state = (over = {}) => ({
  unit: 'kg', workouts: [], exWeights: {}, bodyweight: [], customEx: [], dayPlan: {},
  routines: [
    { id: 'h', name: 'Heavy', ex: [ex(SQUAT, 3, 5, 105), ex(BENCH, 3, 5, 72.5), ex(LEG_EXT, 2, 12, 40)] },
    { id: 'l', name: 'Light', ex: [ex(SQUAT, 2, 5, 80), ex(DB_BENCH, 3, 10, 22.5)] },
    { id: 'e', name: 'Empty', ex: [] },
  ],
  week: everyDay('h'),
  ...over,
})
const clone = v => JSON.parse(JSON.stringify(v))
const work = e => e.sets.filter(s => !s.warmup && s.phase !== 'warmup')
// A prepared workout with one question answered.
function asked(S, answer) {
  const prep = buildPre(S, TODAY, ME)
  addQuestion(prep.session, { id: 'q1', text: 'Slept five hours.' })
  addAnswer(prep.session, 'q1', { reply: 'Here is what I suggest.', ...answer })
  return prep
}
const WHY = 'Heavy was trained yesterday (A9).'

describe('the workout prepared before it is started', () => {
  it('is today’s workout as Start would build it, with no clock', () => {
    const S = state()
    const prep = buildPre(S, TODAY, ME)
    const { session } = prep
    expect(prep.owner).toBe(ME)
    expect(session).toMatchObject({ d: TODAY, pre: true, routineIds: ['h'], name: 'Heavy', cur: 0 })
    expect('start' in session).toBe(false)
    expect(session.entries).toEqual(buildCombinedEntries(S, ['h']).entries)
    expect(session.entries.map(e => [e.id, e.rid])).toEqual([[SQUAT, 'h'], [BENCH, 'h'], [LEG_EXT, 'h']])
    // Everything asking during a workout does is done to it the same way.
    expect(canAskLive(session)).toBe(true)
    expect(canPrepare(S, TODAY)).toBe(true)
  })

  it('is read by the server as a session not started, and the phone reads the day off it the same way', () => {
    const S = state()
    const { session } = buildPre(S, TODAY, ME)
    const theirs = serverPayload.liveContext(S, session)
    expect(theirs.pre).toBe(true)
    expect(theirs.startedAt).toBe(null)
    expect(dayView(S, session)).toEqual({ pre: true, routineIds: theirs.routineIds, routines: theirs.routines })
    expect(theirs.routines).toEqual([{ id: 'h', name: 'Heavy' }, { id: 'l', name: 'Light' }])
    const sent = serverPayload.build(S, { handle: 'h'.repeat(16), kind: 'live', live: session, note: 'Slept five hours.' })
    expect(sent.live).toMatchObject({ pre: true, name: 'Heavy', routines: ['h'] })
    expect(sent.live.entries.every(e => e.setsDone === 0 && e.setsLeft > 0)).toBe(true)
  })

  it('there is none on a rest day, or for a routine with nothing in it', () => {
    for (const S of [state({ week: {} }), state({ week: everyDay('e') }), state({ dayPlan: { [TODAY]: 'rest' } })]) {
      expect(buildPre(S, TODAY, ME)).toBe(null)
      expect(canPrepare(S, TODAY)).toBe(false)
    }
  })

  it('stands while the person, the day, the routines and the plan under it are the same', () => {
    const S = state()
    const prep = buildPre(S, TODAY, ME)
    expect(prepFor(S, prep, TODAY, ME)).toBe(prep)
    // What was said and taken does not unsettle it.
    const used = asked(S, { ops: [{ op: 'change-remaining', entry: 0, exId: SQUAT, weight: 100, why: 'w' }] })
    takeOp({ ...S, active: used.session }, 'q1.a', 0)
    expect(prepFor(S, used, TODAY, ME)).toBe(used)

    expect(prepFor(S, prep, TODAY, 'someone-else')).toBe(null)
    expect(prepFor(S, prep, '2026-10-09', ME)).toBe(null)
    expect(prepFor(state({ dayPlan: { [TODAY]: 'l' } }), prep, TODAY, ME)).toBe(null)
    expect(prepFor(state({ dayPlan: { [TODAY]: 'rest' } }), prep, TODAY, ME)).toBe(null)
    // The plan moved under it: the cycle rolled into a week at other numbers, or the routine was edited.
    const moved = state()
    moved.routines[0].ex[0].weight = 107.5
    expect(prepFor(moved, prep, TODAY, ME)).toBe(null)
    const fewer = state()
    fewer.routines[0].ex.pop()
    expect(prepFor(fewer, prep, TODAY, ME)).toBe(null)
    for (const bad of [null, undefined, {}, { owner: ME }, { owner: ME, session: { ...prep.session, pre: false } }, { owner: ME, session: { ...prep.session, entries: [] } }]) {
      expect(prepFor(S, bad, TODAY, ME)).toBe(null)
    }
  })
})

describe('what is taken of an answer before the workout', () => {
  const ANSWER = {
    ops: [
      { op: 'change-remaining', entry: 0, exId: SQUAT, weight: 100, why: 'Five hours of sleep and a tight shoulder.' },
      { op: 'skip', entry: 2, exId: LEG_EXT, why: 'Forty minutes: the accessory at the end goes first (A6).' },
    ],
    flags: [{ entry: 1, exId: BENCH, flag: 'discomfort' }],
  }

  it('is applied to the prepared workout: every set of it is still to do', () => {
    const S = state()
    const prep = asked(S, ANSWER)
    const st = { ...S, active: prep.session }
    expect(takeOp(st, 'q1.a', 0)).toMatchObject({ id: SQUAT, op: 'change-remaining', n: 3, w: 100 })
    expect(takeOp(st, 'q1.a', 1)).toMatchObject({ id: LEG_EXT, op: 'skip' })
    expect(prep.session.entries.map(e => e.id)).toEqual([SQUAT, BENCH])
    expect(work(prep.session.entries[0]).map(s => s.w)).toEqual([100, 100, 100])
    expect(prep.session.entries[0].target.weight).toBe(105)
    expect(prep.session.entries[1].flags).toEqual(['discomfort'])
    expect(prep.session.coached).toHaveLength(2)
    // The profile's own state was only read.
    expect(S).toEqual(state())
  })

  it('opens with the workout when it is started, and only then', () => {
    const S = state()
    // Nothing said, nothing taken: Start builds the same workout anyway.
    expect(preToStart(S, buildPre(S, TODAY, ME), ['h'], TODAY, ME)).toBe(null)

    const prep = asked(S, ANSWER)
    takeOp({ ...S, active: prep.session }, 'q1.a', 0)
    expect(preToStart(S, prep, ['l'], TODAY, ME)).toBe(null)
    expect(preToStart(S, prep, ['h', 'l'], TODAY, ME)).toBe(null)
    expect(preToStart(S, prep, ['h'], TODAY, 'someone-else')).toBe(null)
    expect(preToStart(S, prep, ['h'], '2026-10-09', ME)).toBe(null)
    const session = preToStart(S, prep, ['h'], TODAY, ME)
    expect(session).toBe(prep.session)

    // What Start just built, then given what was prepared.
    const active = { id: 'w9', d: TODAY, start: 1700000000000, routineIds: ['h'], name: 'Heavy', bw: 80, cur: 0, entries: buildCombinedEntries(S, ['h']).entries, workoutView: 'cards' }
    startFromPre(active, clone(session))
    expect(active).toMatchObject({ id: 'w9', start: 1700000000000, bw: 80, workoutView: 'cards' })
    expect('pre' in active).toBe(false)
    expect(work(active.entries[0]).map(s => s.w)).toEqual([100, 100, 100])
    expect(active.entries[1].flags).toEqual(['discomfort'])
    expect(active.coached).toHaveLength(1)
    // The conversation goes on in the workout: the next question carries what was said before it.
    expect(threadFor(active)).toEqual([{ who: 'user', text: 'Slept five hours.' }, { who: 'coach', text: 'Here is what I suggest.' }])
    // And the card not taken before can still be taken between two sets.
    expect(takeOp({ ...S, active }, 'q1.a', 1)).toMatchObject({ id: LEG_EXT, op: 'skip' })

    // With nothing prepared, the workout is left as it was built.
    const plain = { entries: ['x'] }
    startFromPre(plain, null)
    expect(plain).toEqual({ entries: ['x'] })
  })

  it('keeps an answer’s word on the day only for a workout that has not been started', () => {
    const S = state()
    const day = { do: 'train', routine: 'l', name: 'Light', why: WHY, SECRET: 'x' }
    const prep = asked(S, { day })
    expect(talkOf(prep.session).at(-1).day).toEqual({ do: 'train', routine: 'l', name: 'Light', why: WHY })
    expect(asked(S, { day: { do: 'rest', routine: 'l', why: WHY } }).session.coachTalk.at(-1).day).toEqual({ do: 'rest', why: WHY })
    for (const bad of [{ do: 'move-to-friday', why: WHY }, { do: 'train', why: WHY }, 'rest', null]) {
      expect('day' in talkOf(asked(S, { day: bad }).session).at(-1)).toBe(false)
    }
    const under = { ...buildPre(S, TODAY, ME).session, pre: undefined, start: Date.now() }
    addQuestion(under, { id: 'q1', text: 'q' })
    addAnswer(under, 'q1', { reply: 'r', day })
    expect('day' in talkOf(under).at(-1)).toBe(false)
  })
})

describe('the day', () => {
  it('every kind the server lets through is one the phone takes', () => {
    expect(DAY_OPS).toEqual(['train', 'rest'])
    for (const kind of DAY_OPS) {
      const s = state()
      expect(takeDay(s, asked(s, { day: { do: kind, routine: 'l', why: WHY } }), 'q1.a', TODAY), kind).toBeTruthy()
    }
  })

  it('train puts another routine in today’s place, the way the day sheet does', () => {
    const s = state()
    const prep = asked(s, { day: { do: 'train', routine: 'l', name: 'Light', why: WHY } })
    const out = takeDay(s, prep, 'q1.a', TODAY)
    expect(s.dayPlan).toEqual({ [TODAY]: 'l' })
    expect(effectiveRoutineIds(s, TODAY, TODAY)).toEqual(['l'])
    const next = out.prep
    expect(next.session).toMatchObject({ pre: true, d: TODAY, routineIds: ['l'], name: 'Light' })
    expect(next.session.id).not.toBe(prep.session.id)
    expect(next.session.entries.map(e => e.id)).toEqual([SQUAT, DB_BENCH])
    // It is the one that stands now, and it remembers what it replaced and what was said.
    expect(prepFor(s, next, TODAY, ME)).toBe(next)
    expect(prepFor(s, prep, TODAY, ME)).toBe(null)
    expect(next.session.coachedDay).toEqual({ from: ['Heavy'], why: WHY })
    expect(talkOf(next.session).map(m => [m.who, !!m.dayTaken])).toEqual([['user', false], ['coach', true]])
    expect('coached' in next.session).toBe(false)
    // Taken once.
    expect(takeDay(s, next, 'q1.a', TODAY)).toBe(null)
    // Started, the workout says whose idea the day was.
    expect(preToStart(s, next, ['l'], TODAY, ME)).toBe(next.session)
  })

  it('the cards of earlier answers read as open again: what was taken of them went with the workout given up', () => {
    const s = state()
    const prep = asked(s, { ops: [{ op: 'skip', entry: 2, exId: LEG_EXT, why: 'w' }], flags: [{ entry: 1, exId: BENCH, flag: 'discomfort' }] })
    takeOp({ ...s, active: prep.session }, 'q1.a', 0)
    expect(talkOf(prep.session).at(-1)).toMatchObject({ taken: [0], marks: [{ flag: 'discomfort' }] })
    addQuestion(prep.session, { id: 'q2', text: 'Or another day?' })
    addAnswer(prep.session, 'q2', { reply: 'Light.', day: { do: 'train', routine: 'l', why: WHY } })
    const next = takeDay(s, prep, 'q2.a', TODAY).prep
    const first = talkOf(next.session).find(m => m.id === 'q1.a')
    expect('taken' in first).toBe(false)
    expect('marks' in first).toBe(false)
    expect(first.ops).toHaveLength(1)
    // Light has no leg extensions, so that card no longer fits; nothing of Heavy came along.
    expect(takeOp({ ...s, active: next.session }, 'q1.a', 0)).toBe(null)
    expect(next.session.entries.some(e => e.flags)).toBe(false)
  })

  it('changed a second time, it still stands in for what the plan held at first', () => {
    const s = state()
    const first = takeDay(s, asked(s, { day: { do: 'train', routine: 'l', why: WHY } }), 'q1.a', TODAY).prep
    addQuestion(first.session, { id: 'q2', text: 'Actually I feel fine.' })
    addAnswer(first.session, 'q2', { reply: 'Then Heavy.', day: { do: 'train', routine: 'h', why: 'They feel fine.' } })
    const second = takeDay(s, first, 'q2.a', TODAY).prep
    expect(s.dayPlan[TODAY]).toBe('h')
    expect(second.session.coachedDay).toEqual({ from: ['Heavy'], why: 'They feel fine.' })
  })

  it('rest calls today off', () => {
    const s = state()
    const prep = asked(s, { day: { do: 'rest', why: 'A fever (H3).' } })
    expect(takeDay(s, prep, 'q1.a', TODAY)).toEqual({ rest: true })
    expect(s.dayPlan).toEqual({ [TODAY]: 'rest' })
    expect(effectiveRoutineIds(s, TODAY, TODAY)).toEqual([])
    expect(canPrepare(s, TODAY)).toBe(false)
  })

  it('a suggestion that no longer fits writes nothing', () => {
    const day = { do: 'train', routine: 'l', why: WHY }
    const gone = state()
    const prep = asked(gone, { day })
    gone.routines = gone.routines.filter(r => r.id !== 'l')
    expect(fitDay(gone, prep.session, day)).toBe(null)
    expect(takeDay(gone, prep, 'q1.a', TODAY)).toBe(null)
    expect(gone.dayPlan).toEqual({})

    const emptied = state()
    emptied.routines[1].ex = []
    expect(fitDay(emptied, prep.session, day)).toBe(null)
    // Today holds it already.
    const same = state({ week: everyDay('l') })
    expect(fitDay(same, buildPre(same, TODAY, ME).session, day)).toBe(null)
    // A line with no day on it, a line that is not there, a workout under way.
    const s = state()
    const plain = asked(s, {})
    expect(takeDay(s, plain, 'q1.a', TODAY)).toBe(null)
    expect(takeDay(s, plain, 'nope', TODAY)).toBe(null)
    expect(fitDay(s, { ...plain.session, pre: false }, day)).toBe(null)
    expect(fitDay(s, plain.session, day)).toEqual({ do: 'train', routine: 'l', name: 'Light', why: WHY })
    expect(s.dayPlan).toEqual({})
  })
})

describe('what a finished workout keeps of it', () => {
  it('holds what the workout was trained in place of, read field by field', () => {
    expect(cleanCoachedDay({ from: [' Heavy ', 7, '', null, 'x'.repeat(500)], why: `  ${WHY}  `, SECRET: 'x' })).toEqual({ from: ['Heavy', 'x'.repeat(80)], why: WHY })
    expect(cleanCoachedDay({})).toEqual({ from: [] })
    for (const bad of [null, undefined, 'yes', 3]) expect(cleanCoachedDay(bad)).toBe(null)
  })

  it('is saved with the workout, and the server reads as much of it as the phone keeps', () => {
    const today = new Date().toISOString().slice(0, 10)
    const S = state()
    const active = {
      id: 'w9', d: today, start: Date.now() - 3600000, routineIds: ['l'], name: 'Light', bw: null, cur: 0,
      entries: buildCombinedEntries(S, ['l']).entries.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, done: true })) })),
      coachedDay: { from: ['A', 'B', 'C', 'D', 'E', 'F'], why: 'y'.repeat(500) },
    }
    const w = buildCompletedWorkout(active, { end: Date.now() })
    expect(w.coachedDay).toEqual({ from: ['A', 'B', 'C', 'D'], why: 'y'.repeat(DAY_WHY_CHARS) })
    expect(w.coachedDay.from).toHaveLength(DAY_FROM_MAX)
    const read = serverPayload.build({ ...S, workouts: [w] }, { handle: 'h'.repeat(16), kind: 'review' }).window.workouts[0]
    expect(read.coachedDay).toEqual(w.coachedDay)
    // A workout that was the plan's own has no such key.
    const { coachedDay, ...own } = active
    expect('coachedDay' in buildCompletedWorkout(own, { end: Date.now() })).toBe(false)
  })
})
