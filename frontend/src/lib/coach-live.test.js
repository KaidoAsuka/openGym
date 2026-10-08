import { describe, expect, it } from 'vitest'
import {
  TALK_MAX, COACHED_MAX, canAskLive, newTurnId, liveView, fitOp, applyLiveOp, opMoves, cleanCoached,
  talkOf, threadFor, openTurn, addQuestion, addAnswer, addFailure, takeOp, undoMarks,
} from './coach-live.js'
import { LIVE_OPS, LIVE_THREAD_LINES, LIVE_THREAD_CHARS, LIVE_WORK_SETS_MAX } from '../../../api/coach/core/live.js'
import * as serverPayload from '../../../api/coach/core/payload.js'
import { WEIGHT_ORIGIN_MANUAL, makeSideSet } from './workout-model.js'

// Real ids from the catalogue: the ops are checked against it, as on the server.
const SQUAT = '0043', BENCH = '0025', DB_BENCH = '0289', LEG_EXT = '0585', ROW = '0606', RUN = '0685'

const row = (w, r, done = false, over = {}) => ({ w, r, done, ...over })
const entry = (id, sets, over = {}) => ({ id, target: { mode: 'reps', sets: sets.filter(s => !s.warmup).length, reps: 5, weight: sets.at(-1)?.w || 0 }, sets, ...over })
// Squat with two of five sets done, then bench and leg extensions not started.
const session = (over = {}) => ({
  id: 'w1', d: '2026-10-08', name: 'Volume', start: Date.now() - 20 * 60000, cur: 0,
  entries: [
    entry(SQUAT, [row(60, 5, true, { warmup: true }), row(100, 5, true), row(100, 5, true), row(100, 5), row(100, 5), row(100, 5)]),
    entry(BENCH, [row(70, 5), row(70, 5), row(70, 5)]),
    entry(LEG_EXT, [row(40, 12), row(40, 12)], { target: { mode: 'reps', sets: 2, reps: 12, weight: 40 } }),
  ],
  ...over,
})
const state = (active = session(), over = {}) => ({ unit: 'kg', workouts: [], exWeights: {}, routines: [], active, ...over })
const op = (kind, at, exId, over = {}) => ({ op: kind, entry: at, exId, why: 'Second set at RPE 9.5 against a planned 8.', ...over })

describe('a workout that can be asked about', () => {
  it('is one under way: not a past one being filed, not a saved one in the editor, not an empty one', () => {
    expect(canAskLive(session())).toBe(true)
    expect(canAskLive(session({ backfill: { d: '2026-10-01' } }))).toBe(false)
    expect(canAskLive(session({ editingWorkoutId: 'w0' }))).toBe(false)
    expect(canAskLive(session({ entries: [] }))).toBe(false)
    expect(canAskLive(null)).toBe(false)
  })

  it('sends each question under an id the server takes', () => {
    for (let i = 0; i < 20; i++) expect(newTurnId()).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
  })

  // The server checked the answer against its own reading of this object; the phone checks the
  // tap against this one. They have to count the same sets.
  it('is read the way the server reads it', () => {
    const active = session()
    active.entries[2].flags = ['heavy']
    active.entries.push({ id: SQUAT, target: { mode: 'reps', sets: 1, reps: 16, side: true }, sets: [makeSideSet({ w: 20, r: 16 })] })
    active.entries.push({ id: BENCH, target: { mode: 'time', sets: 1, sec: 30 }, sets: [{ sec: 30, w: 0, done: false }] })
    const mine = liveView(active).entries
    const theirs = serverPayload.liveContext(state(active), active).entries
      .map(e => ({ entry: e.entry, id: e.id, mode: e.mode, ...(e.side ? { side: true } : {}), sets: e.sets.map(s => ({ done: s.done, ...(s.warmup ? { warmup: true } : {}), ...(s.w !== undefined ? { w: s.w } : {}), ...(s.r !== undefined ? { r: s.r } : {}), ...(s.sec !== undefined ? { sec: s.sec } : {}) })), ...(e.flags ? { flags: e.flags } : {}) }))
    expect(mine).toEqual(theirs)
  })
})

describe('the ops the Coach can suggest', () => {
  // One of each kind the server lets through. A kind added there and not here would be shown as a
  // card that does nothing when tapped.
  const ONE_OF_EACH = {
    'change-remaining': () => op('change-remaining', 0, SQUAT, { weight: 95 }),
    'remove-set': () => op('remove-set', 0, SQUAT),
    'add-set': () => op('add-set', 1, BENCH),
    swap: () => op('swap', 1, BENCH, { to: DB_BENCH }),
    skip: () => op('skip', 2, LEG_EXT),
  }
  it('are the ones the server lets through, and each of them is applied', () => {
    expect(Object.keys(ONE_OF_EACH).sort()).toEqual([...LIVE_OPS].sort())
    for (const kind of LIVE_OPS) {
      const st = state()
      const rec = applyLiveOp(st, ONE_OF_EACH[kind]())
      expect(rec, kind).toMatchObject({ op: kind })
      expect(st.active.coached).toEqual([rec])
    }
  })

  it('keeps as many of the ops that were taken as the Coach later reads', () => {
    expect(COACHED_MAX).toBe(serverPayload.COACHED_MAX)
  })

  describe('change-remaining', () => {
    it('moves the sets still to do and leaves the done ones and the warm-up alone', () => {
      const st = state()
      const rec = applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 95 }))
      expect(st.active.entries[0].sets.map(s => s.w)).toEqual([60, 100, 100, 95, 95, 95])
      expect(st.active.entries[0].sets.map(s => !!s.done)).toEqual([true, true, true, false, false, false])
      // Marked like a weight they typed, so correcting set 2 later does not run down over it.
      expect(st.active.entries[0].sets.map(s => s.weightOrigin)).toEqual([undefined, undefined, undefined, WEIGHT_ORIGIN_MANUAL, undefined, undefined])
      expect(rec).toEqual({ id: SQUAT, op: 'change-remaining', n: 3, w: 95, was: { w: 100 }, why: 'Second set at RPE 9.5 against a planned 8.' })
      // Today's target is not rewritten: the session is judged against the plan it opened with.
      expect(st.active.entries[0].target.weight).toBe(100)
    })

    it('sets reps and weight together', () => {
      const st = state()
      const rec = applyLiveOp(st, op('change-remaining', 1, BENCH, { weight: 65, reps: 4 }))
      expect(st.active.entries[1].sets).toEqual([{ w: 65, r: 4, done: false, weightOrigin: WEIGHT_ORIGIN_MANUAL }, row(65, 4), row(65, 4)])
      expect(rec).toMatchObject({ n: 3, w: 65, r: 4, was: { w: 70, r: 5 } })
    })

    it('splits a per-side exercise’s reps between the sides and leaves a side that is done', () => {
      const half = makeSideSet({ w: 20, r: 16 })
      half.sides.L.done = true
      const active = session({ entries: [{ id: SQUAT, target: { mode: 'reps', sets: 2, reps: 16, side: true, weight: 20 }, sets: [half, makeSideSet({ w: 20, r: 16 })] }] })
      const st = state(active)
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { reps: 12, weight: 17.5 }))).toBeTruthy()
      const [a, b] = st.active.entries[0].sets
      expect(a.sides.L).toMatchObject({ w: 20, r: 8, done: true })
      expect(a.sides.R).toMatchObject({ w: 17.5, r: 6, done: false })
      expect(b).toMatchObject({ r: 12, w: 17.5, sides: { L: { r: 6, w: 17.5 }, R: { r: 6, w: 17.5 } } })
      // An odd total would put a rep on one side and not the other: refused, as on the server.
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { reps: 11 }))).toBeNull()
    })

    it('sets a hold’s seconds, and the plan a displaced hold had put aside goes', () => {
      const active = session({ entries: [{ id: BENCH, target: { mode: 'time', sets: 2, sec: 45 }, sets: [{ sec: 45, w: 0, done: true }, { sec: 45, w: 0, done: false, planSec: 45 }] }] })
      const st = state(active)
      expect(applyLiveOp(st, op('change-remaining', 0, BENCH, { sec: 30 }))).toMatchObject({ sec: 30, was: { sec: 45 }, n: 1 })
      expect(st.active.entries[0].sets).toEqual([{ sec: 45, w: 0, done: true }, { sec: 30, w: 0, done: false }])
    })

    it('is not applied to sets that are already there, or when none is left', () => {
      const st = state()
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 100 }))).toBeNull()
      st.active.entries[0].sets.forEach(s => { s.done = true })
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 95 }))).toBeNull()
      expect(st.active.coached).toBeUndefined()
    })
  })

  describe('remove-set and add-set', () => {
    it('take sets off the end, never one that is done', () => {
      const st = state()
      expect(applyLiveOp(st, op('remove-set', 0, SQUAT, { count: 2 }))).toMatchObject({ op: 'remove-set', n: 2 })
      expect(st.active.entries[0].sets.map(s => !!s.done)).toEqual([true, true, true, false])
      // Three were left and one is; two more cannot go.
      expect(applyLiveOp(st, op('remove-set', 0, SQUAT, { count: 2 }))).toBeNull()
      // Not started at all: the last set is not taken, that is "skip".
      expect(applyLiveOp(st, op('remove-set', 1, BENCH, { count: 3 }))).toBeNull()
      expect(st.active.entries[1].sets).toHaveLength(3)
    })

    it('add a set at the numbers of the one before it, or at its own', () => {
      const st = state()
      expect(applyLiveOp(st, op('add-set', 1, BENCH))).toMatchObject({ op: 'add-set', n: 1 })
      expect(st.active.entries[1].sets).toHaveLength(4)
      expect(st.active.entries[1].sets[3]).toEqual(row(70, 5))
      const rec = applyLiveOp(st, op('add-set', 1, BENCH, { count: 2, weight: 60, reps: 8 }))
      expect(rec).toMatchObject({ n: 2, w: 60, r: 8 })
      expect(st.active.entries[1].sets.slice(4)).toEqual([row(60, 8), row(60, 8)])
    })

    it('do not take an exercise past the sets a plan may hold', () => {
      const st = state()
      st.active.entries[1].sets = Array.from({ length: LIVE_WORK_SETS_MAX }, () => row(70, 5))
      expect(applyLiveOp(st, op('add-set', 1, BENCH))).toBeNull()
    })

    it('add a per-side set as its two sides, and a per-side hold as its left and right rows', () => {
      const reps = session({ entries: [{ id: SQUAT, target: { mode: 'reps', sets: 1, reps: 16, side: true }, sets: [makeSideSet({ w: 20, r: 16 })] }] })
      const st = state(reps)
      applyLiveOp(st, op('add-set', 0, SQUAT))
      expect(st.active.entries[0].sets[1]).toMatchObject({ r: 16, w: 20, done: false, sides: { L: { r: 8, w: 20 }, R: { r: 8, w: 20 } } })

      const hold = session({ entries: [{ id: BENCH, target: { mode: 'time', sets: 2, sec: 30, side: true }, sets: [
        { sec: 30, w: 0, done: true, side: 'L' }, { sec: 30, w: 0, done: true, side: 'R' }, { sec: 30, w: 0, done: false, side: 'L' }, { sec: 30, w: 0, done: false, side: 'R' },
      ] }] })
      const st2 = state(hold)
      // The answer counted rows; one set of a per-side hold is the pair.
      applyLiveOp(st2, op('add-set', 0, BENCH, { count: 2 }))
      expect(st2.active.entries[0].sets.map(s => s.side)).toEqual(['L', 'R', 'L', 'R', 'L', 'R'])
      applyLiveOp(st2, op('remove-set', 0, BENCH, { count: 2 }))
      expect(st2.active.entries[0].sets.map(s => s.side)).toEqual(['L', 'R', 'L', 'R'])
    })

    it('add a cardio row like the one before it', () => {
      const active = session({ entries: [{ id: RUN, target: { sets: 1, min: 20, speed: 9 }, sets: [{ min: 20, speed: 9, done: true }] }] })
      const st = state(active)
      expect(applyLiveOp(st, op('add-set', 0, RUN))).toBeTruthy()
      expect(st.active.entries[0].sets[1]).toEqual({ min: 20, speed: 9, done: false })
    })
  })

  describe('skip', () => {
    it('takes an exercise that was not started out of the workout, and a mark on it stays behind', () => {
      const st = state(session({ cur: 2 }))
      st.active.entries[1].flags = ['equipment']
      st.active.entries[1].note = 'rack taken'
      expect(opMoves(st.active, op('skip', 1, BENCH))).toEqual({ at: 1, removes: true })
      expect(applyLiveOp(st, op('skip', 1, BENCH))).toMatchObject({ id: BENCH, op: 'skip', n: 3 })
      expect(st.active.entries.map(e => e.id)).toEqual([SQUAT, LEG_EXT])
      expect(st.active.skipped).toEqual([{ id: BENCH, flags: ['equipment'], note: 'rack taken' }])
      expect(st.active.cur).toBe(1)
    })

    it('keeps the sets that were done and drops the rest', () => {
      const st = state()
      expect(opMoves(st.active, op('skip', 0, SQUAT))).toBeNull()
      expect(applyLiveOp(st, op('skip', 0, SQUAT))).toMatchObject({ op: 'skip', n: 3 })
      expect(st.active.entries.map(e => e.id)).toEqual([SQUAT, BENCH, LEG_EXT])
      expect(st.active.entries[0].sets.map(s => s.w)).toEqual([60, 100, 100])
      // Nothing is left of it to skip a second time.
      expect(applyLiveOp(st, op('skip', 0, SQUAT))).toBeNull()
    })
  })

  describe('swap', () => {
    it('puts the new exercise in place of one not started, at the op’s numbers and the old one’s sets', () => {
      const st = state()
      expect(opMoves(st.active, op('swap', 1, BENCH, { to: DB_BENCH }))).toEqual({ at: 1, removes: false })
      const rec = applyLiveOp(st, op('swap', 1, BENCH, { to: DB_BENCH, weight: 25, reps: 8 }))
      expect(rec).toMatchObject({ id: BENCH, op: 'swap', to: DB_BENCH, w: 25, r: 8 })
      expect(st.active.entries.map(e => e.id)).toEqual([SQUAT, DB_BENCH, LEG_EXT])
      const work = st.active.entries[1].sets.filter(s => !s.warmup)
      expect(work.map(s => [s.w, s.r, !!s.done])).toEqual([[25, 8, false], [25, 8, false], [25, 8, false]])
      expect(st.active.entries[1].target).toMatchObject({ weight: 25, reps: 8, sets: 3 })
      expect(st.active.cur).toBe(1)
    })

    it('without numbers keeps the reps of what it replaces and takes the weight from their own history', () => {
      const past = { id: 'w0', d: '2026-10-01', start: 1, entries: [{ id: DB_BENCH, target: { mode: 'reps', sets: 3, reps: 10, weight: 22.5 }, sets: [row(22.5, 10, true), row(22.5, 10, true), row(22.5, 10, true)] }] }
      const st = state(session(), { workouts: [past], exWeights: { [DB_BENCH]: { w: 22.5 } } })
      expect(applyLiveOp(st, op('swap', 1, BENCH, { to: DB_BENCH }))).toMatchObject({ to: DB_BENCH })
      const work = st.active.entries[1].sets.filter(s => !s.warmup)
      expect(work).toHaveLength(3)
      expect(work.every(s => s.w === 22.5)).toBe(true)
    })

    it('leaves logged sets with the exercise they were done on and brings the new one in beside it', () => {
      const st = state()
      const rec = applyLiveOp(st, op('swap', 0, SQUAT, { to: ROW, weight: 50, reps: 10 }))
      expect(rec).toMatchObject({ id: SQUAT, op: 'swap', to: ROW })
      expect(st.active.entries.map(e => e.id)).toEqual([SQUAT, ROW, BENCH, LEG_EXT])
      // The squat keeps what was done; the three sets not started went with the swap.
      expect(st.active.entries[0].sets.map(s => !!s.done)).toEqual([true, true, true])
      // And the row is there for the three that were left.
      expect(st.active.entries[1].sets.filter(s => !s.warmup).map(s => [s.w, s.r])).toEqual([[50, 10], [50, 10], [50, 10]])
    })

    it('is refused for an exercise the workout already holds, one that does not exist, and itself', () => {
      const st = state()
      expect(applyLiveOp(st, op('swap', 1, BENCH, { to: LEG_EXT }))).toBeNull()
      expect(applyLiveOp(st, op('swap', 1, BENCH, { to: 'no-such-exercise' }))).toBeNull()
      expect(applyLiveOp(st, op('swap', 1, BENCH, { to: BENCH }))).toBeNull()
      expect(st.active.entries.map(e => e.id)).toEqual([SQUAT, BENCH, LEG_EXT])
    })

    it('builds the replacement by the routine’s rules when the slot is planned', () => {
      const routine = { id: 'r1', name: 'Volume', prog: 'off', ex: [{ id: BENCH, sets: 3, reps: 5, weight: 70 }] }
      const active = session()
      active.entries[1].rid = 'r1'
      const st = state(active, { routines: [routine] })
      expect(applyLiveOp(st, op('swap', 1, BENCH, { to: DB_BENCH, weight: 25 }))).toBeTruthy()
      expect(st.active.entries[1]).toMatchObject({ id: DB_BENCH, rid: 'r1' })
      expect(st.active.entries[1].sets.filter(s => !s.warmup).map(s => s.w)).toEqual([25, 25, 25])
    })
  })

  describe('checked again when tapped', () => {
    it('an op whose exercise is no longer there does nothing', () => {
      const st = state()
      st.active.entries[0] = entry(ROW, [row(50, 10)])
      expect(fitOp(st.active, op('change-remaining', 0, SQUAT, { weight: 95 }))).toBeNull()
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 95 }))).toBeNull()
    })

    it('an exercise that was moved is found again by its id', () => {
      const st = state()
      st.active.entries.reverse()   // leg extensions, bench, squat
      expect(fitOp(st.active, op('change-remaining', 0, SQUAT, { weight: 95 }))).toMatchObject({ entry: 2, exId: SQUAT, weight: 95 })
      applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 95 }))
      expect(st.active.entries[2].sets.map(s => s.w)).toEqual([60, 100, 100, 95, 95, 95])
    })

    it('unless the workout holds it twice and neither is where the op said', () => {
      const st = state()
      st.active.entries = [st.active.entries[1], st.active.entries[0], entry(SQUAT, [row(80, 8)])]
      expect(fitOp(st.active, op('change-remaining', 0, SQUAT, { weight: 95 }))).toBeNull()
      // Where the place and the id still agree, the op is that exercise's.
      expect(fitOp(st.active, op('change-remaining', 1, SQUAT, { weight: 95 }))).toMatchObject({ entry: 1 })
    })

    it('nothing is applied to a past workout being filed', () => {
      const st = state(session({ backfill: { d: '2026-10-01' } }))
      expect(applyLiveOp(st, op('change-remaining', 0, SQUAT, { weight: 95 }))).toBeNull()
    })

    it('an op of a kind this build does not know is not one', () => {
      expect(fitOp(session(), op('double-everything', 0, SQUAT))).toBeNull()
    })
  })
})

describe('what a finished workout keeps of it', () => {
  it('holds the latest few, each read field by field', () => {
    const st = state()
    for (let i = 0; i < COACHED_MAX + 3; i++) applyLiveOp(st, op('change-remaining', 1, BENCH, { weight: 40 + i }))
    expect(st.active.coached).toHaveLength(COACHED_MAX)
    expect(st.active.coached.at(-1)).toMatchObject({ w: 40 + COACHED_MAX + 2 })

    expect(cleanCoached([
      { id: SQUAT, op: 'change-remaining', n: 3, w: 95, was: { w: 100, x: 1 }, why: ' heavy ', extra: true },
      { id: BENCH, op: 'swap', to: DB_BENCH, r: 8 },
      { id: BENCH, op: 'swap', to: 'no-such-exercise' },
      { id: BENCH, op: 'made-up' },
      { op: 'skip' },
      null, 'skip',
      { id: LEG_EXT, op: 'skip', n: 99, w: -5, why: 'x'.repeat(500) },
    ])).toEqual([
      { id: SQUAT, op: 'change-remaining', n: 3, w: 95, was: { w: 100 }, why: 'heavy' },
      { id: BENCH, op: 'swap', r: 8, to: DB_BENCH },
      { id: LEG_EXT, op: 'skip', why: 'x'.repeat(200) },
    ])
    expect(cleanCoached(undefined)).toEqual([])
  })
})

describe('what was said in a workout', () => {
  const answer = (over = {}) => ({
    id: 'a1', reply: 'Take the last three sets at 95 kg.',
    ops: [op('change-remaining', 0, SQUAT, { weight: 95 })],
    flags: [{ entry: 0, exId: SQUAT, flag: 'heavy' }],
    ...over,
  })

  it('is kept on the workout: their question, then the answer with its ops and the marks it set', () => {
    const active = session()
    expect(addQuestion(active, { id: 'q1', text: '  The second set nearly did not come up.  ', focus: 0, at: 5 })).toEqual({ id: 'q1', who: 'user', text: 'The second set nearly did not come up.', at: 5, focus: 0 })
    expect(openTurn(active)).toMatchObject({ id: 'q1' })
    const line = addAnswer(active, 'q1', answer(), 9)
    expect(line).toEqual({ id: 'q1.a', turn: 'q1', who: 'coach', at: 9, text: 'Take the last three sets at 95 kg.', ops: answer().ops, marks: [{ entry: 0, exId: SQUAT, flag: 'heavy' }] })
    expect(openTurn(active)).toBeNull()
    // The mark is what they said about the exercise, written down for them.
    expect(active.entries[0].flags).toEqual(['heavy'])
    // The op is only kept: nothing about the sets moved.
    expect(active.entries[0].sets.map(s => s.w)).toEqual([60, 100, 100, 100, 100, 100])
    expect(talkOf(active)).toHaveLength(2)
  })

  it('an empty question, or one about a workout that cannot be asked about, is not kept', () => {
    expect(addQuestion(session(), { id: 'q1', text: '   ' })).toBeNull()
    expect(addQuestion(session({ backfill: {} }), { id: 'q1', text: 'hello' })).toBeNull()
  })

  it('a question sent twice is answered once, and an answer to another workout’s question is dropped', () => {
    const active = session()
    addQuestion(active, { id: 'q1', text: 'heavy' })
    expect(addAnswer(active, 'q1', answer())).toBeTruthy()
    expect(addAnswer(active, 'q1', answer({ reply: 'again' }))).toBeNull()
    expect(addAnswer(active, 'q9', answer())).toBeNull()
    expect(talkOf(active)).toHaveLength(2)
  })

  it('a mark is set on the exercise as it stands now, once, and can be taken off again', () => {
    const active = session()
    active.entries.reverse()   // the squat is third now
    active.entries[2].flags = ['pain']
    addQuestion(active, { id: 'q1', text: 'heavy' })
    const line = addAnswer(active, 'q1', answer({ flags: [{ entry: 0, exId: SQUAT, flag: 'heavy' }, { entry: 0, exId: SQUAT, flag: 'pain' }, { entry: 1, exId: 'gone', flag: 'time' }, { entry: 1, exId: BENCH, flag: 'nonsense' }] }))
    expect(line.marks).toEqual([{ entry: 2, exId: SQUAT, flag: 'heavy' }])
    expect(active.entries[2].flags).toEqual(['pain', 'heavy'])
    expect(undoMarks(active, 'q1.a')).toBe(true)
    // Only the one the answer set: theirs stays.
    expect(active.entries[2].flags).toEqual(['pain'])
    expect(talkOf(active).at(-1).marksOff).toBe(true)
    expect(undoMarks(active, 'q1.a')).toBe(false)
  })

  it('a failure stands in for the answer, is replaced by asking again, and gives way to the answer', () => {
    const active = session()
    addQuestion(active, { id: 'q1', text: 'heavy' })
    expect(addFailure(active, 'q1', 'timeout', null, 3)).toEqual({ id: 'q1.e', turn: 'q1', who: 'coach', at: 3, error: 'timeout' })
    expect(openTurn(active)).toBeNull()
    addFailure(active, 'q1', 'provider', 'quota exceeded')
    expect(talkOf(active).filter(m => m.error)).toEqual([expect.objectContaining({ error: 'provider', detail: 'quota exceeded' })])
    expect(addAnswer(active, 'q1', answer())).toBeTruthy()
    expect(talkOf(active).some(m => m.error)).toBe(false)
    // Once answered, a late failure of the same turn is not written.
    expect(addFailure(active, 'q1', 'timeout')).toBeNull()
  })

  it('the next question carries what was answered, cut as the server cuts it', () => {
    const active = session()
    addQuestion(active, { id: 'q0', text: 'lost on the way' })
    addFailure(active, 'q0', 'timeout')
    for (let i = 1; i <= 6; i++) {
      addQuestion(active, { id: 'q' + i, text: 'question ' + i + ' ' + 'x'.repeat(600) })
      addAnswer(active, 'q' + i, { reply: 'answer ' + i })
    }
    addQuestion(active, { id: 'q7', text: 'still waiting' })
    const thread = threadFor(active)
    expect(thread).toHaveLength(LIVE_THREAD_LINES)
    expect(thread.at(-1)).toEqual({ who: 'coach', text: 'answer 6' })
    expect(thread.at(-2).who).toBe('user')
    expect(thread.at(-2).text).toHaveLength(LIVE_THREAD_CHARS)
    expect(thread.some(m => /lost on the way|still waiting/.test(m.text))).toBe(false)
  })

  it('holds a workout’s worth of lines and lets the oldest go', () => {
    const active = session()
    for (let i = 0; i < TALK_MAX; i++) { addQuestion(active, { id: 'q' + i, text: 'q' + i }); addAnswer(active, 'q' + i, { reply: 'a' + i }) }
    expect(talkOf(active)).toHaveLength(TALK_MAX)
    expect(talkOf(active).at(-1).text).toBe('a' + (TALK_MAX - 1))
  })

  it('an op is taken once, and the line remembers it', () => {
    const st = state()
    addQuestion(st.active, { id: 'q1', text: 'heavy' })
    addAnswer(st.active, 'q1', answer({ ops: [op('change-remaining', 0, SQUAT, { weight: 95 }), op('remove-set', 0, SQUAT)] }))
    expect(takeOp(st, 'q1.a', 0)).toMatchObject({ op: 'change-remaining', w: 95 })
    expect(takeOp(st, 'q1.a', 0)).toBeNull()
    expect(takeOp(st, 'q1.a', 1)).toMatchObject({ op: 'remove-set' })
    expect(takeOp(st, 'q1.a', 5)).toBeNull()
    expect(talkOf(st.active).at(-1).taken).toEqual([0, 1])
    expect(st.active.entries[0].sets.map(s => s.w)).toEqual([60, 100, 100, 95, 95])
    expect(st.active.coached.map(c => c.op)).toEqual(['change-remaining', 'remove-set'])
  })
})
