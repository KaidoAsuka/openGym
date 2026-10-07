import { describe, it, expect, vi } from 'vitest'
import { advisoryLine, planNoteLines, planBasis } from './coach-plan-notes.js'
import { lightBundle, profileLines } from './coach.js'
import { demoPlan, demoStatus, demoResolve } from './coach-demo.js'

// The server counts and this file words. Checked against the server's own source, so a code it
// starts sending without a sentence here fails in this file and not as a blank line on a card.
import { planLoadFindings, advisoriesOf, HARD_FINDINGS } from '../../../api/coach/core/plan-load.js'
import { validatePlan } from '../../../api/coach/core/validate.js'
import { programCard } from '../../../api/coach/core/kb.js'

const x = (id, sets) => ({ id, sets, mode: 'reps', reps: 8 })
// Chest twice a week at 24 sets a session, and one set of calves: every finding at once.
const CHEST = {
  routines: [{ id: 'a', name: 'Chest day', ex: [x('0025', 10), x('0047', 8), x('0308', 6), x('0594', 1)] }],
  week: { 1: ['a'], 4: ['a'] }
}

describe('the counted notes, worded', () => {
  it('has a sentence for every finding the server can send', () => {
    const notes = advisoriesOf(CHEST, planLoadFindings(CHEST, { sessionMin: 45 }))
    expect(notes.map(a => a.code)).toEqual(['weekly-over', 'session-over', 'weekly-under', 'session-part-over'])
    for (const code of HARD_FINDINGS) expect(notes.some(a => a.code === code)).toBe(true)
    expect(notes.map(advisoryLine)).toEqual([
      'Weekly sets for Chest: 48 — above the usual ceiling of 20.',
      'Monday, Thursday (Chest day): about 63 min by the app’s estimate — over the 45 min you set.',
      'Weekly sets for Calves: 2 — below the usual minimum of 4.',
      'Monday, Thursday (Chest day): 24 sets for Chest in one session — more than the usual 10.'
    ])
  })

  it('names a routine no day schedules by its name alone', () => {
    expect(advisoryLine({ code: 'session-part-over', bp: 'back', routine: 'Pull', sets: 18, max: 15 }))
      .toBe('Pull: 18 sets for Back muscles in one session — more than the usual 15.')
    expect(advisoryLine({ code: 'session-over', routine: 'Pull', weekdays: [9, 'x', 2], minutes: 70, cap: 60 }))
      .toBe('Tuesday (Pull): about 70 min by the app’s estimate — over the 60 min you set.')
  })

  it('says nothing for a code it does not know, or for something that is not a note', () => {
    for (const a of [null, 'weekly-over', {}, { code: 'from-a-newer-server', bp: 'chest' }]) expect(advisoryLine(a)).toBeNull()
  })
})

describe('what the card lists', () => {
  it('puts what the app counted first, then what the Coach wrote', () => {
    const r = validatePlan({ routines: CHEST.routines, week: { 1: 'a', 4: 'a' }, differences: ['Every set to failure (V5).'] }, { ownPlan: true, sessionMin: 45 })
    const lines = planNoteLines(r.bundle)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatch(/^Weekly sets for Chest: 48/)
    expect(lines[4]).toBe('Every set to failure (V5).')
  })

  it('lists nothing for a plan with nothing on it, whatever shape arrives', () => {
    for (const b of [null, {}, { advisories: 'x', differences: 7 }, { advisories: [{ code: 'unknown' }], differences: ['  ', null] }]) expect(planNoteLines(b)).toEqual([])
  })
})

describe('where a plan comes from', () => {
  const card = programCard('phul')

  it('a catalogue programme, by the catalogue\'s name, with its link', () => {
    expect(planBasis({ program: card })).toEqual({ text: 'Based on PHUL · Brandon Campbell', source: 'https://www.liftosaur.com/programs/phul' })
  })

  it('their own plan, and their own plan after a programme they named', () => {
    expect(planBasis({ own: true })).toEqual({ text: 'Built from your own plan', source: null })
    expect(planBasis({ own: true, program: card }).text).toBe('Your own plan, after PHUL · Brandon Campbell')
  })

  it('neither: no line at all', () => {
    for (const b of [null, {}, { own: 'yes' }, { program: 'phul' }, { program: { id: 'phul' } }]) expect(planBasis(b)).toBeNull()
  })

  it('only a web address becomes a link', () => {
    for (const source of ['javascript:alert(1)', 'http://plain.example/', '//x.example', 42, null]) {
      expect(planBasis({ program: { name: 'P', source } }).source).toBeNull()
    }
  })
})

describe('kept, and shown back', () => {
  it('a kept plan remembers what it was built from, bounded', () => {
    const kept = lightBundle({ name: 'P', routines: [], program: { ...programCard('gzclp'), name: 'N'.repeat(500), extra: 'x' }, own: true, advisories: [{ code: 'weekly-over' }], differences: ['d'] })
    expect(kept.program).toEqual({ id: 'gzclp', name: 'N'.repeat(80), author: 'Cody Lefever', source: 'https://thefitness.wiki/routines/gzclp/' })
    expect(kept.own).toBe(true)
    // The counts and the Coach's lines were for deciding; the plan is in the routines now.
    expect(kept.advisories).toBeUndefined()
    expect(kept.differences).toBeUndefined()
    expect(lightBundle({ name: 'P', routines: [] }).program).toBeUndefined()
    expect(planBasis(kept).text).toMatch(/^Your own plan, after N+/)
  })

  it('the questionnaire shows their own plan back with the other answers', () => {
    expect(profileLines({ goal: 'muscle', ownPlan: 'PHUL with front squats' })).toContain('My plan: PHUL with front squats')
    expect(profileLines({ goal: 'muscle', ownPlan: '' }).some(l => l.startsWith('My plan'))).toBe(false)
  })

  it('the demo plan names a programme the catalogue really holds, and carries a note the card can word', () => {
    // The demo provider answers after a pause, through the status the screens poll.
    vi.useFakeTimers()
    try {
      const S = { routines: [], week: {}, workouts: [], coach: {} }
      const think = intake => { demoPlan(S, intake); vi.advanceTimersByTime(2200); const p = demoStatus().pending; demoResolve(); return p }
      const plan = think(null)
      expect(plan.bundle.program).toEqual(programCard('fierce-5'))
      expect(planNoteLines(plan.bundle)).toEqual(['Weekly sets for Arms: 3 — below the usual minimum of 4.'])
      const own = think({ ownPlan: 'my own' })
      expect(own.bundle.own).toBe(true)
      expect(own.bundle.program).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
