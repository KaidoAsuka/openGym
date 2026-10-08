// @vitest-environment happy-dom
/* Asking the Coach before a workout is started, from the button on Home down to the request and
 * back, and on into the workout that Start then opens.
 *
 * The real store, the real request code (lib/coach-api.js) and the real rules (lib/coach-pre.js,
 * lib/coach-live.js); only the network is a script. What is pinned here is what someone about to
 * train relies on: the question goes out with the workout they are about to start and nothing is
 * started by asking; nothing changes until a card is tapped; a card about the day writes today's
 * override and no other; and Start opens the workout as it was prepared.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ api: null, calls: [] }))
vi.mock('../lib/api.js', async original => ({ ...(await original()), api: (...a) => net.api(...a), beacon: vi.fn() }))
vi.mock('../lib/sound.js', async original => ({ ...(await original()), beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))

const { default: CoachPreSheet, AskBefore, openCoachPre } = await import('./CoachPreSheet.jsx')
const { default: CoachLiveSheet, CoachedLines } = await import('./CoachLiveSheet.jsx')
const { DEF, useStore } = await import('../store/useStore.js')
const { useUI } = await import('../store/useUI.js')
const { useCoachPre } = await import('../store/useCoachPre.js')
const { CONSENT_VERSION } = await import('../lib/coach.js')
const { todayISO } = await import('../lib/format.js')

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))
const SQUAT = '0043', BENCH = '0025', DB_BENCH = '0289', LEG_EXT = '0585'
const USER = { id: 'u1', name: 'Sam' }
const COACH = { coach: { enabled: true, maxMessageLen: 300 } }
const TODAY = todayISO()
const ex = (id, sets, reps, weight) => ({ id, sets, reps, weight, prog: 'off' })

function setState({ user = USER, config = COACH, consent = true, over = {} } = {}) {
  const S = clone(DEF)
  S.unit = 'kg'
  S.weighIn = false
  S.routines = [
    { id: 'h', name: 'Heavy', ex: [ex(SQUAT, 3, 5, 105), ex(BENCH, 3, 5, 72.5), ex(LEG_EXT, 2, 12, 40)] },
    { id: 'l', name: 'Light', ex: [ex(SQUAT, 2, 5, 80), ex(DB_BENCH, 3, 10, 22.5)] },
  ]
  S.week = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, ['h']]))
  S.coach = { ...(S.coach || {}), ...(consent ? { consent: { agreedAt: '2026-10-08T00:00:00Z', version: CONSENT_VERSION } } : {}) }
  Object.assign(S, over)
  useStore.setState({ S, user, config, ready: true })
}
const S = () => useStore.getState().S
const prep = () => useCoachPre.getState().prep
const answer = (over = {}) => ({
  id: 'a1', reply: 'Squat at 100 today, and leave the leg extensions.',
  ops: [
    { op: 'change-remaining', entry: 0, exId: SQUAT, weight: 100, why: 'Five hours of sleep.' },
    { op: 'skip', entry: 2, exId: LEG_EXT, why: 'Forty minutes: the accessory at the end goes first.' },
  ],
  flags: [], cap: { used: 1, limit: 30 },
  ...over,
})
const dayAnswer = day => answer({ reply: 'Not Heavy two days running.', ops: [], day })

let root, container, close
function mount(node) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  close = vi.fn()
  act(() => root.render(node || <CoachPreSheet close={close} />))
}
function unmount() {
  if (root) act(() => root.unmount())
  root = null
  container?.remove()
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
  localStorage.clear()
  useCoachPre.setState({ prep: null })
  useUI.setState({ sheets: [], toastMsg: null, toastAction: null })
  setState()
})
afterEach(() => { unmount(); vi.useRealTimers() })

describe('the way in', () => {
  const shown = () => { mount(<AskBefore />); const there = !!button('Ask the Coach before you start'); unmount(); return there }

  it('is there when there is a Coach with the go-ahead, a workout planned for today, and none under way', () => {
    expect(shown()).toBe(true)
    setState({ consent: false })
    expect(shown()).toBe(false)
    setState({ config: { coach: { enabled: false } } })
    expect(shown()).toBe(false)
    setState({ user: null })
    expect(shown()).toBe(false)
    setState({ over: { week: {} } })
    expect(shown()).toBe(false)
    setState({ over: { dayPlan: { [TODAY]: 'rest' } } })
    expect(shown()).toBe(false)
    setState({ over: { active: { id: 'w1', d: TODAY, start: Date.now(), name: 'Heavy', cur: 0, entries: [{ id: SQUAT, sets: [] }] } } })
    expect(shown()).toBe(false)
  })

  it('opens the sheet', () => {
    mount(<AskBefore />)
    act(() => button('Ask the Coach before you start').click())
    expect(useUI.getState().sheets).toHaveLength(1)
    expect(typeof openCoachPre).toBe('function')
  })
})

describe('asking the Coach before a workout', () => {
  it('opens on today’s workout, with nothing said and nothing started', () => {
    mount()
    expect(q('h3').textContent).toBe('Ask the Coach before you start')
    expect(q('.live-about').textContent).toBe('About Heavy')
    expect(all('.msg')).toHaveLength(1)
    expect(button('Start Heavy')).toBeTruthy()
    expect(q('textarea').maxLength).toBe(300)
    expect(S().active).toBe(null)
    expect(prep().session).toMatchObject({ pre: true, d: TODAY, routineIds: ['h'], name: 'Heavy' })
    expect(prep().owner).toBe('u1')
    expect(close).not.toHaveBeenCalled()
  })

  it('closes when today holds nothing to ask about', () => {
    setState({ over: { week: {} } })
    mount()
    expect(close).toHaveBeenCalled()
    expect(prep()).toBe(null)
  })

  it('sends the question with the workout they are about to start', async () => {
    mount()
    await ask('  Slept five hours, forty minutes at most.  ')
    expect(net.calls).toHaveLength(1)
    const { body } = net.calls[0]
    expect(body).toMatchObject({ text: 'Slept five hours, forty minutes at most.', thread: [], lang: 'en' })
    expect(body.turnId).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
    expect(body.session).toMatchObject({ pre: true, d: TODAY, routineIds: ['h'], name: 'Heavy' })
    expect('start' in body.session).toBe(false)
    expect(body.session.entries.map(e => e.id)).toEqual([SQUAT, BENCH, LEG_EXT])
    expect('coachTalk' in body.session).toBe(false)
    expect(all('.msg.user .bub').map(b => b.textContent)).toEqual(['Slept five hours, forty minutes at most.'])
    expect(q('.typing')).toBeTruthy()
    // Asking started nothing.
    expect(S().active).toBe(null)
  })

  it('shows the suggestions as cards, and Start opens the workout with the ones that were tapped', async () => {
    mount()
    await ask('Slept five hours.')
    await settle(() => net.calls[0].resolve(answer()))
    expect(text()).toContain('Squat at 100 today, and leave the leg extensions.')
    const cards = all('.live-ops .pcard-chg')
    expect(cards.map(c => c.querySelector('.pcard-chg-t').textContent)).toEqual(['Barbell Full Squat', 'Lever Leg Extension'])
    expect(text()).toContain('Only this workout changes. Your plan stays as it is.')

    await settle(() => cards[0].querySelector('button').click())
    expect(all('.live-done')).toHaveLength(1)
    const work = e => e.sets.filter(s => !s.warmup && s.phase !== 'warmup')
    expect(work(prep().session.entries[0]).map(s => s.w)).toEqual([100, 100, 100])
    // The plan itself is as it was, and still nothing is started.
    expect(S().routines[0].ex[0].weight).toBe(105)
    expect(S().active).toBe(null)

    await settle(() => button('Start Heavy').click())
    expect(close).toHaveBeenCalled()
    const A = S().active
    expect(A).toMatchObject({ d: TODAY, routineIds: ['h'], name: 'Heavy', cur: 0 })
    expect(typeof A.start).toBe('number')
    expect('pre' in A).toBe(false)
    expect(work(A.entries[0]).map(s => s.w)).toEqual([100, 100, 100])
    expect(A.entries.map(e => e.id)).toEqual([SQUAT, BENCH, LEG_EXT])
    expect(A.coached).toMatchObject([{ id: SQUAT, op: 'change-remaining', w: 100 }])
    expect(A.coachTalk.map(m => m.who)).toEqual(['user', 'coach'])
    // What was prepared is let go: the next question is asked in the workout.
    expect(prep()).toBe(null)

    // And there the conversation is, with the card that was not taken still to take.
    unmount()
    mount(<CoachLiveSheet close={close} />)
    expect(text()).toContain('Slept five hours.')
    expect(all('.live-done')).toHaveLength(1)
    await settle(() => all('.live-ops .pcard-chg')[1].querySelector('button').click())
    expect(S().active.entries.map(e => e.id)).toEqual([SQUAT, BENCH])
  })

  it('a workout started without a word to the Coach is the one Start always built', async () => {
    mount()
    await settle(() => button('Start Heavy').click())
    const A = S().active
    expect('coachTalk' in A).toBe(false)
    expect('coached' in A).toBe(false)
    expect(prep()).toBe(null)
  })

  it('a card about the day writes today’s override, and the sheet goes on about the workout it brings in', async () => {
    mount()
    await ask('I did Heavy yesterday.')
    await settle(() => net.calls[0].resolve(dayAnswer({ do: 'train', routine: 'l', name: 'Light', why: 'Heavy was trained yesterday.' })))
    const card = q('.live-ops .pcard-chg')
    expect(card.querySelector('.pcard-chg-t').textContent).toBe('Today')
    expect(card.querySelector('.pcard-chg-v').textContent).toBe('Train Light today instead')
    expect(card.querySelector('.pcard-chg-w').textContent).toBe('Heavy was trained yesterday.')
    expect(text()).toContain('Only today changes. Your plan stays as it is.')
    expect(S().dayPlan).toEqual({})

    await settle(() => card.querySelector('button').click())
    expect(S().dayPlan).toEqual({ [TODAY]: 'l' })
    expect(S().week[1]).toEqual(['h'])
    expect(close).not.toHaveBeenCalled()
    expect(q('.live-about').textContent).toBe('About Light')
    expect(button('Start Light')).toBeTruthy()
    expect(all('.live-done')).toHaveLength(1)
    expect(prep().session).toMatchObject({ routineIds: ['l'], coachedDay: { from: ['Heavy'], why: 'Heavy was trained yesterday.' } })

    // The next question is about Light, and carries what was said.
    await ask('And how heavy?')
    expect(net.calls[1].body.session.routineIds).toEqual(['l'])
    expect(net.calls[1].body.thread).toEqual([{ who: 'user', text: 'I did Heavy yesterday.' }, { who: 'coach', text: 'Not Heavy two days running.' }])
    await settle(() => net.calls[1].resolve(answer({ reply: 'As planned.', ops: [] })))

    await settle(() => button('Start Light').click())
    const A = S().active
    expect(A).toMatchObject({ routineIds: ['l'], name: 'Light', coachedDay: { from: ['Heavy'] } })
    expect(A.entries.map(e => e.id)).toEqual([SQUAT, DB_BENCH])
  })

  it('a rest card calls today off and closes the sheet', async () => {
    mount()
    await ask('I have a fever.')
    await settle(() => net.calls[0].resolve(dayAnswer({ do: 'rest', why: 'A fever: rest.' })))
    expect(q('.live-ops .pcard-chg-v').textContent).toBe('Rest today')
    await settle(() => q('.live-ops button').click())
    expect(S().dayPlan).toEqual({ [TODAY]: 'rest' })
    expect(close).toHaveBeenCalled()
    expect(prep()).toBe(null)
    expect(S().active).toBe(null)
  })

  it('a day card that no longer fits cannot be taken', async () => {
    mount()
    await ask('Which one today?')
    await settle(() => net.calls[0].resolve(dayAnswer({ do: 'train', routine: 'l', name: 'Light', why: 'w' })))
    // The routine it named was deleted meanwhile; the plan under today's workout did not move.
    await settle(() => useStore.getState().update(s => { s.routines = s.routines.filter(r => r.id !== 'l') }))
    const card = q('.live-ops .pcard-chg')
    expect(card.className).toContain('stale')
    expect(card.querySelector('button').disabled).toBe(true)
    expect(card.querySelector('.pcard-chg-v').textContent).toBe('Train Light today instead')
    expect(S().dayPlan).toEqual({})
  })

  it('is still there after the sheet was closed and opened again, and is let go when the plan under it moves', async () => {
    mount()
    await ask('Slept five hours.')
    await settle(() => net.calls[0].resolve(answer()))
    unmount()
    // Kept on the phone, outside the profile's synced state.
    expect(JSON.parse(localStorage.getItem('gym_coach_pre_v1')).session.coachTalk).toHaveLength(2)
    expect('pre' in S()).toBe(false)
    mount()
    expect(text()).toContain('Squat at 100 today, and leave the leg extensions.')

    // The cycle wrote next week's numbers into the routine: what was prepared is for a workout
    // that will not be built any more.
    await settle(() => useStore.getState().update(s => { s.routines[0].ex[0].weight = 107.5 }))
    expect(text()).not.toContain('Squat at 100 today')
    expect(all('.msg')).toHaveLength(1)
    expect(prep().session.entries[0].target.weight).toBe(107.5)
  })

  it('an answer that arrives after the sheet was closed is written in and announced', async () => {
    mount()
    await ask('Slept five hours.')
    unmount()
    await settle(() => net.calls[0].resolve(answer()))
    expect(prep().session.coachTalk.map(m => m.who)).toEqual(['user', 'coach'])
    expect(useUI.getState().toastMsg).toBe('The Coach answered.')
  })
})

describe('in the finished workout’s detail', () => {
  it('says the day was the Coach’s suggestion, and what it stood in for', () => {
    mount(<CoachedLines workout={{ coachedDay: { from: ['Heavy'], why: 'Heavy was trained yesterday.' } }} unit="kg" />)
    expect(text()).toContain('In place of Heavy, as the Coach suggested before the workout')
    expect(text()).toContain('Heavy was trained yesterday.')
    unmount()
    mount(<CoachedLines workout={{ coachedDay: { from: [] } }} unit="kg" />)
    expect(text()).toContain('Suggested by the Coach before the workout')
    unmount()
    mount(<CoachedLines workout={{}} unit="kg" />)
    expect(text()).toBe('')
  })
})
