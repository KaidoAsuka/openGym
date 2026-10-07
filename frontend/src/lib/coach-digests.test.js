import { describe, it, expect } from 'vitest'
import {
  cleanDigest, digestsOf, digestList, freshDigests, adoptDigests,
  DIGESTS_MAX, DIGEST_SUMMARY_MAX, DIGEST_ITEMS_MAX, DIGEST_ITEM_MAX, DIGEST_LISTS
} from './coach-digests.js'
import { emptyCoach, appendChat } from './coach.js'
import { demoDigests } from './coach-demo.js'

// A note is measured in three places: where the model's answer is checked, where the phone keeps
// it, and where it is read back for a later review. Checked against the server's actual source,
// as coach-charter.test.js does for the charter.
import * as serverPayload from '../../../api/coach/core/payload.js'
import * as serverValidate from '../../../api/coach/core/validate.js'

const HUGE = 'x'.repeat(50_000)
const DAY = 86400000
const monday = n => new Date(Date.parse('2026-06-01T12:00:00Z') + n * 7 * DAY).toISOString().slice(0, 10)
const sunday = n => new Date(Date.parse('2026-06-07T12:00:00Z') + n * 7 * DAY).toISOString().slice(0, 10)
// What the server hands over (api/coach/jobs.js): the job's id, the week, when it was written,
// the week's counts from the log, and the model's four fields.
const note = (n, over = {}) => ({
  id: 'job' + n, from: monday(n), to: sunday(n), at: 1000 + n, sessions: 3, planned: 3, sets: 42, minutes: 150, prs: 1,
  summary: 'Week ' + n + ': three of three, squat 100x5.', progress: ['Squat 100x5'], issues: [], carry: ['Check the bench'], ...over
})

describe('reading a note', () => {
  it('keeps what a note is made of and nothing else', () => {
    expect(cleanDigest({ ...note(0), marks: { pain: 1, equipment: 2 }, extra: HUGE, score: 9 })).toEqual({
      id: 'job0', from: '2026-06-01', to: '2026-06-07', at: 1000, sessions: 3, planned: 3, sets: 42, minutes: 150, prs: 1,
      marks: { pain: 1, equipment: 2 },
      summary: 'Week 0: three of three, squat 100x5.', progress: ['Squat 100x5'], issues: [], carry: ['Check the bench']
    })
  })

  it('cuts every field to its limit and drops what is not what it should be', () => {
    const g = cleanDigest({
      id: HUGE, from: '2026-06-01', to: '2026-06-07', at: 'yesterday', summary: '  ' + HUGE, sessions: '3', planned: -1, sets: 1.5, minutes: 1e9, prs: 0,
      marks: { pain: 2, made: 3, heavy: HUGE, time: 0 }, progress: [...Array(50)].map(() => HUGE), issues: HUGE, carry: ['  kept  ', '', 7, null]
    })
    expect(g.id).toHaveLength(40)
    expect(g.at).toBe(0)
    expect(g.summary).toHaveLength(DIGEST_SUMMARY_MAX)
    expect(Object.keys(g)).toEqual(['id', 'from', 'to', 'at', 'prs', 'marks', 'summary', 'progress', 'issues', 'carry'])
    expect(g.prs).toBe(0)
    expect(g.marks).toEqual({ pain: 2 })
    expect(g.progress).toHaveLength(DIGEST_ITEMS_MAX)
    expect(g.progress.every(x => x.length === DIGEST_ITEM_MAX)).toBe(true)
    expect(g.issues).toEqual([])
    expect(g.carry).toEqual(['kept'])
  })

  it('is no note without a week and something said about it', () => {
    for (const bad of [null, 'x', 7, [], {}, { ...note(0), summary: '   ' }, { ...note(0), summary: 7 }, { ...note(0), from: 'June' },
      { ...note(0), from: '2026-06-01T00:00:00Z' }, { ...note(0), to: '2026-13-45' }, { ...note(0), from: '2026-06-08' }]) {
      expect(cleanDigest(bad)).toBe(null)
    }
    // A note with no id of its own is known by its week.
    expect(cleanDigest({ ...note(0), id: undefined }).id).toBe('2026-06-01')
  })

  it('agrees with the server on how big a note can be', () => {
    expect(DIGEST_SUMMARY_MAX).toBe(serverPayload.DIGEST_SUMMARY_CHARS)
    expect(DIGEST_ITEMS_MAX).toBe(serverPayload.DIGEST_ITEMS)
    expect(DIGEST_ITEM_MAX).toBe(serverPayload.DIGEST_ITEM_CHARS)
    expect(DIGEST_LISTS).toEqual(serverPayload.DIGEST_LISTS)
    expect(DIGEST_SUMMARY_MAX).toBe(serverValidate.DIGEST_SUMMARY_MAX)
    expect(DIGEST_ITEMS_MAX).toBe(serverValidate.DIGEST_ITEMS_MAX)
    expect(DIGEST_ITEM_MAX).toBe(serverValidate.DIGEST_ITEM_MAX)
    expect(DIGESTS_MAX).toBeGreaterThanOrEqual(serverPayload.DIGESTS_SENT)
    expect(DIGESTS_MAX).toBe(serverPayload.BLOCK_WEEKS_MAX)
  })

  it('keeps a validated answer whole, and the payload reads the kept note back the same', () => {
    const answer = serverValidate.validateDigest({
      coach_contract: 1, summary: 's'.repeat(DIGEST_SUMMARY_MAX), progress: [...Array(DIGEST_ITEMS_MAX)].map(() => 'p'.repeat(DIGEST_ITEM_MAX)),
      issues: ['Bench rack taken twice'], carry: ['See whether Wednesday gets trained']
    }).proposal
    const s = { coach: emptyCoach() }
    expect(adoptDigests(s, [{ id: 'j1', from: '2026-06-01', to: '2026-06-07', at: 5, sessions: 2, planned: 3, sets: 20, minutes: 95, prs: 0, marks: { equipment: 2 }, ...answer }])).toBe(1)
    const kept = s.coach.digests[0]
    expect({ summary: kept.summary, progress: kept.progress, issues: kept.issues, carry: kept.carry }).toEqual(answer)
    const [back] = serverPayload.digestsOf(s.coach)
    expect(back).toEqual({
      from: '2026-06-01', to: '2026-06-07', sessions: 2, planned: 3, sets: 20, minutes: 95, prs: 0, marks: { equipment: 2 },
      summary: answer.summary, progress: answer.progress, issues: answer.issues, carry: answer.carry
    })
  })
})

describe('taking notes in', () => {
  it('takes what is new, one note a week, oldest first', () => {
    const s = { coach: emptyCoach() }
    expect(adoptDigests(s, [note(2), note(0), 'junk', null, { from: 'x' }])).toBe(2)
    expect(s.coach.digests.map(g => g.from)).toEqual([monday(0), monday(2)])
    expect(adoptDigests(s, [note(1)])).toBe(1)
    expect(digestsOf(s).map(g => g.from)).toEqual([monday(0), monday(1), monday(2)])
    expect(digestList(s).map(g => g.from)).toEqual([monday(2), monday(1), monday(0)])
  })

  it('changes nothing when the same notes are handed over again', () => {
    const s = { coach: emptyCoach() }
    adoptDigests(s, [note(0), note(1)])
    const before = s.coach.digests
    // The server keeps handing them over until it has seen them synced.
    expect(freshDigests(s, [note(0), note(1)])).toEqual([])
    expect(adoptDigests(s, [note(0), note(1)])).toBe(0)
    expect(s.coach.digests).toBe(before)
  })

  it('lets a week written again replace the first writing, and never the other way round', () => {
    const s = { coach: emptyCoach() }
    adoptDigests(s, [note(0, { at: 50, summary: 'first' })])
    expect(adoptDigests(s, [note(0, { id: 'again', at: 90, summary: 'second' })])).toBe(1)
    expect(s.coach.digests).toHaveLength(1)
    expect(s.coach.digests[0].summary).toBe('second')
    expect(adoptDigests(s, [note(0, { at: 10, summary: 'older' })])).toBe(0)
    expect(s.coach.digests[0].summary).toBe('second')
  })

  it('keeps half a year and lets the oldest go', () => {
    const s = { coach: emptyCoach() }
    expect(adoptDigests(s, [...Array(DIGESTS_MAX + 5)].map((_, n) => note(n)))).toBe(DIGESTS_MAX + 5)
    expect(s.coach.digests).toHaveLength(DIGESTS_MAX)
    expect(s.coach.digests[0].from).toBe(monday(5))
    expect(s.coach.digests.at(-1).from).toBe(monday(DIGESTS_MAX + 4))
  })

  it('works on a state that has no Coach yet, or whose notes are not a list', () => {
    const bare = {}
    expect(adoptDigests(bare, [note(0)])).toBe(1)
    expect(bare.coach.digests).toHaveLength(1)
    const odd = { coach: { digests: 'junk' } }
    expect(digestsOf(odd)).toEqual([])
    expect(adoptDigests(odd, [note(0)])).toBe(1)
    expect(adoptDigests({ coach: { digests: [null, 7, { from: 'x' }] } }, undefined)).toBe(0)
    expect(freshDigests(undefined, 'junk')).toEqual([])
  })

  it('are the first thing after old chat lines to go when the Coach namespace outgrows its budget', () => {
    const s = { coach: emptyCoach() }
    adoptDigests(s, [...Array(DIGESTS_MAX)].map((_, n) => note(n)))
    s.coach.snapshots = [{ at: 1, routines: [], week: {}, pad: 'y'.repeat(300 * 1024) }, { at: 2, routines: [], week: {} }]
    appendChat(s, { role: 'user', kind: 'text', text: 'hello' })
    // Twelve stay — what a review reads — and only then does a snapshot go.
    expect(s.coach.digests).toHaveLength(12)
    expect(s.coach.digests.at(-1).from).toBe(monday(DIGESTS_MAX - 1))
    expect(s.coach.snapshots.map(x => x.at)).toEqual([2])
  })
})

describe('the demo', () => {
  it('writes up the last two finished weeks its profile trained in, as notes the app keeps', () => {
    const at = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d }
    const iso = d => d.toISOString().slice(0, 10)
    const workout = n => ({ id: 'w' + n, d: iso(at(n)), start: at(n).getTime(), end: at(n).getTime() + 50 * 60000, prs: n === 8 ? ['x'] : [], entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }, { w: 60, r: 8, done: true }, { w: 40, r: 8, done: true, warmup: true }] }] })
    const S = { week: { 1: ['r1'], 3: ['r1'], 5: ['r1'] }, workouts: [21, 14, 13, 8, 7].map(workout) }
    const notes = demoDigests(S)
    expect(notes.length).toBeGreaterThanOrEqual(1)
    expect(notes.length).toBeLessThanOrEqual(2)
    for (const g of notes) {
      const kept = cleanDigest(g)
      expect(kept).toBeTruthy()
      expect(kept.sets).toBe(kept.sessions * 2)
      expect(kept.planned).toBe(3)
    }
    const s = { coach: emptyCoach() }
    expect(adoptDigests(s, notes)).toBe(notes.length)
    expect(adoptDigests(s, demoDigests(S))).toBe(0)
    expect(demoDigests({ workouts: [] })).toEqual([])
    expect(demoDigests(undefined)).toEqual([])
  })
})
