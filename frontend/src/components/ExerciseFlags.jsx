// The marks on an exercise (lib/exercise-flags.js): the row that sets them in the note sheet,
// and the same marks read-only wherever that note is shown.
import { t } from '../lib/i18n.js'
import { FLAG_KINDS, FLAG_LABEL, cleanFlags, toggleFlag } from '../lib/exercise-flags.js'

export function FlagPicker({ value, onChange, style }) {
  const on = cleanFlags(value)
  return <div className="row" role="group" style={{ gap: 6, flexWrap: 'wrap', ...style }}>
    {FLAG_KINDS.map(k => <button key={k} type="button" data-flag={k}
      className={'chip nocap' + (on.includes(k) ? ' on' : '')} aria-pressed={on.includes(k)}
      onClick={() => onChange(toggleFlag(on, k))}>{t(FLAG_LABEL[k])}</button>)}
  </div>
}

export function FlagTags({ flags, style }) {
  const on = cleanFlags(flags)
  if (!on.length) return null
  return <div className="row" style={{ gap: 6, flexWrap: 'wrap', ...style }}>
    {on.map(k => <span key={k} data-flag={k} className="tag nocap"
      style={k === 'pain' ? { color: 'var(--red)' } : undefined}>{t(FLAG_LABEL[k])}</span>)}
  </div>
}
