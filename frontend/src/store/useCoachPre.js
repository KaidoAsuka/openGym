// The workout prepared with the Coach before it is started (lib/coach-pre.js), and where it is
// kept until then.
//
// Not in `S`: `S` is the profile's, synced and merged across devices, and this is one phone's for
// one day. It has its own key, so that a question still waiting for its answer, and the cards that
// were tapped, are there again after the app was closed and opened. Whether what is stored still
// stands is not decided here (prepFor): it carries whose it is and the day it is for.
import { create } from 'zustand'
import { useStore } from './useStore.js'
import { prepFor, preToStart } from '../lib/coach-pre.js'
import { todayISO } from '../lib/format.js'

const KEY = 'gym_coach_pre_v1'
const clone = o => JSON.parse(JSON.stringify(o))
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null } catch { return null } }
const write = v => {
  try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY) } catch { /* private mode or full: kept for this run of the app */ }
}

export const useCoachPre = create((set, get) => ({
  prep: read(),
  put(prep) { write(prep); set({ prep: prep || null }) },
  // Mutate a copy of what is prepared, the way the main store's update mutates a copy of S.
  change(mut) {
    const prep = get().prep
    if (!prep) return
    const next = clone(prep)
    mut(next)
    write(next)
    set({ prep: next })
  },
}))

/** Whose phone this is right now, as what is prepared is stamped with. */
export const preOwner = () => useStore.getState().user?.id || ''

/** What is prepared and still stands for the profile and the plan as they are now, or null. */
export const currentPre = () => prepFor(useStore.getState().S, useCoachPre.getState().prep, todayISO(), preOwner())

/**
 * The prepared workout a start of `routineIds` opens with, taken: null when nothing was prepared
 * for exactly this start. Whatever was stored for today is let go either way, since a workout is
 * now under way and the next question is asked in it.
 */
export function takePre(S, routineIds) {
  const { prep, put } = useCoachPre.getState()
  if (!prep) return null
  const session = preToStart(S, prep, routineIds, todayISO(), preOwner())
  put(null)
  return session
}
