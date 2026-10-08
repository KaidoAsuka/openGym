// The Coach, on a phone that brings its own API key.
//
// No server. The pipeline the server runs — payload allowlist, prompt, provider call, parser,
// validator, one repair round — is imported from api/coach/core and run here, in-process, so
// the phone gets exactly the code the server has and not a second opinion of it. The apply
// engine, staleness, snapshot/revert and the log are the ones every build already uses.
//
// This module is the one static importer of the core, which makes `import('./coach-local.js')`
// the whole lazy chunk: the exercise catalogue, the prompts and the validator arrive together
// and only after the user chose this mode. coach-api.js dispatches here the same way it
// dispatches to the demo provider, so the screens never learn that there is no server.
//
// What is different from the server, and on purpose:
//   - the user pays. There is no cfg.caps to lean on, so a local daily cap is not optional.
//   - the pseudonym is drawn at random once and kept, rather than derived from a secret.
//   - a proposal waits in the device file, not in S, so it survives an app kill without
//     riding into a backup or a sync.
import * as payloadLib from '../../../api/coach/core/payload.js'
import { runPipeline } from '../../../api/coach/core/pipeline.js'
import { HTTP_PROVIDERS, baseUrlFor } from '../../../api/coach/core/providers.js'
import anthropic from '../../../api/coach/core/adapters/anthropic.js'
import openai from '../../../api/coach/core/adapters/openai.js'
import gemini from '../../../api/coach/core/adapters/gemini.js'
import compatible from '../../../api/coach/core/adapters/compatible.js'
import { nativeFetch } from './capacitor-fetch.js'
import { getApiKey } from './coach-secrets.js'
import { loadCoachDevice, saveCoachDevice } from './coach-device.js'
import { planHash } from './coach.js'
import { todayISO } from './format.js'
import { t, getLang } from './i18n.js'

export const ADAPTERS = { anthropic, openai, gemini, compatible }
export const LOCAL_DAILY_CAP = 10
// Questions asked during a workout are counted on their own, as on a server (caps.livePerProfileDaily):
// a session's worth of them must not use up the runs a review needs.
export const LOCAL_LIVE_DAILY_CAP = 30
// What a server gives one of those questions (api/coach/jobs.js): someone is standing at the bar.
export const LIVE_TIMEOUT_MS = 90000
const LIVE_MAX_TOKENS = 2000
// Five minutes is right for a cloud API and wrong for a model on somebody's laptop; the
// OpenAI-compatible endpoint is the one that may be local, so it gets the long budget.
export const TIMEOUT_MS = 5 * 60000
export const LOCAL_ENDPOINT_TIMEOUT_MS = 25 * 60000
export const timeoutFor = provider => (provider === 'compatible' ? LOCAL_ENDPOINT_TIMEOUT_MS : TIMEOUT_MS)
const PENDING_DAYS = 14
const HANDLE_LENGTH = 16

let job = null
let lastError = null
let last = null   // how the most recent job ended — the same shape the server's status() reports
// Reported to the screens through the same status shape the server answers with; a toast is
// also raised because on the server a failed job lands in the admin card, and here there is
// no admin card — the user is the operator.
let notify = null
export function setNotifier(fn) { notify = fn }

/* ---------- what this phone is configured with ---------- */

const cfgOf = d => ({ provider: d.provider, providerOptions: d.baseUrl ? { [d.provider]: { baseUrl: d.baseUrl } } : {} })
const envOf = (d, key) => (key ? { [HTTP_PROVIDERS[d.provider].apiKeyEnv]: key } : {})

function mintHandle() {
  const bytes = new Uint8Array(12)
  ;(globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256) })
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, HANDLE_LENGTH)
}
async function handle() {
  const d = await loadCoachDevice()
  if (d.handle && d.handle.length === HANDLE_LENGTH) return d.handle
  const h = mintHandle()
  await saveCoachDevice({ handle: h })
  return h
}

/* ---------- the cap ---------- */

async function capState() {
  const d = await loadCoachDevice()
  const today = todayISO()
  const used = d.daily && d.daily.d === today ? d.daily.n : 0
  return { used, limit: LOCAL_DAILY_CAP }
}
async function bumpDaily() {
  const { used } = await capState()
  await saveCoachDevice({ daily: { d: todayISO(), n: used + 1 } })
}

/* ---------- the API surface coach-api.js dispatches to ---------- */

export async function localStatus() {
  const d = await loadCoachDevice()
  if (d.pending && d.pending.expiresAt && d.pending.expiresAt < Date.now()) await saveCoachDevice({ pending: null })
  const now = await loadCoachDevice()
  return { job, pending: now.pending || null, cap: await capState(), lastError, last, ...(now.adjustments?.length ? { adjustments: now.adjustments } : {}) }
}

export const localReview = (S, note) => start(S, 'review', { note: note ? String(note).slice(0, 1000) : null })
export const localPlan = (S, intake) => start(S, 'create', { intake: intake || null })
export const localRefine = async (S, text) => {
  const d = await loadCoachDevice()
  const pendingCreate = d.pending && d.pending.kind === 'create' ? d.pending : null
  return start(S, 'create', { refine: String(text || '').slice(0, 1000), previous: pendingCreate?.bundle || null, iteration: (pendingCreate?.iteration || 1) + 1 })
}
export const localDebrief = (S, workoutId) => start(S, 'debrief', { workoutId: workoutId || null })
// A look at the running cycle. A phone has no scheduler, so this is the only way one happens
// here: asked for from the cycle's own screen.
export const localAdjust = (S, note) => start(S, 'adjust', { note: note ? String(note).slice(0, 1000) : null })
/* A question asked during a workout, answered in this call rather than by a job the screens poll
   for (the server's liveTurn, api/coach/jobs.js). It does not wait behind a running job, it is
   counted against a cap of its own, and one is answered at a time. Refusals carry the server's
   classes, so the sheet words them the same way. */
let liveBusy = false
const refuse = (status, code, detail) => Object.assign(new Error(code), { status, code, ...(detail ? { detail } : {}) })
async function liveCapState() {
  const d = await loadCoachDevice()
  const used = d.liveDaily && d.liveDaily.d === todayISO() ? d.liveDaily.n : 0
  return { used, limit: LOCAL_LIVE_DAILY_CAP }
}
export async function localLive(S, body = {}) {
  if (liveBusy) throw refuse(409, 'busy')
  // Taken before the first await: two questions sent in the same moment would both read the
  // device file while neither had been counted.
  liveBusy = true
  try {
    if (!S?.coach?.consent?.agreedAt) throw refuse(403, 'consent')
    const d = await loadCoachDevice()
    const adapter = ADAPTERS[d.provider]
    if (d.mode !== 'byok' || !adapter) throw refuse(503, 'off')
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : ''
    if (!text) throw refuse(400, 'empty')
    const live = payloadLib.liveContext(S, body.session)
    if (!live) throw refuse(400, 'nolive')
    const cap = await liveCapState()
    if (cap.used >= cap.limit) throw refuse(429, 'livecap')
    const payload = payloadLib.build(S, { handle: await handle(), kind: 'live', live: body.session, focus: body.focus, thread: body.thread, note: text, lang: getLang() })
    if (JSON.stringify(payload).length > payloadLib.MAX_PAYLOAD_CHARS) throw refuse(413, 'toolarge')
    // Counted when the call is about to be made, as a job is when it starts.
    await saveCoachDevice({ liveDaily: { d: todayISO(), n: cap.used + 1 } })
    const key = await getApiKey()
    const attempt = await runPipeline({
      adapter, cfg: cfgOf(d), kind: 'live', payload, live,
      model: d.model || HTTP_PROVIDERS[d.provider].defaultModel, timeoutMs: LIVE_TIMEOUT_MS,
      invokeOpts: { env: envOf(d, key), fetch: nativeFetch, maxTokens: LIVE_MAX_TOKENS }
    })
    if (!attempt.ok) {
      // The provider's own words, or the validator's: on a phone the person asking is the operator.
      const detail = attempt.detail || (Array.isArray(attempt.errors) && attempt.errors.length ? attempt.errors.slice(0, 3).map(String).join(' · ').slice(0, 300) : null)
      throw refuse(attempt.errorClass === 'timeout' ? 504 : 502, attempt.errorClass || 'internal', detail)
    }
    return { id: 'local-' + Date.now().toString(36), ...attempt.result, cap: { used: cap.used + 1, limit: cap.limit } }
  } finally {
    liveBusy = false
  }
}
/** The looks the app has applied are no longer held for it. */
export async function localLooksTaken(ids) {
  const d = await loadCoachDevice()
  const left = (d.adjustments || []).filter(a => !ids.includes(a.id))
  if (left.length !== (d.adjustments || []).length) await saveCoachDevice({ adjustments: left })
  return { ok: true }
}
export async function localResolve() { await saveCoachDevice({ pending: null }); return { ok: true } }
export async function localForget() { job = null; lastError = null; await saveCoachDevice({ pending: null, daily: null, adjustments: [] }); return { ok: true } }

export async function localDisclosure() {
  const d = await loadCoachDevice()
  const meta = HTTP_PROVIDERS[d.provider] || {}
  const base = d.provider ? baseUrlFor(d.provider, cfgOf(d)) : ''
  return {
    provider: d.provider, providerLabel: meta.label || t('the configured AI provider'),
    categories: payloadLib.DATA_CATEGORIES, version: 1,
    // The honest difference from the self-hosted flow: it is the user's own account.
    payer: 'you', host: hostOf(base)
  }
}

/** The models the configured endpoint serves — the setup screen's list, and its reachability test. */
export async function localModels(settings, key) {
  const adapter = ADAPTERS[settings.provider]
  if (!adapter) return { ok: false, error: 'unknown provider', models: [] }
  return adapter.models(cfgOf(settings), envOf(settings, key), { fetch: nativeFetch, timeoutMs: 20000 })
}

const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }

/* ---------- running a job ---------- */

async function start(S, kind, opts) {
  if (job) throw Object.assign(new Error(t('The Coach is already thinking about your training.')), { status: 409, code: 'busy' })
  if (!S?.coach?.consent?.agreedAt) throw Object.assign(new Error(t('The Coach needs your go-ahead first.')), { status: 403, code: 'consent' })
  const d = await loadCoachDevice()
  const adapter = ADAPTERS[d.provider]
  if (d.mode !== 'byok' || !adapter) throw Object.assign(new Error(t('The Coach isn’t set up on this phone.')), { status: 503, code: 'off' })
  const cap = await capState()
  if (cap.used >= cap.limit) throw Object.assign(new Error(t('The Coach is taking a breather. You’ve used today’s {0} runs on this phone.', cap.limit)), { status: 429, code: 'cap' })

  await bumpDaily()
  job = { id: 'local-' + Date.now().toString(36), kind, state: 'running', startedAt: Date.now() }
  lastError = null
  // Not awaited: the screens poll, exactly as they do against a server.
  run(S, kind, opts, d, adapter).catch(e => { lastError = { errorClass: 'internal', detail: String(e && e.message || e) } }).finally(() => { job = null })
  return { job }
}

async function run(S, kind, opts, d, adapter) {
  const key = await getApiKey()
  const payload = payloadLib.build(S, {
    handle: await handle(), kind, intake: opts.intake, note: opts.note, refine: opts.refine, previous: opts.previous, workoutId: opts.workoutId,
    lang: getLang()   // what the app shows, which a profile that never picked a language does not store (#303)
  })
  // A look needs a cycle to look at, and its answer is checked against that cycle.
  const cycle = kind === 'adjust' ? payloadLib.cycleContext(S) : null
  if (kind === 'adjust' && !cycle) {
    lastError = { errorClass: 'nocycle', detail: null }
    last = { id: job.id, kind, outcome: 'failed', errorClass: 'nocycle', at: Date.now() }
    if (notify) notify({ kind: 'failed', errorClass: 'nocycle', detail: null })
    return
  }
  const attempt = await runPipeline({
    adapter, cfg: cfgOf(d), kind, payload, cycle,
    model: d.model || HTTP_PROVIDERS[d.provider].defaultModel, timeoutMs: timeoutFor(d.provider),
    invokeOpts: { env: envOf(d, key), fetch: nativeFetch }
  })
  if (!attempt.ok) {
    // There is no admin card on a phone, so the reason has to reach the person holding it:
    // the provider's own words for a refusal, the validator's for an answer that did not fit.
    const detail = attempt.detail || (Array.isArray(attempt.errors) && attempt.errors.length
      ? attempt.errors.slice(0, 3).map(String).join(' · ').slice(0, 300)
      : null)
    lastError = { errorClass: attempt.errorClass, detail }
    last = { id: job.id, kind, outcome: 'failed', errorClass: attempt.errorClass, at: Date.now() }
    if (notify) notify({ kind: 'failed', errorClass: attempt.errorClass, detail })
    return
  }
  if (kind === 'adjust') {
    // Not a proposal: kept until the app has applied it (lib/coach-cycle.js), then let go of.
    const look = {
      id: job.id, at: Date.now(), cycle: S.coach.cycle.id, week: cycle.week, manual: true,
      ...(attempt.nochange ? { nochange: true, reading: attempt.reading || '' } : attempt.result)
    }
    const held = (await loadCoachDevice()).adjustments || []
    await saveCoachDevice({ adjustments: [...held, look].slice(-14) })
    return
  }
  if (attempt.nochange) {
    last = { id: job.id, kind, outcome: 'nochange', errorClass: null, at: Date.now(), reading: attempt.reading }
    if (notify) notify({ kind: 'nochange', reading: attempt.reading })
    return
  }
  const pending = {
    id: job.id, kind, createdAt: Date.now(), expiresAt: Date.now() + PENDING_DAYS * 86400000,
    planHash: planHash(S), iteration: opts.iteration || 1,
    ...(kind === 'debrief' ? { workout: workoutMetaOf(S, opts.workoutId) } : {}),
    ...attempt.result
  }
  await saveCoachDevice({ pending })
  last = { id: job.id, kind, outcome: 'ready', errorClass: null, at: Date.now() }
  if (notify) notify({ kind: 'ready', pending })
}

// The session a debrief is about, in the shape the card reads. The core builds it for the
// server; the fallback covers a core that predates it.
function workoutMetaOf(S, workoutId) {
  if (typeof payloadLib.workoutMeta === 'function') return payloadLib.workoutMeta(S, workoutId)
  const all = (S.workouts || []).filter(w => w && w.d)
  const w = all.find(x => x.id === workoutId) || all[all.length - 1]
  return w ? { id: w.id, d: w.d, name: w.name || null } : null
}

// Test seam.
export function _resetLocal() { job = null; lastError = null; last = null; liveBusy = false }
