import { describe, it, expect } from 'vitest'
import {
  cleanCharter, saveCharter, adoptBlock, charterStatus, charterLine, targetChoices, hasCharter, addDays, daysApart,
  CHARTER_GOAL_MAX, CHARTER_OUTLINE_MAX, CHARTER_TARGETS_MAX, BLOCK_WEEKS_MAX
} from './coach-charter.js'
import { applyCreatedPlan } from './coach.js'

// The payload builder reads the charter out of the synced state and cuts it again, with limits
// of its own. Checked against the server's actual source, as coach.test.js does for the plan.
import * as serverPayload from '../../../api/coach/core/payload.js'

const HUGE = 'x'.repeat(50_000)
const state = (over = {}) => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {},
  routines: [{
    id: 'r1', name: 'Full body A',
    ex: [
      { id: '0025', sets: 3, reps: 8, mode: 'reps', weight: 60 },    // barbell bench press
      { id: '0001', sets: 3, reps: 10, mode: 'reps' },               // a bodyweight sit-up
      { id: '0007', sets: 3, sec: 45, mode: 'time' }
    ]
  }, { id: 'r2', name: 'Full body B', ex: [{ id: '0025', sets: 5, reps: 5, mode: 'reps', weight: 70 }, { id: '0043', sets: 3, reps: 16, mode: 'reps', weight: 20 }] }],
  week: { 1: ['r1'], 4: ['r2'] },
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: 1 }, profile: { goal: 'strength' }, log: [], snapshots: [] },
  ...over
})

describe('reading a charter', () => {
  it('keeps what a person set and nothing else', () => {
    const c = cleanCharter({
      goal: 'Squat 140', targets: [{ id: '0025', weight: 100, reps: 3, note: 'x' }], blockWeeks: 8,
      startedAt: '2026-10-07', checkpoint: '2026-12-02', outline: 'Build, then test.', updatedAt: 1, extra: HUGE
    })
    expect(c).toEqual({
      goal: 'Squat 140', targets: [{ id: '0025', weight: 100, reps: 3 }], blockWeeks: 8,
      startedAt: '2026-10-07', checkpoint: '2026-12-02', outline: 'Build, then test.'
    })
  })

  it('cuts every field to its limit and drops what is not what it should be', () => {
    const c = cleanCharter({
      goal: HUGE, outline: HUGE, blockWeeks: 999, startedAt: '2026-13-45', checkpoint: 'soon',
      targets: [
        ...[...Array(20)].map((_, i) => ({ id: 'e' + i, weight: 50 + i, reps: 5 })),
        { id: 'e0', weight: 999, reps: 1 }
      ]
    })
    expect(c.goal).toHaveLength(CHARTER_GOAL_MAX)
    expect(c.outline).toHaveLength(CHARTER_OUTLINE_MAX)
    expect(c.blockWeeks).toBe(BLOCK_WEEKS_MAX)
    expect(c.startedAt).toBeNull()
    expect(c.checkpoint).toBeNull()
    expect(c.targets).toHaveLength(CHARTER_TARGETS_MAX)

    const odd = cleanCharter({ goal: 7, outline: {}, blockWeeks: 'x', targets: [null, 'x', { id: 5, weight: 10 }, { id: 'a', weight: 0 }, { id: 'b', weight: '80', reps: 0 }, { id: 'b', weight: 90 }] })
    expect(odd).toEqual({ goal: '', targets: [{ id: 'b', weight: 80, reps: 1 }], blockWeeks: null, startedAt: null, checkpoint: null, outline: '' })
    expect(cleanCharter(null).targets).toEqual([])
    expect(hasCharter(cleanCharter(null))).toBe(false)
  })

  it('has the limits the payload builder cuts at', () => {
    expect(CHARTER_GOAL_MAX).toBe(serverPayload.CHARTER_GOAL_MAX)
    expect(CHARTER_OUTLINE_MAX).toBe(serverPayload.CHARTER_OUTLINE_MAX)
    expect(CHARTER_TARGETS_MAX).toBe(serverPayload.CHARTER_TARGETS_MAX)
    expect(BLOCK_WEEKS_MAX).toBe(serverPayload.BLOCK_WEEKS_MAX)
  })
})

describe('saving from the sheet', () => {
  it('starts a block today and puts the checkpoint at the end of its last week', () => {
    const s = state()
    saveCharter(s, { goal: '  Squat 140  ', blockWeeks: 8 }, '2026-10-07')
    expect(s.coach.charter).toMatchObject({ goal: 'Squat 140', blockWeeks: 8, startedAt: '2026-10-07', checkpoint: '2026-12-02' })
    expect(s.coach.charter.updatedAt).toBeGreaterThan(0)
  })

  it('leaves a start and a checkpoint that were already set where they are', () => {
    const s = state()
    saveCharter(s, { blockWeeks: 6, startedAt: '2026-09-01', checkpoint: '2026-11-01' }, '2026-10-07')
    expect(s.coach.charter).toMatchObject({ startedAt: '2026-09-01', checkpoint: '2026-11-01' })
  })

  it('stores an emptied charter as none, and makes room for itself in an old state', () => {
    const s = state()
    saveCharter(s, { goal: 'x' }, '2026-10-07')
    saveCharter(s, { goal: '   ', targets: [] }, '2026-10-07')
    expect(s.coach.charter).toBeNull()
    const bare = { routines: [] }
    saveCharter(bare, { goal: 'Run 10k' }, '2026-10-07')
    expect(bare.coach.charter.goal).toBe('Run 10k')
  })
})

describe('taking a plan starts a block', () => {
  const bundle = block => ({
    opengym_plan: 1, name: 'P', summary: 's', week: { 1: 'n1' }, ...(block ? { block } : {}),
    routines: [{ id: 'n1', name: 'New day', emoji: '💪', ex: [{ id: '0025', sets: 3, reps: 5, mode: 'reps' }] }],
    customEx: []
  })

  it('counts the proposed weeks from today and keeps the goal and the targets', () => {
    const s = state()
    saveCharter(s, { goal: 'Bench 100', targets: [{ id: '0025', weight: 100, reps: 1 }], blockWeeks: 4, startedAt: '2026-08-01' }, '2026-08-01')
    adoptBlock(s, { weeks: 8, outline: 'Six weeks up, one easy, one to test.' }, '2026-10-07')
    expect(s.coach.charter).toMatchObject({
      goal: 'Bench 100', targets: [{ id: '0025', weight: 100, reps: 1 }],
      blockWeeks: 8, startedAt: '2026-10-07', checkpoint: '2026-12-02', outline: 'Six weeks up, one easy, one to test.'
    })
  })

  it('leaves the charter alone when the plan came with no block, or one that cannot be read', () => {
    const s = state()
    saveCharter(s, { goal: 'Bench 100', blockWeeks: 4, startedAt: '2026-08-01' }, '2026-08-01')
    const before = JSON.stringify(s.coach.charter)
    for (const block of [undefined, null, 'eight weeks', {}, { weeks: '8' }, { weeks: 0 }, { weeks: 2.5 }]) expect(adoptBlock(s, block, '2026-10-07')).toBeNull()
    expect(JSON.stringify(s.coach.charter)).toBe(before)
    adoptBlock(s, { weeks: 500, outline: HUGE }, '2026-10-07')
    expect(s.coach.charter.blockWeeks).toBe(BLOCK_WEEKS_MAX)
    expect(s.coach.charter.outline).toHaveLength(CHARTER_OUTLINE_MAX)
  })

  it('happens when the plan is taken with its week, and not when only the routines are', () => {
    const taken = state()
    applyCreatedPlan(taken, { id: 'p1', kind: 'create', bundle: bundle({ weeks: 6, outline: 'o' }) }, { schedule: true })
    expect(taken.coach.charter).toMatchObject({ blockWeeks: 6, outline: 'o' })
    expect(daysApart(taken.coach.charter.startedAt, taken.coach.charter.checkpoint)).toBe(42)

    const routinesOnly = state()
    applyCreatedPlan(routinesOnly, { id: 'p1', kind: 'create', bundle: bundle({ weeks: 6, outline: 'o' }) }, { schedule: false })
    expect(routinesOnly.coach.charter).toBeUndefined()

    const noBlock = state()
    applyCreatedPlan(noBlock, { id: 'p1', kind: 'create', bundle: bundle() }, { schedule: true })
    expect(noBlock.coach.charter).toBeUndefined()
  })
})

describe('where today falls in the block', () => {
  const c = { blockWeeks: 8, startedAt: '2026-10-07', checkpoint: '2026-12-02' }

  it('counts weeks from the start and days to the checkpoint', () => {
    expect(charterStatus(c, '2026-10-07')).toEqual({ week: 1, daysLeft: 56, checkpointDue: false })
    expect(charterStatus(c, '2026-10-13')).toMatchObject({ week: 1 })
    expect(charterStatus(c, '2026-10-14')).toMatchObject({ week: 2 })
    expect(charterStatus(c, '2026-12-01')).toEqual({ week: 8, daysLeft: 1, checkpointDue: false })
    expect(charterStatus(c, '2026-12-02')).toEqual({ week: 9, daysLeft: 0, checkpointDue: true })
    expect(charterStatus(c, '2027-01-15')).toMatchObject({ checkpointDue: true })
  })

  it('says nothing it does not know', () => {
    expect(charterStatus(null, '2026-10-07')).toEqual({})
    expect(charterStatus({ goal: 'x' }, '2026-10-07')).toEqual({})
    expect(charterStatus({ startedAt: '2026-11-01' }, '2026-10-07')).toEqual({})   // a block that has not begun
    expect(charterStatus(c, 'today')).toEqual({})
  })

  it('does not lose or gain a day across a clock change', () => {
    expect(addDays('2026-10-07', 56)).toBe('2026-12-02')     // across the end of summer time
    expect(addDays('2027-03-01', 56)).toBe('2027-04-26')     // and across its start
    expect(daysApart('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('tells the phone and the model the same two facts', () => {
    const blocks = [c, { startedAt: '2026-10-07' }, { checkpoint: '2026-10-20' }, { startedAt: '2026-11-01', checkpoint: '2026-12-01' }, { startedAt: 'x', checkpoint: '2026-13-45' }, {}]
    const days = ['2026-10-06', '2026-10-07', '2026-10-13', '2026-10-14', '2026-10-20', '2026-12-02', '2027-02-01']
    for (const block of blocks) for (const today of days) {
      const { week, checkpointDue } = charterStatus(block, today)
      const ui = { ...(week ? { week } : {}), ...(checkpointDue != null ? { checkpointDue } : {}) }
      expect(serverPayload.charterProgress(block, today), JSON.stringify(block) + ' on ' + today).toEqual(ui)
    }
  })

  it('writes one line for the menu', () => {
    expect(charterLine(c, '2026-10-20')).toContain('2')
    expect(charterLine(c, '2026-10-20')).toContain('8')
    expect(charterLine(c, '2026-12-05')).toBe('Checkpoint reached — ask for a review')
    expect(charterLine({ goal: 'Squat 140' }, '2026-10-20')).toBe('Squat 140')
    expect(charterLine({ goal: 'g'.repeat(200) }, '2026-10-20')).toHaveLength(60)
    expect(charterLine(null, '2026-10-20')).toBe('What you are working toward, and when to take stock')
  })
})

describe('the lifts a target can be set on', () => {
  it('are the plan’s loaded rep exercises, each once', () => {
    expect(targetChoices(state())).toEqual([{ id: '0025', weight: 60, reps: 8 }, { id: '0043', weight: 20, reps: 16 }])
    expect(targetChoices({})).toEqual([])
  })
})

describe('what reaches the model', () => {
  const build = S => serverPayload.build(S, { handle: 'h'.repeat(16), kind: 'review' })

  it('is the charter the sheet saved, with the exercise named', () => {
    const s = state()
    saveCharter(s, { goal: 'Bench 100', targets: [{ id: '0025', weight: 100, reps: 1 }], blockWeeks: 8 }, '2026-10-07')
    const p = build(s)
    expect(p.charter).toMatchObject({
      goal: 'Bench 100', targets: [{ id: '0025', name: serverPayload.libraryName('0025'), weight: 100, reps: 1 }],
      blockWeeks: 8, startedAt: '2026-10-07', checkpoint: '2026-12-02'
    })
    expect('updatedAt' in p.charter).toBe(false)
  })

  it('is absent when there is none', () => {
    expect('charter' in build(state())).toBe(false)
    const s = state(); s.coach.charter = null
    expect('charter' in build(s)).toBe(false)
  })
})
