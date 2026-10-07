import { describe, it, expect, vi } from 'vitest'
import {
  adoptCycle, projectCycle, cycleWeek, cycleOver, cycleStale, freshLooks, applyLooks, undoLook, undoable, lookEntry,
  cycleView, bundleCycleView, CYCLE_HISTORY_MAX, CYCLE_APPLIED_MAX
} from './coach-cycle.js'
import { applyCreatedPlan, revertLast, planHash, CONSENT_VERSION } from './coach.js'
import { demoPlan, demoStatus, demoResolve } from './coach-demo.js'

// The server reads the same state and checks the Coach's answers against it. Held against its
// own source, so the week the phone lays out is the week the server thinks is being trained.
import { planAt, baseOf } from '../../../api/coach/core/cycle.js'
import * as serverPayload from '../../../api/coach/core/payload.js'
import { validatePlan, validateAdjust } from '../../../api/coach/core/validate.js'

const SQUAT = '0043', BENCH = '0025', HOLD = '0001'
const day = n => new Date(Date.parse('2026-10-05T12:00:00Z') + n * 864e5).toISOString().slice(0, 10)   // a Monday

// What the validator hands over for a plan whose weeks differ.
const ANSWER = {
  coach_contract: 1, name: 'Six weeks of squats', summary: 's', basedOn: 'b', program: 'russian-squat-routine',
  block: { weeks: 6, outline: 'Six weeks.' },
  routines: [
    { id: 'r1', name: 'Day A', prog: 'linear', ex: [{ id: SQUAT, sets: 6, reps: 2, prog: 'linear' }] },
    { id: 'r2', name: 'Day B', prog: 'linear', ex: [{ id: SQUAT, sets: 6, reps: 3 }, { id: BENCH, sets: 3, reps: 8, prog: 'double', repsMin: 6 }, { id: 'cx1', sets: 2, sec: 30, mode: 'time' }] }
  ],
  customEx: [{ id: 'cx1', n: 'Sandbag hold', bp: 'waist' }],
  week: { 1: 'r1', 3: 'r2', 5: 'r1' },
  cycle: [
    { week: 1, focus: 'Start at 80.', sessions: [{ routine: 'r1', ex: [{ id: SQUAT, weight: 80 }] }, { routine: 'r2', ex: [{ id: SQUAT, weight: 80 }, { id: 'cx1', sec: 40 }] }] },
    { week: 2, focus: 'Fives.', sessions: [{ routine: 'r2', ex: [{ id: SQUAT, reps: 5 }] }] },
    { week: 4, focus: 'Heavier.', sessions: [{ routine: 'r2', ex: [{ id: SQUAT, sets: 5, reps: 5, weight: 85 }] }] },
    { week: 6, focus: 'Test.' }
  ]
}
const bundle = () => { const r = validatePlan(ANSWER, { programIds: ['russian-squat-routine'], workingWeights: [{ id: SQUAT, best: 80 }] }); if (!r.ok) throw new Error(r.errors.join('\n')); return r.bundle }
const fresh = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {},
  routines: [{ id: 'old', name: 'Old routine', ex: [{ id: BENCH, sets: 3, reps: 10 }] }], week: { 2: ['old'] },
  coach: { consent: { agreedAt: 'x', version: CONSENT_VERSION }, profile: { goal: 'strength', experience: 'regular', daysPerWeek: 3, sessionMin: 60, equipment: [] }, log: [], snapshots: [], chat: [] }
})
// A state with the plan imported on a Monday, the way the plan card does it.
const running = (today = day(0)) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(today + 'T12:00:00Z'))
  try {
    const s = fresh()
    const b = bundle()
    applyCreatedPlan(s, { id: 'p1', kind: 'create', bundle: b, summary: b.summary, planHash: planHash(s) }, { schedule: true })
    return s
  } finally { vi.useRealTimers() }
}
const rt = (s, name) => s.routines.find(r => r.name === name)
const ex = (s, name, id) => rt(s, name).ex.find(e => e.id === id)

describe('taking a cycle on', () => {
  it('keeps the weeks under the plan\'s own ids, the ones the import gave', () => {
    const s = running()
    const c = s.coach.cycle
    const a = rt(s, 'Day A'), b = rt(s, 'Day B')
    expect(c.routines).toEqual([a.id, b.id])
    expect(a.id).not.toBe('r1')
    const hold = b.ex[2].id
    expect(hold).not.toBe('cx1')                       // an exercise the plan invented got an id of its own
    expect(c.plan[0].sessions).toEqual([
      { routine: a.id, ex: [{ weight: 80, id: SQUAT }] },
      { routine: b.id, ex: [{ weight: 80, id: SQUAT }, { sec: 40, id: hold }] }
    ])
    expect(c.plan.map(w => w.week)).toEqual([1, 2, 4, 6])
    expect({ id: c.id, weeks: c.weeks, startedAt: c.startedAt, program: c.program, projected: c.projected })
      .toEqual({ id: 'p1', weeks: 6, startedAt: day(0), program: { id: 'russian-squat-routine', name: 'Russian Squat Routine' }, projected: 1 })
    // What the routines held when it began, and the policy each exercise was planned with.
    expect(c.base[b.id][BENCH]).toEqual({ sets: 3, reps: 8, prog: 'double' })
    expect(c.base[a.id][SQUAT]).toEqual({ sets: 6, reps: 2, prog: 'linear' })
  })

  it('lays the first week out: a weight the cycle sets switches the app\'s own progression off', () => {
    const s = running()
    expect(ex(s, 'Day A', SQUAT)).toMatchObject({ sets: 6, reps: 2, weight: 80, prog: 'off' })
    expect(ex(s, 'Day B', SQUAT)).toMatchObject({ sets: 6, reps: 3, weight: 80, prog: 'off' })
    // No weight from the cycle: the policy it was planned with still runs it.
    expect(ex(s, 'Day B', BENCH)).toMatchObject({ sets: 3, reps: 8, prog: 'double' })
    expect(ex(s, 'Day B', BENCH).weight).toBeUndefined()
    expect(rt(s, 'Day B').ex[2]).toMatchObject({ sets: 2, sec: 40 })
    // A routine that is not the cycle's is left exactly as it was.
    expect(rt(s, 'Old routine').ex[0]).toEqual({ id: BENCH, sets: 3, reps: 10 })
  })

  it('only a plan taken with its week starts a cycle; a plan that repeats one week ends the one before', () => {
    const loose = fresh()
    applyCreatedPlan(loose, { id: 'p1', kind: 'create', bundle: bundle(), planHash: planHash(loose) }, { schedule: false })
    expect(loose.coach.cycle).toBeUndefined()
    const s = running()
    const { cycle, ...flat } = bundle()
    applyCreatedPlan(s, { id: 'p2', kind: 'create', bundle: flat, planHash: planHash(s) }, { schedule: true })
    expect(s.coach.cycle).toBeNull()
  })

  it('undoing the import takes the cycle with it', () => {
    const s = running()
    expect(revertLast(s)).toBe(true)
    expect(s.coach.cycle).toBeNull()
    expect(s.routines.map(r => r.name)).toEqual(['Old routine'])
  })
})

describe('which week it is, and laying it out', () => {
  it('counts whole weeks from the day the plan was imported, and stops at the last', () => {
    const s = running()
    expect([cycleWeek(s, day(0)), cycleWeek(s, day(6)), cycleWeek(s, day(7)), cycleWeek(s, day(41)), cycleWeek(s, day(60))]).toEqual([1, 1, 2, 6, 6])
    expect([cycleOver(s, day(41)), cycleOver(s, day(42))]).toEqual([false, true])
    expect(cycleWeek(fresh(), day(0))).toBeNull()
  })

  it('writes the new week\'s numbers when the week has turned, and nothing when it has not', () => {
    const s = running()
    expect(cycleStale(s, day(3))).toBe(false)
    expect(projectCycle(s, day(3))).toBe(false)
    expect(cycleStale(s, day(7))).toBe(true)
    expect(projectCycle(s, day(7))).toBe(true)
    expect(ex(s, 'Day B', SQUAT)).toMatchObject({ sets: 6, reps: 5, weight: 80, prog: 'off' })   // week two: fives
    expect(projectCycle(s, day(15))).toBe(true)
    expect(ex(s, 'Day B', SQUAT)).toMatchObject({ sets: 6, reps: 5, weight: 80 })                // week three says nothing: as week two
    projectCycle(s, day(22))
    expect(ex(s, 'Day B', SQUAT)).toMatchObject({ sets: 5, reps: 5, weight: 85 })                // week four
    expect(s.coach.cycle.projected).toBe(4)
  })

  it('the week the phone lays out is the week the server reads', () => {
    const s = running()
    for (const n of [1, 2, 3, 4, 6]) {
      projectCycle(s, day((n - 1) * 7), true)
      const c = s.coach.cycle
      const theirs = planAt({ routines: s.routines.filter(r => c.routines.includes(r.id)) }, c.base, c.plan, n)
      for (const r of theirs.routines) for (const e of r.ex) {
        const mine = s.routines.find(x => x.id === r.id).ex.find(x => x.id === e.id)
        expect([n, r.name, mine.sets, mine.reps, mine.sec, mine.weight]).toEqual([n, r.name, e.sets, e.reps, e.sec, e.weight])
      }
    }
    // And what the server makes of the synced state is the same cycle.
    vi.useFakeTimers(); vi.setSystemTime(new Date(day(8) + 'T12:00:00Z'))
    try {
      const ctx = serverPayload.cycleContext(s)
      expect([ctx.weeks, ctx.week, ctx.routines.map(r => r.name)]).toEqual([6, 2, ['Day A', 'Day B']])
      expect(ctx.plan).toEqual(s.coach.cycle.plan)
    } finally { vi.useRealTimers() }
  })

  it('an exercise that joined a routine since becomes the cycle\'s from there on', () => {
    const s = running()
    rt(s, 'Day A').ex.push({ id: BENCH, sets: 4, reps: 6, prog: 'double' })
    projectCycle(s, day(7))
    expect(s.coach.cycle.base[rt(s, 'Day A').id][BENCH]).toEqual({ sets: 4, reps: 6, prog: 'double' })
    expect(ex(s, 'Day A', BENCH)).toEqual({ id: BENCH, sets: 4, reps: 6, prog: 'double' })
  })
})

describe('the Coach\'s corrections', () => {
  const look = (s, over = {}) => ({
    id: 'l1', cycle: 'p1', at: 1000, week: 1, summary: 'Two sets missed at 80; a step back.',
    changes: [{ week: 2, routine: rt(s, 'Day B').id, exId: SQUAT, weight: 77.5, reps: 4, why: 'Two of six sets missed.' }], ...over
  })

  it('a look the server would pass is one the phone can apply', () => {
    const s = running()
    vi.useFakeTimers(); vi.setSystemTime(new Date(day(1) + 'T12:00:00Z'))
    try {
      const checked = validateAdjust({ coach_contract: 1, summary: 's', changes: look(s).changes }, { cycle: serverPayload.cycleContext(s), sessionMin: 60 })
      expect(checked.ok).toBe(true)
      expect(applyLooks(s, [{ id: 'l1', cycle: 'p1', at: 1, ...checked.proposal }], day(1))).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('takes a look in once: the weeks change, the card knows what moved, the week under way is laid out again', () => {
    const s = running()
    const b = rt(s, 'Day B').id
    expect(freshLooks(s, [look(s)])).toHaveLength(1)
    const done = applyLooks(s, [look(s), look(s, { id: 'l2', changes: [{ week: 1, routine: b, exId: SQUAT, sets: 5, why: 'Short on time.' }] })], day(2))
    expect(done.map(d => [d.id, d.changes])).toEqual([['l1', 1], ['l2', 1]])
    const c = s.coach.cycle
    expect(c.applied).toEqual(['l1', 'l2'])
    expect(c.plan.find(w => w.week === 2).sessions[0].ex[0]).toEqual({ weight: 77.5, id: SQUAT, reps: 4 })
    expect(lookEntry(s, 'l1').changes[0]).toMatchObject({ week: 2, exId: SQUAT, weight: 77.5, reps: 4, why: 'Two of six sets missed.', before: { sets: 6, reps: 5, weight: 80 } })
    // The second one changed this week, so the routine holds it now.
    expect(ex(s, 'Day B', SQUAT)).toMatchObject({ sets: 5, reps: 3, weight: 80 })
    expect(c.lastCheck.reading).toBe('Two sets missed at 80; a step back.')
    // Handed over again on the next poll, it is not applied again.
    expect(freshLooks(s, [look(s)])).toEqual([])
    expect(applyLooks(s, [look(s)], day(2))).toEqual([])
    expect(c.history).toHaveLength(2)
  })

  it('"the plan stands" is kept as what was said and changes nothing', () => {
    const s = running()
    const before = JSON.stringify(s.coach.cycle.plan)
    const done = applyLooks(s, [{ id: 'n1', cycle: 'p1', at: 5, nochange: true, reading: 'Every set made.', manual: true }], day(1))
    expect(done).toEqual([{ id: 'n1', nochange: true, manual: true, reading: 'Every set made.' }])
    expect(JSON.stringify(s.coach.cycle.plan)).toBe(before)
    expect(s.coach.cycle.lastCheck).toEqual({ at: 5, reading: 'Every set made.' })
    expect(s.coach.cycle.history).toEqual([])
  })

  it('takes nothing that is not for this cycle, or not for an exercise it still has', () => {
    const s = running()
    expect(applyLooks(s, [look(s, { cycle: 'another' }), null, 'x', { id: 'l9' }], day(1))).toEqual([])
    rt(s, 'Day B').ex = rt(s, 'Day B').ex.filter(e => e.id !== SQUAT)             // swapped out since the server looked
    expect(applyLooks(s, [look(s)], day(1))).toEqual([])
    expect(s.coach.cycle.applied).toEqual(['l1'])                                  // seen, so the server lets go of it
    expect(applyLooks(fresh(), [look(s)], day(1))).toEqual([])
  })

  it('the latest correction can be taken back, once', () => {
    const s = running()
    const b = rt(s, 'Day B').id
    const before = JSON.stringify(s.coach.cycle.plan)
    applyLooks(s, [look(s, { changes: [{ week: 1, routine: b, exId: SQUAT, weight: 75, why: 'w' }] })], day(1))
    expect(ex(s, 'Day B', SQUAT).weight).toBe(75)
    expect(undoable(s)?.id).toBe('l1')
    expect(undoLook(s, 'someone-else', day(1))).toBe(false)
    expect(undoLook(s, 'l1', day(1))).toBe(true)
    expect(JSON.stringify(s.coach.cycle.plan)).toBe(before)
    expect(ex(s, 'Day B', SQUAT).weight).toBe(80)
    expect(lookEntry(s, 'l1').undone).toBe(true)
    expect(undoable(s)).toBeNull()
    expect(undoLook(s, 'l1', day(1))).toBe(false)
    // An earlier one cannot be taken back past a later one: only the latest keeps the weeks as they were.
    applyLooks(s, [look(s, { id: 'l2' }), look(s, { id: 'l3', changes: [{ week: 3, routine: b, exId: SQUAT, weight: 70, why: 'w' }] })], day(1))
    expect(lookEntry(s, 'l2').prev).toBeUndefined()
    expect(undoable(s).id).toBe('l3')
  })

  it('keeps a bounded history and a bounded list of what it has seen', () => {
    const s = running()
    const b = rt(s, 'Day B').id
    const many = [...Array(CYCLE_APPLIED_MAX + 15)].map((_, i) => look(s, { id: 'm' + i, changes: [{ week: 2, routine: b, exId: SQUAT, weight: 60 + i, why: 'w' }] }))
    applyLooks(s, many, day(1))
    expect(s.coach.cycle.history).toHaveLength(CYCLE_HISTORY_MAX)
    expect(s.coach.cycle.applied).toHaveLength(CYCLE_APPLIED_MAX)
    expect(s.coach.cycle.history.filter(h => h.prev)).toHaveLength(1)
    expect(JSON.stringify(s.coach.cycle).length).toBeLessThan(20000)
  })
})

describe('for the screens', () => {
  it('a running cycle: every week, what it is for, and each routine at that week\'s numbers', () => {
    const s = running()
    const v = cycleView(s, day(8))
    expect([v.weeks, v.week, v.over, v.program]).toEqual([6, 2, false, 'Russian Squat Routine'])
    expect(v.rows.map(w => [w.week, w.focus, w.current, w.rough])).toEqual([
      [1, 'Start at 80.', false, false], [2, 'Fives.', true, false], [3, '', false, true], [4, 'Heavier.', false, false], [5, '', false, true], [6, 'Test.', false, true]
    ])
    expect(v.rows[3].sessions[1].ex[0]).toMatchObject({ id: SQUAT, name: 'barbell full squat', sets: 5, reps: 5, weight: 85 })
    expect(v.rows[2].sessions[1].ex[0]).toMatchObject({ sets: 6, reps: 5, weight: 80 })
    expect(cycleView(fresh())).toBeNull()
  })

  it('a plan still waiting is shown the same way, from the bundle alone', () => {
    const v = bundleCycleView(bundle())
    expect(v.weeks).toBe(6)
    expect(v.rows[0].sessions.map(x => x.name)).toEqual(['Day A', 'Day B'])
    expect(v.rows[1].sessions[1].ex[0]).toMatchObject({ sets: 6, reps: 5, weight: 80 })
    expect(v.rows.every(w => w.current === false)).toBe(true)
    expect(bundleCycleView({ routines: [] })).toBeNull()
  })

  it('the demo plan carries a cycle, and once it runs the demo hands over a look that can be applied and undone', () => {
    vi.useFakeTimers()
    try {
      const s = fresh()
      demoPlan(s, null); vi.advanceTimersByTime(2200)
      const p = demoStatus(s).pending
      demoResolve()
      expect(bundleCycleView(p.bundle).rows).toHaveLength(4)
      applyCreatedPlan(s, p, { schedule: true })
      expect(s.coach.cycle.weeks).toBe(4)
      const looks = demoStatus(s).adjustments
      expect(looks).toHaveLength(1)
      const first = s.routines.find(r => r.id === s.coach.cycle.routines[0]).ex[0]
      expect(applyLooks(s, looks)).toHaveLength(1)
      expect(s.coach.cycle.plan.find(w => w.week === 2).sessions[0].ex[0].reps).toBe(first.reps + 2)
      expect(demoStatus(s).adjustments.filter(a => !s.coach.cycle.applied.includes(a.id))).toEqual([])
      expect(undoLook(s, looks[0].id)).toBe(true)
    } finally { vi.useRealTimers() }
  })
})

// Kept honest against the server's count of a base (api/coach/core/cycle.js baseOf).
it('the base the phone keeps is the routines\' numbers, as the server would read them', () => {
  const s = running()
  const c = s.coach.cycle
  const numbers = o => Object.fromEntries(Object.entries(o).map(([k, v]) => { const { prog, ...n } = v; return [k, n] }))
  // Taken before the first week was laid out, so it is the routines as imported: no weights yet.
  expect(numbers(c.base[rt(s, 'Day B').id])[BENCH]).toEqual(baseOf([{ id: 'x', ex: [{ id: BENCH, sets: 3, reps: 8 }] }]).x[BENCH])
  expect(HOLD).toBe('0001')
})
