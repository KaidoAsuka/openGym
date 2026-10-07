import { describe, expect, it } from 'vitest'
import { FLAG_KINDS, FLAG_LABEL, SKIPPED_MAX, cleanFlags, toggleFlag, setEntryFlags, keepMarked, settleMarks } from './exercise-flags.js'
import { NOTE_MAX } from './history.js'
import * as serverPayload from '../../../api/coach/core/payload.js'

const done = (id, over = {}) => ({ id, sets: [{ w: 40, r: 5, done: true }], ...over })
const open = (id, over = {}) => ({ id, sets: [{ w: 40, r: 5, done: false }], ...over })

describe('exercise marks', () => {
  // The Coach's payload reads a mark against its own list (api/coach/core/payload.js): a kind
  // only the phone knew would be saved, shown, and silently dropped on the way out.
  it('are the kinds the Coach reads, and the workout keeps as many skipped exercises as it reads', () => {
    expect(FLAG_KINDS).toEqual(serverPayload.FLAG_KINDS)
    expect(SKIPPED_MAX).toBe(serverPayload.SKIPPED_MAX)
  })

  it('each have a label, and every pack translates it', () => {
    expect(Object.keys(FLAG_LABEL)).toEqual(FLAG_KINDS)
    const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })
    expect(Object.keys(packs).length).toBeGreaterThan(10)
    for (const [file, pack] of Object.entries(packs)) {
      for (const key of [...Object.values(FLAG_LABEL), 'Marked, not done']) expect(pack[key], `${file}: ${key}`).toEqual(expect.any(String))
    }
  })

  it('are read against the list: known kinds, each once, in the order the sheet shows them', () => {
    expect(cleanFlags(['light', 'pain', 'pain', 'made up', 7, null])).toEqual(['pain', 'light'])
    for (const v of [undefined, null, 'pain', { pain: true }, 3]) expect(cleanFlags(v)).toEqual([])
  })

  it('toggle one at a time and leave an unknown kind alone', () => {
    expect(toggleFlag([], 'time')).toEqual(['time'])
    expect(toggleFlag(['time'], 'pain')).toEqual(['pain', 'time'])
    expect(toggleFlag(['pain', 'time'], 'pain')).toEqual(['time'])
    expect(toggleFlag(['time'], 'made up')).toEqual(['time'])
  })

  it('are written onto an entry only when there are any', () => {
    const entry = { id: 'bench', flags: ['pain'] }
    setEntryFlags(entry, ['heavy', 'nonsense'])
    expect(entry.flags).toEqual(['heavy'])
    setEntryFlags(entry, [])
    expect('flags' in entry).toBe(false)
  })
})

describe('a marked exercise that leaves the session', () => {
  it('leaves its mark and its note with the session', () => {
    const active = { entries: [] }
    expect(keepMarked(active, open('bench', { flags: ['equipment'], note: '  rack taken  ', notePin: true }))).toBe(true)
    expect(active.skipped).toEqual([{ id: 'bench', flags: ['equipment'], note: 'rack taken' }])
    expect(keepMarked(active, open('row', { flags: ['time'] }))).toBe(true)
    expect(active.skipped[1]).toEqual({ id: 'row', flags: ['time'] })
  })

  it('leaves nothing behind when it was not marked', () => {
    const active = { entries: [] }
    expect(keepMarked(active, open('bench', { note: 'just a note' }))).toBe(false)
    expect(keepMarked(active, open('bench', { flags: ['made up'] }))).toBe(false)
    expect(keepMarked(null, open('bench', { flags: ['pain'] }))).toBe(false)
    expect('skipped' in active).toBe(false)
  })
})

describe('the marked exercises a finished session did not log', () => {
  it('are the ones still in it without a set, and the ones that left it', () => {
    const active = {
      skipped: [{ id: 'bench', flags: ['equipment'], note: 'rack taken' }],
      entries: [done('press'), open('curl', { flags: ['time'] }), open('fly'), open('dip', { flags: ['pain', 'heavy'], note: ' elbow ' })],
    }
    expect(settleMarks(active, [done('press')])).toEqual([
      { id: 'bench', flags: ['equipment'], note: 'rack taken' },
      { id: 'curl', flags: ['time'] },
      { id: 'dip', flags: ['pain', 'heavy'], note: 'elbow' },
    ])
  })

  it('count an exercise once, with every mark it got', () => {
    const active = { skipped: [{ id: 'bench', flags: ['equipment'] }, { id: 'bench', flags: ['time', 'equipment'], note: 'gave up' }], entries: [] }
    expect(settleMarks(active, [])).toEqual([{ id: 'bench', flags: ['equipment', 'time'], note: 'gave up' }])
  })

  it('do not include one that was logged after all: its marks go onto the logged entry', () => {
    const logged = [done('bench'), done('row', { flags: ['light'], note: 'own note' })]
    const active = { skipped: [{ id: 'bench', flags: ['equipment'], note: 'rack taken' }, { id: 'row', flags: ['heavy'], note: 'other' }], entries: logged }
    expect(settleMarks(active, logged)).toEqual([])
    expect(logged[0]).toMatchObject({ flags: ['equipment'], note: 'rack taken' })
    expect(logged[1]).toMatchObject({ flags: ['heavy', 'light'], note: 'own note' })
  })

  it('are read like any stored field: no mark, no id or the wrong shape is nothing, and text is cut', () => {
    const active = {
      skipped: ['x', null, { flags: ['pain'] }, { id: 'a', flags: 'pain' }, { id: 'b', flags: ['pain'], note: 'n'.repeat(NOTE_MAX + 50) }, { id: 'c', flags: ['pain'], note: 9 }],
      entries: 'nope',
    }
    const out = settleMarks(active, undefined)
    expect(out.map(e => e.id)).toEqual(['b', 'c'])
    expect(out[0].note).toHaveLength(NOTE_MAX)
    expect('note' in out[1]).toBe(false)
    expect(settleMarks(null, [])).toEqual([])
    const many = { skipped: [...Array(40)].map((_, i) => ({ id: 'e' + i, flags: ['time'] })) }
    expect(settleMarks(many, [])).toHaveLength(SKIPPED_MAX)
  })
})
