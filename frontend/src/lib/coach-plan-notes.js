// What a plan card says about where a plan comes from, and where it departs from the usual advice.
//
// Besides the plan itself, a created plan carries up to four things the validator put on it
// (api/coach/core/validate.js):
//
//   program      the catalogue programme it was built from — name, author and link, read from the
//                catalogue by code (api/coach/core/kb.js), never from the model's answer
//   own          the plan is one the person brought themselves, and the Coach laid it out
//   advisories   counted facts about the plan (api/coach/core/plan-load.js advisoriesOf): a code
//                and the numbers behind it, with nothing worded
//   differences  for an own plan, the Coach's own lines on where it departs from the principles
//
// The server words nothing for the reader, because it does not know their language; this file
// does. Pure, so the sentences can be tested without a screen.
import { t } from './i18n.js'
import { DAYN } from './format.js'

// The body parts the counts are made by, in the words the review card already uses for them.
const BP_LABEL = {
  back: 'Back muscles', chest: 'Chest', 'lower arms': 'Forearms', 'lower legs': 'Calves', neck: 'Neck',
  shoulders: 'Shoulders', 'upper arms': 'Arms', 'upper legs': 'Legs', waist: 'Core'
}
const bpLabel = bp => t(BP_LABEL[bp] || bp)

// Which session a note is about: the days the week trains it on, and the routine by name. A
// routine no day schedules has only its name.
function sessionLabel(a) {
  const days = (Array.isArray(a.weekdays) ? a.weekdays : []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6).map(d => t(DAYN[d]))
  const name = typeof a.routine === 'string' ? a.routine : ''
  if (days.length) return days.join(', ') + (name ? ' (' + name + ')' : '')
  return name
}

/** One advisory as a sentence, or null for a code this build does not know. */
export function advisoryLine(a) {
  if (!a || typeof a !== 'object') return null
  switch (a.code) {
    case 'weekly-over': return t('Weekly sets for {0}: {1} — above the usual ceiling of {2}.', bpLabel(a.bp), a.sets, a.max)
    case 'weekly-under': return t('Weekly sets for {0}: {1} — below the usual minimum of {2}.', bpLabel(a.bp), a.sets, a.min)
    case 'session-over': return t('{0}: about {1} min by the app’s estimate — over the {2} min you set.', sessionLabel(a), a.minutes, a.cap)
    case 'session-part-over': return t('{0}: {1} sets for {2} in one session — more than the usual {3}.', sessionLabel(a), a.sets, bpLabel(a.bp), a.max)
    default: return null
  }
}

/**
 * Everything the card lists under the plan: the counted notes first, then the Coach's own lines.
 * @returns {string[]}
 */
export function planNoteLines(bundle) {
  const counted = (Array.isArray(bundle?.advisories) ? bundle.advisories : []).map(advisoryLine).filter(Boolean)
  const said = (Array.isArray(bundle?.differences) ? bundle.differences : []).filter(x => typeof x === 'string' && x.trim())
  return [...counted, ...said]
}

/**
 * Where the plan comes from, as the card's one line: their own plan, a catalogue programme, or
 * both when their plan names one. Null when the plan rests on neither.
 * @returns {{ text: string, source: string|null } | null}
 */
export function planBasis(bundle) {
  const p = bundle?.program && typeof bundle.program === 'object' && typeof bundle.program.name === 'string' ? bundle.program : null
  const own = bundle?.own === true
  if (!p && !own) return null
  const name = p ? p.name + (p.author ? ' · ' + p.author : '') : ''
  // Only a web address is ever turned into a link.
  const source = p && typeof p.source === 'string' && /^https:\/\//.test(p.source) ? p.source : null
  if (own) return { text: p ? t('Your own plan, after {0}', name) : t('Built from your own plan'), source }
  return { text: t('Based on {0}', name), source }
}
