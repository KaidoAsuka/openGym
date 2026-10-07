import { describe, it, expect } from 'vitest'
import { applyChangeSet, CONSENT_VERSION } from './coach.js'

// The server counts what a review's changes add up to before anyone sees them
// (api/coach/core/plan-load.js projectPlan): work sets by body part, minutes by training day.
// It does that by applying the changes to a copy of the plan itself, since the phone is not
// there to ask. This file runs the phone's own apply beside it, one change type at a time, and
// holds the two counts together. A type that moves a count on one side and not on the other
// would let a change-set past a limit, or refuse one that is inside it.
import { planLoad, projectPlan } from '../../../api/coach/core/plan-load.js'
import { cleanPlan } from '../../../api/coach/core/payload.js'
import { validateReview, CHANGE_TYPES } from '../../../api/coach/core/validate.js'

const state = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {},
  routines: [{
    id: 'r1', name: 'Upper', emoji: '💪', prog: 'linear',
    ex: [
      { id: '0025', sets: 4, reps: 8, mode: 'reps' },             // bench press — chest
      { id: '0027', sets: 3, reps: 8, mode: 'reps', sg: 'p' },    // bent-over row — back
      { id: '0031', sets: 3, reps: 12, mode: 'reps', sg: 'p' },   // curl — upper arms
      { id: '0001', sets: 3, sec: 30, mode: 'time' },             // sit-up as a hold — waist
      { id: '1160', sets: 1, min: 10, speed: 8, mode: 'cardio' }  // burpee — cardio
    ]
  }, {
    id: 'r2', name: 'Lower', ex: [{ id: '0043', sets: 4, reps: 5, mode: 'reps' }, { id: '0594', sets: 3, reps: 15, mode: 'reps' }]
  }, {
    id: 'r3', name: 'Spare', ex: [{ id: '0091', sets: 5, reps: 5, mode: 'reps' }]
  }],
  week: { 1: ['r1'], 3: ['r2'], 5: ['r1', 'r2'] },
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, log: [], snapshots: [], cadence: 'off' }
})

// One well-formed change of every type the validator allows, each against the state above.
const CASES = {
  'add-exercise': [
    { target: { routineId: 'r1' }, after: { id: '0308', sets: 2, reps: 12, mode: 'reps', position: 2 } },
    { target: { routineId: 'r2' }, after: { id: '0001', mode: 'time' } },
    { target: { routineId: 'r2' }, after: { id: '1160', mode: 'cardio' } }
  ],
  'remove-exercise': [{ target: { routineId: 'r1', exId: '0031' } }, { target: { routineId: 'r2', exId: '0043' } }],
  'swap-exercise': [{ target: { routineId: 'r1', exId: '0025' }, after: { id: '0091' } }, { target: { routineId: 'r1', exId: '0027' }, after: { id: '0652', sets: 5 } }],
  sets: [{ target: { routineId: 'r1', exId: '0025' }, after: 6 }, { target: { routineId: 'r3', exId: '0091' }, after: 2 }],
  reps: [{ target: { routineId: 'r1', exId: '0025' }, after: 10 }],
  repsMin: [{ target: { routineId: 'r1', exId: '0025' }, after: 6 }],
  repsMax: [{ target: { routineId: 'r1', exId: '0025' }, after: 12 }],
  sec: [{ target: { routineId: 'r1', exId: '0001' }, after: 90 }],
  cardio: [{ target: { routineId: 'r1', exId: '1160' }, after: { min: 25 } }],
  reorder: [{ target: { routineId: 'r1' }, after: ['0027', '0025', '0031', '0001', '1160'] }],
  superset: [
    { target: { routineId: 'r1', exId: '0025' }, after: { link: true, with: '0001' } },
    { target: { routineId: 'r1', exId: '0027' }, after: { link: false } },
    { target: { routineId: 'r2', exId: '0043' }, after: { link: true, with: '0594' } }
  ],
  'routine-prog': [{ target: { routineId: 'r1' }, after: 'double' }],
  'exercise-prog': [{ target: { routineId: 'r1', exId: '0025' }, after: 'double' }],
  inc: [{ target: { routineId: 'r1', exId: '0025' }, after: 5 }],
  'add-routine': [{ target: {}, after: { name: 'Extra', ex: [{ id: '0308', sets: 4, reps: 12 }, { id: '0001', mode: 'time', sec: 20 }, { id: '0652' }] } }],
  'remove-routine': [{ target: { routineId: 'r2' } }, { target: { routineId: 'r3' } }],
  'rename-routine': [{ target: { routineId: 'r1' }, after: 'Upper body' }],
  week: [{ target: { weekday: 2 }, after: 'r3' }, { target: { weekday: 5 }, after: 'r2' }, { target: { weekday: 1 }, after: 'rest' }]
}

// What the two sides have to agree on: the weekly count, and the sets and minutes of every
// session. A routine the phone adds gets an id of its own, so sessions are compared without one.
const counted = plan => {
  const load = planLoad(plan)
  return {
    weeklySets: load.weeklySets,
    sessions: load.sessions.map(s => [s.weekday ?? 'unscheduled', s.sets, s.minutes]).sort((a, b) => String(a).localeCompare(String(b)))
  }
}

/** The validator's cleaned changes for a raw list — what both the phone and the projection get. */
function proposed(S, raw) {
  const changes = raw.map((c, i) => ({ id: 'c' + i, why: 'because', ...c }))
  const checked = validateReview({ coach_contract: 1, summary: 's', changes }, cleanPlan(S))
  if (!checked.ok) throw new Error(checked.errors.join('; '))
  return { id: 'p1', kind: 'review', summary: 's', changes: checked.proposal.changes }
}

function bothWays(raw) {
  const S = state()
  const proposal = proposed(S, raw)
  const projected = projectPlan(cleanPlan(S), proposal.changes)
  const applied = JSON.parse(JSON.stringify(S))
  applyChangeSet(applied, proposal, proposal.changes.map(c => c.id))
  return { phone: counted(cleanPlan(applied)), server: counted(projected), before: counted(cleanPlan(S)) }
}

describe('what a change-set adds up to, counted on the server as the phone will apply it', () => {
  it('has a case for every change type', () => {
    expect(Object.keys(CASES).sort()).toEqual([...CHANGE_TYPES].sort())
  })

  for (const [type, cases] of Object.entries(CASES)) {
    cases.forEach((c, i) => {
      it(`${type} #${i + 1}`, () => {
        const { phone, server } = bothWays([{ type, ...c }])
        expect(server).toEqual(phone)
      })
    })
  }

  it('the cases move the counts — a comparison of two unchanged plans would prove nothing', () => {
    const moving = ['add-exercise', 'remove-exercise', 'swap-exercise', 'sets', 'sec', 'cardio', 'superset', 'add-routine', 'remove-routine', 'week']
    for (const type of moving) {
      const { phone, before } = bothWays([{ type, ...CASES[type][0] }])
      expect(phone, type).not.toEqual(before)
    }
  })

  it('several changes at once, in the order they are applied', () => {
    const { phone, server } = bothWays([
      { type: 'sets', target: { routineId: 'r1', exId: '0025' }, after: 5 },
      { type: 'add-exercise', target: { routineId: 'r1' }, after: { id: '0308', sets: 3, reps: 12, position: 0 } },
      { type: 'superset', target: { routineId: 'r1', exId: '0025' }, after: { link: true, with: '0001' } },
      { type: 'remove-exercise', target: { routineId: 'r2', exId: '0594' } },
      { type: 'week', target: { weekday: 6 }, after: 'r3' },
      { type: 'add-routine', target: {}, after: { name: 'Extra', ex: [{ id: '0652', sets: 2, reps: 8 }] } }
    ])
    expect(server).toEqual(phone)
  })
})
