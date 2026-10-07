// The cycle — the weeks of a Coach plan when they are not all the same week.
//
// Three things to look at, all read from lib/coach-cycle.js:
//
//   CycleOutline  the weeks, one under the other: what each is for and what each routine's
//                 exercises are done at. On a plan that is still waiting, and on the sheet.
//   LookCard      one correction the Coach made after reading a session — which numbers moved,
//                 from what to what, and why — with the way to take it back. In the chat.
//   CycleSheet    the running cycle, opened from the Coach's menu: where it stands, the weeks,
//                 what the Coach last said, and a button to have it look now.
//
// A correction to sets, reps or a weight takes effect without being approved; that is the point
// of a plan that is corrected as it is trained. So every one of them is shown with its reason,
// and the latest can be undone from here or from the chat.
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { exLine } from '../lib/history.js'
import { speedUnitOf } from '../lib/speed.js'
import { exName, appendChat } from '../lib/coach.js'
import { cycleView, lookEntry, undoable, undoLook } from '../lib/coach-cycle.js'
import { requestAdjust } from '../lib/coach-api.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const dayOf = at => fmtDate(new Date(at).toISOString().slice(0, 10))

/** The weeks of a cycle. `view` is cycleView() or bundleCycleView(); the current week opens itself. */
export function CycleOutline({ view, unit, speedUnit }) {
  const [open, setOpen] = useState(() => view?.rows.find(r => r.current)?.week ?? 1)
  if (!view?.rows?.length) return null
  return <div className="cyc">
    {view.rows.map(w => <div key={w.week} className={'cyc-w' + (w.current ? ' now' : '')}>
      <button className="cyc-h" onClick={() => setOpen(open === w.week ? null : w.week)} aria-expanded={open === w.week}>
        <span className="cyc-n">{t('Week {0}', w.week)}{w.current && <em>{t('This week')}</em>}</span>
        <span className="cyc-f">{w.focus || (w.rough ? t('As the week before, until the Coach fills it in.') : '')}</span>
        <Icon name="chevronRight" className={'cyc-c' + (open === w.week ? ' on' : '')} />
      </button>
      {open === w.week && <div className="cyc-b">
        {w.rough && !!w.focus && <div className="cyc-r">{t('As the week before, until the Coach fills it in.')}</div>}
        {w.sessions.map(sn => <div key={sn.id} className="cyc-s">
          <div className="cyc-s-n">{sn.name}</div>
          {sn.ex.map(e => <div key={e.id} className="cyc-e"><span>{e.name}</span><span>{exLine(e, unit, speedUnit)}</span></div>)}
        </div>)}
      </div>}
    </div>)}
  </div>
}

// One number that moved: "3 × 8 · 60 kg" before and after, for the exercise it belongs to.
function ChangeLine({ c, S }) {
  const routine = (S.routines || []).find(r => r.id === c.routine)
  const planned = routine?.ex?.find(e => e.id === c.exId) || { id: c.exId }
  const line = n => exLine({ ...planned, ...n }, S.unit, speedUnitOf(S))
  const after = { ...c.before, ...Object.fromEntries(['sets', 'reps', 'sec', 'weight'].filter(k => c[k] != null).map(k => [k, c[k]])) }
  return <div className="pcard-chg">
    <div className="grow">
      <div className="pcard-chg-t">{exName(c.exId)}<span className="dim" style={{ fontWeight: 400 }}> · {t('Week {0}', c.week)}{routine?.name ? ' · ' + routine.name : ''}</span></div>
      <div className="pcard-chg-v"><span className="tag">{line(c.before)}</span><Icon name="chevronRight" style={{ fontSize: 12, color: 'var(--label-3)' }} /><span className="tag acc">{line(after)}</span></div>
      <div className="pcard-chg-w">{c.why}</div>
    </div>
  </div>
}

function useUndo() {
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  return entry => confirmSheet({
    title: t('Undo this change?'),
    message: t('The weeks go back to how they were before the Coach changed them. Workouts you have logged are untouched.'),
    confirmText: t('Undo'),
    onConfirm: () => {
      let ok = false
      update(s => {
        ok = undoLook(s, entry.id)
        if (ok) appendChat(s, { role: 'coach', kind: 'reverted', text: t('Changed back — the weeks are as they were before that correction.') })
      })
      toast(ok ? t('Plan restored') : t('Nothing to undo'))
    }
  })
}

/** One correction, in full. Used in the chat (by its id) and on the sheet. */
export function LookCard({ id, entry: given }) {
  const S = useStore(s => s.S)
  const undo = useUndo()
  const entry = given || lookEntry(S, id)
  if (!entry) return null
  const canUndo = undoable(S)?.id === entry.id
  return <div className="pcard">
    <div className="pcard-hd">
      <div className="recap-top">
        <span className="pcard-eyebrow">{t('What the Coach changed')} · {dayOf(entry.at)}</span>
        {entry.undone && <span className="recap-state no">{t('Undone')}</span>}
      </div>
      {!!entry.summary && <p className="pcard-sum">{entry.summary}</p>}
    </div>
    {(entry.changes || []).map((c, i) => <ChangeLine key={i} c={c} S={S} />)}
    {!!entry.notes?.length && <div className="pcard-notes">{entry.notes.map((n, i) => <div key={i}><Icon name="lightbulb" />{n}</div>)}</div>}
    {canUndo && <div className="pcard-ft"><Button icon="reset" onClick={() => undo(entry)}>{t('Undo')}</Button></div>}
    {!canUndo && <div style={{ height: 8 }} />}
  </div>
}

export default function CycleSheet({ close, canAsk, onAsked }) {
  const S = useStore(s => s.S)
  const toast = useUI(s => s.toast)
  const [busy, setBusy] = useState(false)
  const view = cycleView(S)
  if (!view) return <div className="chat-menu"><h3>{t('Training cycle')}</h3><div className="chat-empty">{t('No cycle is running. A plan from the Coach comes with one.')}</div></div>
  const ask = async () => {
    setBusy(true)
    try { await requestAdjust(); onAsked?.(); close?.() } catch (e) { toast(e.message || t('Could not ask the Coach')); setBusy(false) }
  }
  const from = [view.program, view.own ? t('Built from your own plan') : null].filter(Boolean).join(' · ')
  return <div className="chat-menu">
    <h3>{t('Training cycle')}</h3>
    <div className="pcard" style={{ marginBottom: 12 }}>
      <div className="pcard-hd">
        <div className="pcard-eyebrow">{t('Week {0} of {1}', view.week, view.weeks)}</div>
        <h2 className="pcard-h">{view.name || t('Coach plan')}</h2>
        {!!from && <p className="pcard-sum" style={{ fontSize: 13 }}>{from}</p>}
        {view.over && <p className="pcard-sum" style={{ color: 'var(--yellow)' }}>{t('The cycle has run its course. Ask for a new plan when you are ready.')}</p>}
        <p className="pcard-sum" style={{ fontSize: 13 }}>{t('After each session the Coach checks the weeks still to come. Changes to weights, sets and reps apply by themselves, and you can undo the latest.')}</p>
        {!!view.lastCheck?.reading && <p className="pcard-sum" style={{ fontSize: 13 }}><b>{t('Last look')} · {dayOf(view.lastCheck.at)}</b> — {view.lastCheck.reading}</p>}
      </div>
      <CycleOutline view={view} unit={S.unit} speedUnit={speedUnitOf(S)} />
      {canAsk && !view.over && <div className="pcard-ft"><Button icon="sparkles" disabled={busy} onClick={ask}>{t('Have the Coach look now')}</Button></div>}
      {!(canAsk && !view.over) && <div style={{ height: 8 }} />}
    </div>
    {view.history.map(h => <div key={h.id} style={{ marginBottom: 12 }}><LookCard entry={h} /></div>)}
    <div style={{ height: 10 }} />
  </div>
}
