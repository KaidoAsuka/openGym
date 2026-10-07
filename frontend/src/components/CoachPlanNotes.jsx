// Under a created plan: what it was built from, and where it departs from the usual advice.
//
// Two blocks, either of which may be absent. The first names the catalogue programme the plan
// follows, or says the plan is the person's own. The second lists what the app counted about the
// plan and, for an own plan, what the Coach noted — as notes: a plan someone brought themselves
// is never refused over a count (lib/coach-plan-notes.js).
import { t } from '../lib/i18n.js'
import { planBasis, planNoteLines } from '../lib/coach-plan-notes.js'
import Icon from './Icon.jsx'

export function PlanBasis({ bundle }) {
  const basis = planBasis(bundle)
  if (!basis) return null
  return <p className="pcard-sum pcard-basis">
    <b>{basis.text}</b>
    {basis.source && <> · <a href={basis.source} target="_blank" rel="noopener noreferrer">{t('Source')}</a></>}
  </p>
}

export default function CoachPlanNotes({ bundle }) {
  const lines = planNoteLines(bundle)
  if (!lines.length) return null
  const own = bundle?.own === true
  return <div className="pcard-notes pcard-differs">
    <div className="pcard-differs-h">{own ? t('Where this differs from the usual advice') : t('Worth knowing')}</div>
    {lines.map((l, i) => <div key={i}><Icon name="lightbulb" />{l}</div>)}
    {own && <div className="pcard-differs-f">{t('Noted, not blocked — it is your plan.')}</div>}
  </div>
}
