// Asking the Coach before a workout is started: a sheet over Home or the Start screen.
//
// The same thread and the same cards as asking during a workout (CoachLiveSheet.jsx), about the
// workout today holds, which is built for it and not started (lib/coach-pre.js). They say how
// the day stands ("slept five hours", "forty minutes at most", "the shoulder is tight"); the
// answer may carry suggestions for that workout, or one for the day itself: another session of
// the plan in its place, or none. Nothing is changed until a card is tapped. Start then opens the
// workout as it was prepared here, with the conversation still on it for the questions that come
// between sets.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { useCoachPre } from '../store/useCoachPre.js'
import { t } from '../lib/i18n.js'
import { todayISO, fmtDate } from '../lib/format.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { coachAvailable, hasConsent } from '../lib/coach.js'
import { talkOf, openTurn, takeOp, undoMarks } from '../lib/coach-live.js'
import { buildPre, prepFor, canPrepare, fitDay, takeDay } from '../lib/coach-pre.js'
import { askCoachPre, isAsking, setPreSheet, jobErrorText } from '../lib/coach-api.js'
import { startFlow } from '../sheets.jsx'
import { Answer } from './CoachLiveSheet.jsx'
import { Button } from './ui.jsx'
import Icon from './Icon.jsx'
import '../coach.css'

let shown = 0
export function openCoachPre() {
  useUI.getState().openSheet(close => <CoachPreSheet close={close} />)
}
// An answer that comes back after the sheet was closed is announced, with a way back to it.
setPreSheet({ open: () => shown > 0, show: () => openCoachPre() })

/** The way in, on Home and on the Start screen: there when there is a Coach that was given the
 *  go-ahead, today holds a workout, and none is under way. */
export function AskBefore() {
  const S = useStore(s => s.S)
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const coachMode = useStore(s => s.coachLocal?.mode)
  if (S.active || !coachAvailable(config, user, { demo: DEMO, mobile: MOBILE, coachMode }) || !hasConsent(S) || !canPrepare(S, todayISO())) return null
  return <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
    <Button size="sm" variant="ghost" className="dim" icon="sparkles" onClick={openCoachPre}>{t('Ask the Coach before you start')}</Button>
  </div>
}

export default function CoachPreSheet({ close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const owner = useStore(s => s.user?.id || '')
  const maxLen = useStore(s => s.config?.coach?.maxMessageLen)
  const stored = useCoachPre(s => s.prep)
  const [text, setText] = useState('')
  const endRef = useRef(null)
  const today = todayISO()
  // What was prepared earlier today, while the plan under it has not moved; otherwise built now.
  const prep = useMemo(() => prepFor(S, stored, today, owner), [S, stored, today, owner])
  const A = prep?.session
  const talk = talkOf(A)
  const open = openTurn(A)
  const waiting = !!open && isAsking(open.id)

  useEffect(() => { shown++; return () => { shown-- } }, [])
  useEffect(() => {
    if (prep) return
    const fresh = S.active ? null : buildPre(S, today, owner)
    // A workout was started under the sheet, or today holds nothing to train: nothing to ask about.
    if (fresh && prepFor(S, fresh, today, owner)) useCoachPre.getState().put(fresh); else close()
  }, [prep, S, today, owner, close])
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [talk.length, waiting])
  if (!A) return null

  const send = () => {
    const say = text.trim()
    if (!say || waiting) return
    setText('')
    askCoachPre({ text: say })
  }
  const stale = () => useUI.getState().toast(t('No longer fits this workout.'))
  const apply = (line, i) => {
    let rec = null
    useCoachPre.getState().change(p => { rec = takeOp({ ...useStore.getState().S, active: p.session }, line.id, i) })
    if (!rec) stale()
  }
  const applyDay = line => {
    let out = null
    update(s => { out = takeDay(s, prep, line.id, today) })
    if (!out) { stale(); return }
    const ui = useUI.getState()
    if (out.rest) {
      useCoachPre.getState().put(null)
      close()
      ui.toast(t('{0} set to rest', fmtDate(today)))
      return
    }
    useCoachPre.getState().put(out.prep)
    ui.toast(t('{0} planned for {1}', out.prep.session.name, fmtDate(today)))
  }
  const start = () => { close(); startFlow(A.routineIds) }

  return <div className="live">
    <h3>{t('Ask the Coach before you start')}</h3>
    <div className="live-about">{t('About {0}', A.name)}</div>

    <div className="msgs live-msgs">
      {!talk.length && <div className="msg coach"><div className="bub">{t('Say how you are today, how much time you have, or what is in the way. The Coach reads the workout you are about to start.')}</div></div>}

      {talk.map(m => m.who === 'user'
        ? <div key={m.id} className="msg user"><div className="bub">{m.text}</div></div>
        : m.error
          ? <div key={m.id} className="msg coach">
            <div className="bub err">{jobErrorText(m.error, m.detail)}</div>
            <button className="live-link" onClick={() => askCoachPre({ retry: m.turn })}>{t('Try again')}</button>
          </div>
          : <Answer key={m.id} line={m} active={A} unit={S.unit} routines={S.routines}
            onApply={i => apply(m, i)} onUndoMarks={() => useCoachPre.getState().change(p => { undoMarks(p.session, m.id) })}
            onDay={() => applyDay(m)} dayFits={!!m.day && !!fitDay(S, A, m.day)} />)}

      {waiting && <div className="msg coach">
        <div className="bub typing"><i /><i /><i /></div>
        <div className="typing-eta">{t('Usually about 15 seconds.')}</div>
      </div>}
      {/* Asked in an earlier run of the app, or lost with the connection: the line is still here. */}
      {open && !waiting && <div className="msg coach">
        <div className="bub err">{jobErrorText('lost')}</div>
        <button className="live-link" onClick={() => askCoachPre({ retry: open.id })}>{t('Try again')}</button>
      </div>}
      <div ref={endRef} />
    </div>

    <div className="live-in live-pre">
      <div className="live-row">
        <textarea rows={1} value={text} maxLength={maxLen || 1000} disabled={waiting}
          placeholder={t('e.g. “slept five hours and my right shoulder is tight”')} aria-label={t('Ask the Coach before you start')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="send" onClick={send} disabled={!text.trim() || waiting} aria-label={t('Send')}><Icon name="arrowUp" /></button>
      </div>
      <Button variant="primary" icon="play" onClick={start}>{t('Start {0}', A.name)}</Button>
    </div>
  </div>
}
