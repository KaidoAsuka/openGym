// Weekly notes — what the Coach wrote down about each week, opened from its menu.
//
// Read-only. The notes are the Coach's own memory of weeks whose sessions a later review no
// longer reads set by set (lib/coach-digests.js), and this is where a person can see what that
// memory holds: the week's counts as the app took them from the log, and under them what the
// Coach made of it.
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { fmtDateRange, fmtDur } from '../lib/format.js'
import { digestList } from '../lib/coach-digests.js'
import { FlagTags } from '../components/ExerciseFlags.jsx'
import Icon from '../components/Icon.jsx'

const LISTS = [
  ['progress', 'arrowUp', 'var(--green)', 'What moved forward'],
  ['issues', 'warning', 'var(--yellow)', 'What got in the way'],
  ['carry', 'sparkles', 'var(--acc)', 'Worth watching'],
]

/** The week in numbers, as one line: only the counts the note actually carries. */
function countsLine(g) {
  const parts = []
  if (g.sessions != null) parts.push(g.planned ? t('{0} of {1} sessions', g.sessions, g.planned) : t('{0} sessions', g.sessions))
  if (g.sets) parts.push(t('{0} sets', g.sets))
  if (g.minutes) parts.push(fmtDur(g.minutes * 60000))
  if (g.prs) parts.push(g.prs + ' ' + t('PRs'))
  return parts.join(' · ')
}

function Note({ g }) {
  const counts = countsLine(g)
  return <div className="pcard" data-week={g.from} style={{ marginBottom: 12 }}>
    <div className="pcard-hd">
      <div className="pcard-eyebrow">{fmtDateRange(g.from, g.to)}</div>
      {!!counts && <p className="pcard-sum" style={{ fontSize: 13, marginTop: 0 }}>{counts}</p>}
      <FlagTags flags={Object.keys(g.marks || {})} style={{ marginTop: 6 }} />
      <p className="pcard-sum" style={{ color: 'var(--label)' }}>{g.summary}</p>
    </div>
    {LISTS.map(([key, icon, tint, title]) => !!g[key]?.length && <div key={key} className="deb-list">
      <div className="deb-list-h" style={{ color: tint }}><Icon name={icon} />{t(title)}</div>
      {g[key].map((x, i) => <div key={i} className="deb-item">{x}</div>)}
    </div>)}
    <div style={{ height: 8 }} />
  </div>
}

export default function DigestsSheet() {
  const S = useStore(s => s.S)
  const notes = digestList(S)
  return <div className="chat-menu">
    <h3>{t('Weekly notes')}</h3>
    {!notes.length && <div className="chat-empty">{t('Nothing yet. After each week you train, the Coach writes a short note on it here and reads the notes back at every review.')}</div>}
    {notes.map(g => <Note key={g.from} g={g} />)}
    <div style={{ height: 10 }} />
  </div>
}
