// @vitest-environment happy-dom
/* Asking the Coach during a workout, from the sheet down to the request and back.
 *
 * The real store, the real request code (lib/coach-api.js) and the real ops (lib/coach-live.js);
 * only the network is a script. What is pinned here is what someone standing at the bar relies
 * on: the question goes out with the workout as it stands, nothing about the sets moves until a
 * card is tapped, a request that died is asked again under the same id, and an answer that no
 * longer fits the workout cannot be applied.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ api: null, calls: [] }))
vi.mock('../lib/api.js', () => ({ api: (...a) => net.api(...a) }))

const { default: CoachLiveSheet, CoachedLines, opLine } = await import('./CoachLiveSheet.jsx')
const { DEF, useStore } = await import('../store/useStore.js')
const { useUI } = await import('../store/useUI.js')
const { LIVE_REQUEST_MS, JOB_ERRORS, askCoachLive } = await import('../lib/coach-api.js')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))
const SQUAT = '0043', BENCH = '0025', DB_BENCH = '0289'
const row = (w, r, done = false) => ({ w, r, done })

function setWorkout(over = {}) {
  const S = clone(DEF)
  S.unit = 'kg'
  S.active = {
    id: 'w1', d: '2026-10-08', start: Date.now() - 600000, routineId: null, name: 'Volume', bw: null, cur: 0,
    entries: [
      { id: SQUAT, target: { mode: 'reps', sets: 5, reps: 5, weight: 100 }, sets: [row(100, 5, true), row(100, 5, true), row(100, 5), row(100, 5), row(100, 5)] },
      { id: BENCH, target: { mode: 'reps', sets: 3, reps: 5, weight: 70 }, sets: [row(70, 5), row(70, 5), row(70, 5)] },
    ],
    ...over,
  }
  useStore.setState({ S, user: null, ready: true, config: { coach: { enabled: true, maxMessageLen: 300 } } })
}
const active = () => useStore.getState().S.active
const answer = (over = {}) => ({
  id: 'a1', reply: 'Take the last three sets at 95 kg.',
  ops: [{ op: 'change-remaining', entry: 0, exId: SQUAT, weight: 95, why: 'Second set at RPE 9.5 against a planned 8.' }],
  flags: [{ entry: 0, exId: SQUAT, flag: 'heavy' }],
  cap: { used: 1, limit: 30 },
  ...over,
})
const refusal = (status, code) => Object.assign(new Error(code), { status, data: { error: code, code } })

let root, container, close
function mount(focus) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  close = vi.fn()
  act(() => root.render(<CoachLiveSheet focus={focus} close={close} />))
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const settle = fn => act(async () => { fn && fn(); await flush() })
const q = sel => container.querySelector(sel)
const all = sel => [...container.querySelectorAll(sel)]
const button = label => all('button').find(b => b.textContent.trim() === label)
const text = () => container.textContent
async function ask(words) {
  const box = q('textarea')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  act(() => { set.call(box, words); box.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(() => q('button.send').click())
}

beforeEach(() => {
  net.calls = []
  // Every question waits until the test answers it.
  net.api = (path, opts) => path === '/api/coach/live'
    ? new Promise((resolve, reject) => net.calls.push({ opts, body: JSON.parse(opts.body), resolve, reject }))
    : Promise.resolve({})
  useUI.setState({ sheets: [], toastMsg: null, toastAction: null })
  setWorkout()
})
afterEach(() => {
  if (root) act(() => root.unmount())
  root = null
  container?.remove()
  vi.useRealTimers()
})

describe('asking the Coach during a workout', () => {
  it('opens on the exercise it was asked from, with nothing said yet', () => {
    mount(1)
    expect(q('h3').textContent).toBe('Ask the Coach')
    expect(q('.live-about').textContent).toBe('About Barbell Bench Press')
    expect(all('.msg')).toHaveLength(1)   // the line that says what can be asked
    expect(q('button.send').disabled).toBe(true)
    expect(q('textarea').maxLength).toBe(300)
  })

  it('sends the question with the workout as it stands, and waits where they can see it', async () => {
    mount(0)
    await ask('  The second set nearly did not come up.  ')
    expect(net.calls).toHaveLength(1)
    const { opts, body } = net.calls[0]
    expect(opts.method).toBe('POST')
    // Longer than the 90 seconds the server gives a question: its answer or its refusal is what arrives.
    expect(opts.timeout).toBe(LIVE_REQUEST_MS)
    expect(LIVE_REQUEST_MS).toBeGreaterThan(90000)
    expect(body).toMatchObject({ text: 'The second set nearly did not come up.', focus: 0, thread: [], lang: 'en' })
    expect(body.turnId).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
    expect(body.session.id).toBe('w1')
    expect(body.session.entries.map(e => e.id)).toEqual([SQUAT, BENCH])
    // What was said is the phone's own; the server gets the thread, cut, and not the store's copy.
    expect('coachTalk' in body.session).toBe(false)

    expect(all('.msg.user .bub').map(b => b.textContent)).toEqual(['The second set nearly did not come up.'])
    expect(q('.typing')).toBeTruthy()
    expect(q('textarea').disabled).toBe(true)
    expect(q('textarea').value).toBe('')
  })

  it('shows the answer with its suggestion as a card, and moves nothing until the card is tapped', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].resolve(answer()))
    expect(q('.typing')).toBeNull()
    expect(text()).toContain('Take the last three sets at 95 kg.')
    const card = q('.live-ops .pcard-chg')
    expect(card.querySelector('.pcard-chg-t').textContent).toBe('Barbell Full Squat')
    expect(card.querySelector('.pcard-chg-v').textContent).toBe('Sets still to do: 100 → 95 kg')
    expect(card.querySelector('.pcard-chg-w').textContent).toBe('Second set at RPE 9.5 against a planned 8.')
    expect(text()).toContain('Only this workout changes. Your plan stays as it is.')
    // The answer is in, and the sets are exactly where they were.
    expect(active().entries[0].sets.map(s => s.w)).toEqual([100, 100, 100, 100, 100])
    expect(active().coached).toBeUndefined()

    await settle(() => button('Apply').click())
    expect(active().entries[0].sets.map(s => s.w)).toEqual([100, 100, 95, 95, 95])
    expect(active().entries[0].target.weight).toBe(100)
    expect(active().coached).toEqual([{ id: SQUAT, op: 'change-remaining', n: 3, w: 95, was: { w: 100 }, why: 'Second set at RPE 9.5 against a planned 8.' }])
    expect(button('Apply')).toBeUndefined()
    expect(q('.live-done').textContent).toBe('Applied')
  })

  it('writes down the mark for what they said, and takes it off again on Undo', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].resolve(answer({ ops: [] })))
    expect(active().entries[0].flags).toEqual(['heavy'])
    expect(q('.live-marks').textContent).toContain('Noted: Too heavy')
    expect(q('.live-ops')).toBeNull()
    await settle(() => button('Undo').click())
    expect(active().entries[0].flags).toBeUndefined()
    expect(q('.live-marks')).toBeNull()
  })

  it('sends what was already answered along with the next question', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].resolve(answer({ ops: [], flags: [] })))
    await ask('and the bench?')
    expect(net.calls[1].body.thread).toEqual([{ who: 'user', text: 'heavy' }, { who: 'coach', text: 'Take the last three sets at 95 kg.' }])
    expect(net.calls[1].body.turnId).not.toBe(net.calls[0].body.turnId)
  })

  it('a suggestion the workout has moved on from cannot be applied', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].resolve(answer()))
    // They did the sets at 100 anyway.
    await settle(() => useStore.getState().update(s => { s.active.entries[0].sets.forEach(x => { x.done = true }) }))
    expect(q('.pcard-chg.stale')).toBeTruthy()
    expect(text()).toContain('No longer fits this workout.')
    expect(button('Apply').disabled).toBe(true)
    expect(active().coached).toBeUndefined()
  })

  it('applies a swap, and stops the timers that hold an exercise by its place', async () => {
    const ui = useUI.getState()
    const stopWork = vi.spyOn(ui, 'stopWork'), stopRest = vi.spyOn(ui, 'stopRest')
    useUI.setState({ stopWork, stopRest })
    mount(1)
    await ask('the rack is taken')
    await settle(() => net.calls[0].resolve(answer({ reply: 'Use dumbbells.', flags: [], ops: [{ op: 'swap', entry: 1, exId: BENCH, to: DB_BENCH, name: 'dumbbell bench press', why: 'The rack is taken.' }] })))
    expect(q('.pcard-chg-v').textContent).toBe('Swap Barbell Bench Press for Dumbbell Bench Press')
    await settle(() => button('Apply').click())
    expect(active().entries.map(e => e.id)).toEqual([SQUAT, DB_BENCH])
    expect(active().entries[1].sets.filter(s => !s.warmup)).toHaveLength(3)
    expect(stopWork).toHaveBeenCalled()
    expect(stopRest).toHaveBeenCalled()
    expect(active().coached).toEqual([expect.objectContaining({ id: BENCH, op: 'swap', to: DB_BENCH })])
  })
})

describe('when the answer does not come', () => {
  it('a refusal is said in the app’s words, and asking again uses the same id', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].reject(refusal(429, 'livecap')))
    expect(net.calls).toHaveLength(1)   // a refusal with a reason is the answer: not sent again by itself
    expect(q('.bub.err').textContent).toBe(JOB_ERRORS.livecap)
    expect(q('.typing')).toBeNull()

    await settle(() => button('Try again').click())
    expect(net.calls).toHaveLength(2)
    expect(net.calls[1].body.turnId).toBe(net.calls[0].body.turnId)
    expect(net.calls[1].body.text).toBe('heavy')
    expect(q('.bub.err')).toBeNull()
    expect(q('.typing')).toBeTruthy()
    await settle(() => net.calls[1].resolve(answer()))
    expect(text()).toContain('Take the last three sets at 95 kg.')
    expect(all('.msg.user')).toHaveLength(1)
  })

  it('"still answering" and a dead connection are asked again by themselves, under the same id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount(0)
    await ask('heavy')
    await settle(() => net.calls[0].reject(refusal(409, 'busy')))
    expect(q('.typing')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(net.calls).toHaveLength(2)
    await settle(() => net.calls[1].reject(new TypeError('Failed to fetch')))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(net.calls).toHaveLength(3)
    expect(new Set(net.calls.map(c => c.body.turnId)).size).toBe(1)
    await settle(() => net.calls[2].resolve(answer()))
    expect(text()).toContain('Take the last three sets at 95 kg.')
    expect(q('.bub.err')).toBeNull()
  })

  it('gives up after a few tries and says the answer never came back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount(0)
    await ask('heavy')
    for (let i = 0; i < 4; i++) {
      await settle(() => net.calls[i].reject(new TypeError('Failed to fetch')))
      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    }
    expect(net.calls).toHaveLength(4)
    expect(q('.bub.err').textContent).toBe(JOB_ERRORS.lost)
    expect(button('Try again')).toBeTruthy()
  })

  it('a question the app was closed under is still there, with a way to ask it again', async () => {
    setWorkout({ coachTalk: [{ id: 'qOld', who: 'user', text: 'asked before the reload', at: 1, focus: 0 }] })
    mount(0)
    expect(q('.typing')).toBeNull()
    expect(q('.bub.err').textContent).toBe(JOB_ERRORS.lost)
    await settle(() => button('Try again').click())
    expect(net.calls[0].body).toMatchObject({ turnId: 'qOld', text: 'asked before the reload' })
  })

  it('an answer that lands after the sheet was closed is written into the workout and announced', async () => {
    mount(0)
    await ask('heavy')
    act(() => root.unmount())
    root = null
    await act(async () => { net.calls[0].resolve(answer()); await flush() })
    expect(active().coachTalk.at(-1)).toMatchObject({ who: 'coach', text: 'Take the last three sets at 95 kg.' })
    expect(useUI.getState().toastMsg).toBe('The Coach answered.')
    expect(useUI.getState().toastAction).toMatchObject({ label: 'Show' })
  })

  it('an answer to a workout that is over is dropped', async () => {
    mount(0)
    await ask('heavy')
    await settle(() => useStore.getState().update(s => { s.active = null }))
    expect(close).toHaveBeenCalled()
    await act(async () => { net.calls[0].resolve(answer()); await flush() })
    expect(useStore.getState().S.active).toBeNull()
    expect(useUI.getState().toastMsg).toBeNull()
  })

  it('nothing is asked about a past workout being filed', async () => {
    setWorkout({ backfill: { d: '2026-10-01' } })
    expect(await askCoachLive({ text: 'heavy', focus: 0 })).toBe(false)
    expect(net.calls).toHaveLength(0)
    expect(active().coachTalk).toBeUndefined()
  })
})

describe('what was taken, in the finished workout', () => {
  const render = el => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(el))
  }

  it('lists each suggestion that was taken under the workout, with the reason it was given', () => {
    render(<CoachedLines unit="kg" workout={{ coached: [
      { id: SQUAT, op: 'change-remaining', n: 3, w: 95, was: { w: 100 }, why: 'Second set at RPE 9.5.' },
      { id: BENCH, op: 'swap', to: DB_BENCH, r: 8 },
      { id: BENCH, op: 'made-up' },
    ] }} />)
    expect(q('.live-taken-h').textContent).toBe('Suggested by the Coach during this workout')
    expect(all('.live-taken-i').map(e => e.textContent)).toEqual([
      'Barbell Full Squat · Sets still to do: 100 → 95 kgSecond set at RPE 9.5.',
      'Barbell Bench Press · Swap Barbell Bench Press for Dumbbell Bench Press · 8 reps',
    ])
  })

  it('is not there when nothing was taken', () => {
    render(<CoachedLines unit="kg" workout={{ entries: [] }} />)
    expect(container.innerHTML).toBe('')
  })

  it('words every kind of op', () => {
    expect(opLine({ id: SQUAT, op: 'change-remaining', w: 95, r: 4, was: { w: 100, r: 5 } }, 'kg')).toBe('Sets still to do: 100 → 95 kg · 5 → 4 reps')
    expect(opLine({ id: SQUAT, op: 'change-remaining', sec: 30, was: { sec: 45 } }, 'kg')).toBe('Sets still to do: 45 → 30 sec')
    expect(opLine({ id: SQUAT, op: 'remove-set', n: 2 }, 'kg')).toBe('Sets to drop: 2')
    expect(opLine({ id: SQUAT, op: 'add-set', n: 1, w: 60, r: 8 }, 'lb')).toBe('Sets to add: 1 · 60 lb · 8 reps')
    expect(opLine({ id: SQUAT, op: 'skip', n: 3 }, 'kg')).toBe('Skip the sets still to do')
  })
})
