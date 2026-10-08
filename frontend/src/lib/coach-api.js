// Talking to the Coach endpoints, and knowing when to stop.
//
// Jobs are minutes-scale, so the client polls. The one rule worth stating: polling only runs
// while a Coach surface is on screen or a job is known to be in flight. An app that pings the
// server every thirty seconds forever because a feature exists is an app that costs battery
// for a feature nobody is using.

import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from './api.js'
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'
import { t, getLang } from './i18n.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { freshDigests, adoptDigests } from './coach-digests.js'
import { freshLooks, applyLooks } from './coach-cycle.js'
import { appendChat } from './coach.js'
import { canAskLive, newTurnId, addQuestion, addAnswer, addFailure, talkOf, threadFor } from './coach-live.js'
import { useCoachPre, currentPre } from '../store/useCoachPre.js'

const POLL_MS = 3000       // a job is running: often enough to feel live
const IDLE_MS = 60000       // a Coach screen is open but nothing is running

// The demo build has no backend, so it answers these locally with a canned proposal built
// from its own seeded profile (lib/coach-demo.js). Everything downstream — validation,
// staleness, apply, revert, the log — runs unchanged; only the provider is faked. The module
// is imported dynamically so none of it lands in a self-hosted bundle.
let demoMod = null
const demo = async () => (demoMod = demoMod || await import('./coach-demo.js'))
const S = () => useStore.getState().S
// Each request says which language the app is in: a profile that never picked one has no stored
// `lang` worth trusting — it is worked out per device (#303, lib/default-lang.js) — and the
// Coach should answer in what the person is reading.

// The mobile build's third answer: a phone that brought its own API key runs the Coach itself
// (lib/coach-local.js — the same core the server runs, imported lazily so the catalogue and the
// validator only ever load on a phone that chose this). A paired phone takes the api() branch
// like the web app does; nothing on the web or demo builds reaches this.
let localMod = null
const LOCAL = () => MOBILE && useStore.getState().coachLocal?.mode === 'byok'
const local = async () => {
  if (!localMod) {
    localMod = await import('./coach-local.js')
    // There is no admin card on a phone: the user is the operator, so failures go to them.
    localMod.setNotifier(ev => {
      const toast = useUI.getState().toast
      if (ev.kind === 'failed') toast(jobErrorText(ev.errorClass, ev.detail))
      else if (ev.kind === 'nochange') toast(t('Nothing to change right now: {0}', String(ev.reading || '').slice(0, 140)))
    })
  }
  return localMod
}

// The job this app last started and has not written a reply for yet. A run that fails before
// the first status poll — a provider refusing the connection answers in milliseconds — is never
// seen running, so "running, then gone" cannot be the only way the chat learns a run ended: it
// also compares the server's last outcome with the id the start request returned. Kept here,
// at module level, because the plan the intake asks for is started on another screen.
let awaited = null
const track = r => {
  if (r?.job?.id) awaited = r.job.id
  return r
}
export const awaitedJob = () => awaited
export const settleAwaited = id => { if (!id || awaited === id) awaited = null }

export const coachStatus = async () => DEMO ? (await demo()).demoStatus(S()) : LOCAL() ? (await local()).localStatus() : api('/api/coach/status')

// Weekly notes the server wrote while nobody was looking ride on the status poll until this
// profile's synced state holds them (lib/coach-digests.js). Taking one in is an ordinary local
// edit, pushed like any other, and the server stops handing it over once it sees it arrive — so
// the same notes come back for a poll or two, and only a new one opens an update.
function takeDigests(list) {
  const store = useStore.getState()
  if (!store.ready || !Array.isArray(list) || !freshDigests(store.S, list).length) return
  store.update(s => { adoptDigests(s, list) })
}
// The Coach's looks at the running cycle ride on the poll the same way, and are applied as
// they arrive: a correction to the weeks still to come takes effect without being approved, and
// the chat gets a line that shows what moved and can take it back (lib/coach-cycle.js). "Nothing
// to change" is only said in the chat when the look was asked for.
function takeLooks(list) {
  const store = useStore.getState()
  if (!store.ready || !Array.isArray(list)) return
  const fresh = freshLooks(store.S, list)
  if (fresh.length) {
    store.update(s => {
      for (const r of applyLooks(s, list)) {
        if (!r.nochange) appendChat(s, { role: 'coach', kind: 'adjusted', ref: r.id, text: r.summary })
        else if (r.manual) appendChat(s, { role: 'coach', kind: 'nochange', text: r.reading || t('Looked at your last session — the plan stands.') })
      }
    })
  }
  // Where there is no server to see the synced state, the looks are let go of by hand.
  if (list.length && DEMO) demo().then(m => m.demoLooksTaken(list.map(a => a.id))).catch(() => {})
  else if (list.length && LOCAL()) local().then(m => m.localLooksTaken(list.map(a => a.id))).catch(() => {})
}
/** Once when the app opens: take in what the Coach wrote while it was closed. The status poll
 *  only runs on the Coach's own screen, and a corrected weight has to be there before the session
 *  it is for, not after someone happens to open the chat. */
export async function syncCoachOnOpen() {
  try {
    const s = await coachStatus()
    takeDigests(s?.digests)
    takeLooks(s?.adjustments)
  } catch { /* the next open tries again */ }
}
const _requestAdjust = async note => DEMO ? (await demo()).demoAdjust(S()) : LOCAL() ? (await local()).localAdjust(S(), note) : api('/api/coach/adjust', { method: 'POST', body: JSON.stringify({ note: note || '', lang: getLang() }) })
export const requestAdjust = (...a) => _requestAdjust(...a).then(track)
const _requestReview = async note => DEMO ? (await demo()).demoReview(S()) : LOCAL() ? (await local()).localReview(S(), note) : api('/api/coach/review', { method: 'POST', body: JSON.stringify({ note: note || '', lang: getLang() }) })
export const requestReview = (...a) => _requestReview(...a).then(track)
const _requestPlan = async intake => DEMO ? (await demo()).demoPlan(S(), intake) : LOCAL() ? (await local()).localPlan(S(), intake) : api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ intake, lang: getLang() }) })
export const requestPlan = (...a) => _requestPlan(...a).then(track)
const _refinePlan = async text => DEMO ? (await demo()).demoRefine(S()) : LOCAL() ? (await local()).localRefine(S(), text) : api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ refine: text, lang: getLang() }) })
export const refinePlan = (...a) => _refinePlan(...a).then(track)
const _requestDebrief = async workoutId => DEMO ? (await demo()).demoDebrief(S(), workoutId) : LOCAL() ? (await local()).localDebrief(S(), workoutId) : api('/api/coach/debrief', { method: 'POST', body: JSON.stringify({ workoutId: workoutId || null, lang: getLang() }) })
export const requestDebrief = (...a) => _requestDebrief(...a).then(track)
// The room: anonymous medians across the profiles on this instance that opted in. Only a
// server has a room; a phone with its own key and the demo both answer locally.
export const cohortStats = async () => DEMO ? (await demo()).demoCohort(S()) : LOCAL() ? { ok: false, enabled: false } : api('/api/coach/cohort')
export const setCohortShare = async share => (DEMO || LOCAL()) ? { ok: true, sharing: !!share } : api('/api/coach/cohort/share', { method: 'POST', body: JSON.stringify({ share: !!share }) })
export const resolvePending = async body => DEMO ? (await demo()).demoResolve() : LOCAL() ? (await local()).localResolve(body) : api('/api/coach/pending/resolve', { method: 'POST', body: JSON.stringify(body) })
export const forgetCoach = async () => DEMO ? (await demo()).demoResolve() : LOCAL() ? (await local()).localForget() : api('/api/coach/forget', { method: 'POST', body: '{}' })
export const disclosure = async () => DEMO ? (await demo()).demoDisclosure() : LOCAL() ? (await local()).localDisclosure() : api('/api/coach/disclosure')

/* ---------- a question asked during a workout ----------
   Answered in the request that asks it (POST /api/coach/live), not by a job, so there is nothing
   to poll. The exchange is kept on the workout itself (lib/coach-live.js) and the sheet that shows
   it reads the store; this only sees the request through, which may outlast the sheet it was
   typed in: someone asks, closes the sheet and does their set.

   The server gives a question 90 seconds. The request waits a little longer, so that what comes
   back is the server's answer or its refusal and not this side's own timeout. A request that
   died on the way (a gym's wifi), or met "still answering", is sent again under the same turn
   id, which is answered once however often it is asked. */
export const LIVE_REQUEST_MS = 110000
const LIVE_RETRY_MS = [2500, 5000, 8000]
const LIVE_RETRY_WITHIN_MS = 150000
const asking = new Set()   // turns with a request in flight, in this run of the app
/** Whether the question sent under `turn` is still on its way. One the app was reloaded under
 *  is not: its line stays in the workout, and the sheet offers to ask it again. */
export const isAsking = turn => asking.has(turn)
// The sheet says when it is on screen, and how to bring it back: an answer that arrives after it
// was closed is announced, with a way to it.
let liveSheet = { open: () => false, show: null }
export function setLiveSheet(hooks) { liveSheet = { ...liveSheet, ...hooks } }
let preSheet = { open: () => false, show: null }
export function setPreSheet(hooks) { preSheet = { ...preSheet, ...hooks } }

/* Where a question is asked. During a workout it is `S.active`. Before one it is the workout
   Start would build, prepared and held aside until then (lib/coach-pre.js, store/useCoachPre.js);
   the request, the retries and what is written back are the same, so the two differ only in
   where the workout is read from and written to. */
const DURING = {
  session: () => S().active,
  change: fn => useStore.getState().update(s => { if (s.active) fn(s.active) }),
  sheet: () => liveSheet,
}
const BEFORE = {
  session: () => currentPre()?.session || null,
  change: fn => useCoachPre.getState().change(p => fn(p.session)),
  sheet: () => preSheet,
}

const _askLive = async body => DEMO ? (await demo()).demoLive(S(), body) : LOCAL() ? (await local()).localLive(S(), body) : api('/api/coach/live', { method: 'POST', timeout: LIVE_REQUEST_MS, body: JSON.stringify({ ...body, lang: getLang() }) })
const classOf = e => e?.data?.code || e?.code || null

async function sendLive(turn, line, where) {
  const began = Date.now()
  for (let i = 0; ; i++) {
    const A = where.session()
    if (!canAskLive(A)) throw Object.assign(new Error('no workout under way'), { status: 400, code: 'nolive' })
    // What was said stays here: the thread goes along cut to what the server reads of it.
    const { coachTalk, ...session } = A
    try {
      return await _askLive({ text: line.text, session, focus: Number.isInteger(line.focus) ? line.focus : A.cur, thread: threadFor(A), turnId: turn })
    } catch (e) {
      // Worth another try: the last question is still being answered, or the request never got
      // there or back. A refusal with a reason is the answer.
      const again = classOf(e) === 'busy' || (!e?.status && classOf(e) !== 'not-paired')
      if (!again || i >= LIVE_RETRY_MS.length || Date.now() - began > LIVE_RETRY_WITHIN_MS) throw e
      await new Promise(done => setTimeout(done, LIVE_RETRY_MS[i]))
    }
  }
}

/**
 * Ask the Coach about the workout under way. `text` is a new question from the exercise at
 * `focus`; `retry` is the id of one already in the workout that got no answer. The question is
 * written into the workout first and the answer, or the reason there is none, when it comes;
 * nothing is returned that the store does not hold.
 */
export const askCoachLive = args => ask(args, DURING)

/** The same, asked before the workout is started, about the one prepared for today. */
export const askCoachPre = args => ask(args, BEFORE)

async function ask({ text, focus, retry } = {}, where) {
  const store = useStore.getState()
  const active = where.session()
  if (!store.ready || !canAskLive(active)) return false
  const workout = active.id
  const turn = retry || newTurnId()
  if (asking.has(turn)) return false
  asking.add(turn)
  try {
    if (!retry) where.change(a => { addQuestion(a, { id: turn, text, focus }) })
    // Asking again takes the old reason away, so the sheet shows the wait and not the failure.
    else where.change(a => { a.coachTalk = talkOf(a).filter(m => !(m && m.turn === turn && m.error)) })
    const line = talkOf(where.session()).find(m => m && m.who === 'user' && m.id === turn)
    if (!line) return false
    let answer = null, failure = null
    try { answer = await sendLive(turn, line, where) } catch (e) { failure = e }
    asking.delete(turn)
    // Written only into the workout it was asked in: one finished or discarded meanwhile is gone,
    // and so is one prepared for a day that was since given another session.
    where.change(a => {
      if (a.id !== workout) return
      if (answer) addAnswer(a, turn, answer)
      else addFailure(a, turn, classOf(failure) || (failure?.status ? 'internal' : 'lost'), LOCAL() ? (failure?.data?.detail || failure?.detail) : null)
    })
    const sheet = where.sheet()
    if (answer && !sheet.open() && where.session()?.id === workout) {
      useUI.getState().toast(t('The Coach answered.'), sheet.show ? { action: t('Show'), onAction: () => sheet.show() } : undefined)
    }
    return !!answer
  } finally {
    asking.delete(turn)
  }
}

/* Whose provider account this profile is about to spend. Its own call because the constraint is
   that the Coach screen states it too, not just the admin card — and because in instance mode a
   second profile is refused outright, which is something the user has to be able to read before
   they ask for anything rather than after a job is turned down. */
export const coachAccount = async () =>
  DEMO ? { mode: 'instance', provider: 'demo', providerLabel: 'Demo', account: null, connected: true, reason: null, message: null }
    : LOCAL() ? { mode: 'device', provider: useStore.getState().coachLocal.provider, providerLabel: null, account: null, connected: true, reason: null, message: null }
      : api('/api/coach/account')

/* Admin-only. The token is write-only from the client's side: it goes up once and is never
   read back, so there is deliberately no "show me the current credential" call to pair with it. */
export const connectCredential = body => api('/api/admin/coach/connect', { method: 'POST', body: JSON.stringify(body) })
export const disconnectCredential = () => api('/api/admin/coach/disconnect', { method: 'POST', body: '{}' })

/**
 * Live job/proposal state.
 *
 * `active` lets a caller (the Home card) subscribe only while it is mounted and visible;
 * everything else keeps the poll off. Errors are swallowed on purpose — a Coach status call
 * failing while you are mid-workout is not something to interrupt anyone about.
 */
export function useCoachStatus(active = true) {
  const [state, setState] = useState({ job: null, pending: null, cap: null, loading: true })
  const timer = useRef(null)
  const loop = useRef(null)   // the running poll loop's `tick`, so a manual refresh can re-pace it
  const seq = useRef(0)       // which status request is the newest one

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const s = await coachStatus()
      takeDigests(s?.digests)
      takeLooks(s?.adjustments)
      // An answer that arrives after a newer request was sent is older than what that request
      // will bring: the idle poll in flight when a run is started must not land after the
      // refresh that follows the start, putting back the run count and last outcome from before.
      if (mine !== seq.current) return s
      setState({ ...s, loading: false })
      // A refresh that finds a job in flight — the one the caller just started — must not leave
      // the loop asleep on its idle cadence: without this the card shows up to a minute after
      // the job ended, sitting on "thinking…" the whole time.
      if (s?.job && loop.current) { clearTimeout(timer.current); timer.current = setTimeout(loop.current, POLL_MS) }
      return s
    } catch {
      if (mine === seq.current) setState(s => ({ ...s, loading: false }))
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let stopped = false
    const tick = async () => {
      const s = await refresh()
      if (stopped) return
      clearTimeout(timer.current)
      timer.current = setTimeout(tick, s?.job ? POLL_MS : IDLE_MS)
    }
    loop.current = tick
    tick()
    return () => { stopped = true; loop.current = null; clearTimeout(timer.current) }
  }, [active, refresh])

  return { ...state, refresh }
}

// Server failure classes, in the app's voice. The provider's own words go to the admin card;
// what a lifter needs is what it means for them and whether trying again will help.
//
// Each line is a getter, so it is translated when it is read, not when this module loads: the
// module loads once, in English, before any locale pack has arrived, and a language picked later
// would otherwise never reach these lines. The lookup is still JOB_ERRORS[cls].
export const JOB_ERRORS = {
  get off() { return t('The Coach isn’t set up on this instance.') },
  get busy() { return t('The Coach is already thinking about your training.') },
  get cap() { return t('The Coach is taking a rest day. Try again tomorrow.') },
  get consent() { return t('The Coach needs your go-ahead first.') },
  get timeout() { return t('The Coach took too long and gave up.') },
  get auth() { return t('The Coach couldn’t sign in to its provider. The instance owner needs to check its setup.') },
  get missing() { return t('The Coach isn’t installed properly on this instance.') },
  get provider() { return t('The Coach couldn’t run. The instance owner needs to check its setup.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get restart() { return t('The server restarted while the Coach was thinking.') },
  get nostate() { return t('The Coach couldn’t read your training data.') },
  get noworkout() { return t('There’s no workout to look at yet. Log one first.') },
  // The refusal at enqueue when the process cannot drop privileges (api/coach/jobs.js). The same
  // words as api/coach/routes.js USER_ERROR.unprivileged; what to fix goes to the admin card.
  get unprivileged() { return t('The Coach is switched off on this instance for safety reasons.') },
  // A question asked during a workout is answered in the request that asked it, so what a job
  // would report through the status poll is that request's own refusal (POST /api/coach/live).
  get empty() { return t('There’s nothing to answer yet. Type your question first.') },
  get nolive() { return t('There’s no workout under way to ask about.') },
  get livecap() { return t('The Coach has answered all it can during workouts today. Try again tomorrow.') },
  get toolarge() { return t('This workout is too large for the Coach to read.') },
  get forgotten() { return t('The Coach was switched off for this profile while it was answering.') },
  // Not the server's: the request never got there, or its answer never got back.
  get lost() { return t('No answer came back. Check your connection and ask again.') },
  get internal() { return t('Something went wrong on the server.') }
}

// The same failures on a phone that brought its own key: there is no instance owner to
// check anything, the person reading this is the operator, and the provider's own words
// are the only thing that lets them fix it (a spent quota, a wrong model, a rejected key).
export const BYOK_ERRORS = {
  get auth() { return t('Your AI provider rejected the key on this phone. Check it under Settings → AI Coach.') },
  get missing() { return t('The Coach isn’t set up on this phone. Check Settings → AI Coach.') },
  get provider() { return t('Your AI provider couldn’t answer.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get internal() { return t('Something went wrong on this phone.') }
}

/** The line the person sees for a failed job — with the reason attached where they can act on it. */
export function jobErrorText(cls, detail) {
  const own = LOCAL()
  const base = (own && BYOK_ERRORS[cls]) || JOB_ERRORS[cls] || (own ? BYOK_ERRORS.internal : JOB_ERRORS.internal)
  const why = own && detail ? String(detail).trim().slice(0, 300) : ''
  return why ? `${base}\n${why}` : base
}
