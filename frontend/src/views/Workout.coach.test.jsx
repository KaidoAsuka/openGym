// @vitest-environment happy-dom
/* Where "Ask the Coach" is offered on the workout screen, and where it is not.
 *
 * Two menus carry it, the header's and each exercise's own. It is there only when asking can
 * lead somewhere: the instance has a Coach, the person gave it the go-ahead, and what is on
 * screen is a workout under way. The screen is reused for filing a past workout and for editing
 * a saved one, and neither is a session to ask about. An instance with no Coach shows the menus
 * exactly as they were.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { CONSENT_VERSION } from '../lib/coach.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
// Signed in, the screen also reports the session to the server (beacon); nothing here goes out.
vi.mock('../lib/api.js', async original => ({ ...(await original()), api: vi.fn(() => Promise.resolve({})), beacon: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
const COACH = { coach: { enabled: true } }
const USER = { id: 'u1', name: 'Sam' }
const consent = () => ({ consent: { agreedAt: '2026-10-08T00:00:00Z', version: CONSENT_VERSION } })

let root, container, sheetRoot, sheetContainer

function render({ config = COACH, user = USER, coach = consent(), active = {} } = {}) {
  const S = clone(DEF)
  S.coach = { ...(S.coach || {}), ...coach }
  S.active = {
    id: 'w1', d: '2026-10-08', start: Date.now(), routineId: null, name: 'Volume', bw: null, cur: 0,
    entries: [
      { id: '0043', target: { sets: 2, reps: 5, weight: 100 }, sets: [{ w: 100, r: 5, done: false }, { w: 100, r: 5, done: false }] },
      { id: '0025', target: { sets: 1, reps: 5, weight: 70 }, sets: [{ w: 70, r: 5, done: false }] },
    ],
    ...active,
  }
  useStore.setState({ S, user, config, ready: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}

// The menu a button opens, rendered the way the app's sheet host renders it.
function openMenu(label) {
  const before = useUI.getState().sheets.length
  const button = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
  expect(button, label).toBeTruthy()
  act(() => button.click())
  expect(useUI.getState().sheets.length).toBe(before + 1)
  return renderTopSheet()
}
function renderTopSheet() {
  if (sheetRoot) act(() => sheetRoot.unmount())
  if (sheetContainer) sheetContainer.remove()
  const sheet = useUI.getState().sheets.at(-1)
  sheetContainer = document.createElement('div')
  document.body.appendChild(sheetContainer)
  sheetRoot = createRoot(sheetContainer)
  act(() => sheetRoot.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return sheetContainer
}
const items = host => [...host.querySelectorAll('.menu-item .tt')].map(e => e.textContent)
const ask = host => [...host.querySelectorAll('.menu-item')].find(e => e.querySelector('.tt')?.textContent === 'Ask the Coach')

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
  root = container = sheetRoot = sheetContainer = null
})
afterEach(() => {
  if (sheetRoot) act(() => sheetRoot.unmount())
  if (sheetContainer) sheetContainer.remove()
  if (root) act(() => root.unmount())
  if (container) container.remove()
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('"Ask the Coach" on the workout screen', () => {
  it('is in the header menu and opens the sheet on the exercise they are on', () => {
    render({ active: { cur: 1 } })
    const menu = openMenu('Workout options')
    expect(items(menu)).toContain('Ask the Coach')
    act(() => ask(menu).click())
    const sheet = renderTopSheet()
    expect(sheet.querySelector('h3').textContent).toBe('Ask the Coach')
    expect(sheet.querySelector('.live-about').textContent).toBe('About Barbell Bench Press')
  })

  it('leads an exercise’s own menu and opens the sheet on that exercise', () => {
    render()
    const menu = openMenu('More')
    expect(items(menu)[0]).toBe('Ask the Coach')
    act(() => ask(menu).click())
    expect(renderTopSheet().querySelector('.live-about').textContent).toBe('About Barbell Full Squat')
  })

  it('is not offered where there is no Coach: the menus are what they were', () => {
    render({ config: null })
    expect(items(openMenu('Workout options'))).not.toContain('Ask the Coach')
    act(() => useUI.getState().closeAll())
    expect(items(openMenu('More'))).not.toContain('Ask the Coach')
  })

  it('is not offered before the go-ahead, or after the consent text changed', () => {
    render({ coach: { consent: null } })
    expect(items(openMenu('Workout options'))).not.toContain('Ask the Coach')
    act(() => root.unmount()); container.remove()
    render({ coach: { consent: { agreedAt: '2026-01-01T00:00:00Z', version: CONSENT_VERSION - 1 } } })
    expect(items(openMenu('More'))).not.toContain('Ask the Coach')
  })

  it('is not offered to someone who is not signed in', () => {
    render({ user: null })
    expect(items(openMenu('Workout options'))).not.toContain('Ask the Coach')
  })

  it('is not offered on a past workout being filed, or on a saved one open in the editor', () => {
    render({ active: { backfill: { d: '2026-10-01' }, d: '2026-10-01' } })
    expect(items(openMenu('Workout options'))).not.toContain('Ask the Coach')
    act(() => useUI.getState().closeAll())
    expect(items(openMenu('More'))).not.toContain('Ask the Coach')
  })
})
