// Asking the Coach during a workout: a sheet over the workout screen, opened from the header's ⋯
// or from an exercise's own.
//
// It is a thread, not a form. They type what is going on ("the second set nearly did not come
// up", "the rack is taken"), the Coach answers in a few sentences, and when the workout itself
// should change the answer carries suggestions, each shown as a card with one button. Nothing
// about the sets moves until that button is tapped, and then only this workout does: the plan and
// the cycle are read again after it is finished (lib/coach-live.js).
//
// The exchange is kept on the workout (S.active.coachTalk), so the sheet can be closed while the
// answer is on its way and opened again later in the session with everything still there.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtNum, exerciseNameText } from '../lib/format.js'
import { exOr } from '../lib/exercises.js'
import { FLAG_LABEL } from '../lib/exercise-flags.js'
import { canAskLive, talkOf, openTurn, previewOp, opMoves, takeOp, undoMarks, cleanCoached } from '../lib/coach-live.js'
import { cleanCoachedDay } from '../lib/coach-pre.js'
import { askCoachLive, isAsking, setLiveSheet, jobErrorText } from '../lib/coach-api.js'
import Icon from './Icon.jsx'
import '../coach.css'

const nameOf = id => exerciseNameText(exOr(id))

// "100 → 95 kg · 5 → 4 reps": the numbers an op sets, against what they were when that is known.
function numbersLine(rec, unit) {
  const was = rec.was || {}
  const one = (now, before, suffix) => (before != null ? fmtNum(before) + ' → ' : '') + fmtNum(now) + ' ' + suffix
  return [
    rec.w != null && one(rec.w, was.w, unit),
    rec.r != null && one(rec.r, was.r, t('reps')),
    rec.sec != null && one(rec.sec, was.sec, t('sec')),
  ].filter(Boolean).join(' · ')
}

/** One op in words, from the record of what it does (lib/coach-live.js previewOp, applyLiveOp). */
export function opLine(rec, unit) {
  const numbers = numbersLine(rec, unit)
  const tail = numbers ? ' · ' + numbers : ''
  if (rec.op === 'change-remaining') return t('Sets still to do: {0}', numbers)
  if (rec.op === 'remove-set') return t('Sets to drop: {0}', rec.n || 1)
  if (rec.op === 'add-set') return t('Sets to add: {0}', rec.n || 1) + tail
  if (rec.op === 'swap') return t('Swap {0} for {1}', nameOf(rec.id), nameOf(rec.to)) + tail
  return t('Skip the sets still to do')
}

/** The day an answer suggested, in words (lib/coach-pre.js). The routine is named as the plan
 *  names it now, and as the answer named it when the plan no longer holds it. */
export function dayLine(day, routines) {
  if (day?.do === 'rest') return t('Rest today')
  const now = (routines || []).find(r => r && r.id === day?.routine)?.name
  return t('Train {0} today instead', now || day?.name || '')
}

/** What the Coach suggested during a workout and they took, in the workout's own detail; and
 *  before it, when the workout itself was trained that day on its suggestion. */
export function CoachedLines({ workout, unit }) {
  const taken = cleanCoached(workout?.coached)
  const day = workout?.coachedDay ? cleanCoachedDay(workout.coachedDay) : null
  if (!taken.length && !day) return null
  return <div className="live-taken">
    <div className="live-taken-h"><Icon name="sparkles" />{t('Suggested by the Coach during this workout')}</div>
    {day && <div className="live-taken-i">
      <div>{day.from.length ? t('In place of {0}, as the Coach suggested before the workout', day.from.join(' + ')) : t('Suggested by the Coach before the workout')}</div>
      {day.why && <div className="live-why">{day.why}</div>}
    </div>}
    {taken.map((c, i) => <div key={i} className="live-taken-i">
      <div><b>{nameOf(c.id)}</b> · {opLine(c, unit)}</div>
      {c.why && <div className="live-why">{c.why}</div>}
    </div>)}
  </div>
}

let shown = 0
/** Opens the sheet. `focus` is the place of the exercise the question is asked from; without one
 *  it is about the exercise they are on. */
export function openCoachLive(focus) {
  useUI.getState().openSheet(close => <CoachLiveSheet focus={focus} close={close} />)
}
// An answer that comes back after the sheet was closed is announced, with a way back to it.
setLiveSheet({ open: () => shown > 0, show: () => openCoachLive() })

export default function CoachLiveSheet({ focus, close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const maxLen = useStore(s => s.config?.coach?.maxMessageLen)
  const A = S.active
  const [text, setText] = useState('')
  const endRef = useRef(null)
  const talk = talkOf(A)
  const open = openTurn(A)
  const waiting = !!open && isAsking(open.id)

  useEffect(() => { shown++; return () => { shown-- } }, [])
  // The newest line in view: their question as it is sent, the answer as it lands.
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [talk.length, waiting])
  // The workout ended under the sheet (finished or discarded elsewhere): nothing left to ask about.
  useEffect(() => { if (!canAskLive(A)) close() }, [A, close])
  if (!canAskLive(A)) return null

  const at = Number.isInteger(focus) && A.entries[focus] ? focus : (Number.isInteger(A.cur) && A.entries[A.cur] ? A.cur : 0)
  const send = () => {
    const say = text.trim()
    if (!say || waiting) return
    setText('')
    askCoachLive({ text: say, focus: at })
  }
  const apply = (line, i) => {
    // The screen's timers hold an exercise by its place: stopped before one leaves or comes in,
    // as the screen's own remove and swap do (Workout.jsx removeActiveExercise, sheets.jsx).
    const moves = opMoves(useStore.getState().S.active, line.ops[i])
    const ui = useUI.getState()
    if (moves) {
      ui.stopWork()
      if (!moves.removes || ui.timer?.forIdx === moves.at) ui.stopRest()
      else ui.shiftRestOwner(moves.at + 1, -1)
    }
    let rec = null
    update(s => { rec = takeOp(s, line.id, i) })
    if (!rec) ui.toast(t('No longer fits this workout.'))
  }

  return <div className="live">
    <h3>{t('Ask the Coach')}</h3>
    <div className="live-about">{t('About {0}', nameOf(A.entries[at].id))}</div>

    <div className="msgs live-msgs">
      {!talk.length && <div className="msg coach"><div className="bub">{t('Ask about the set you just did, the one coming up, or what to do when something is in the way. The Coach reads this workout as it stands.')}</div></div>}

      {talk.map(m => m.who === 'user'
        ? <div key={m.id} className="msg user"><div className="bub">{m.text}</div></div>
        : m.error
          ? <div key={m.id} className="msg coach">
            <div className="bub err">{jobErrorText(m.error, m.detail)}</div>
            <button className="live-link" onClick={() => askCoachLive({ retry: m.turn })}>{t('Try again')}</button>
          </div>
          : <Answer key={m.id} line={m} active={A} unit={S.unit} routines={S.routines} onApply={i => apply(m, i)} onUndoMarks={() => update(s => { undoMarks(s.active, m.id) })} />)}

      {waiting && <div className="msg coach">
        <div className="bub typing"><i /><i /><i /></div>
        <div className="typing-eta">{t('Usually about 15 seconds.')}</div>
      </div>}
      {/* Asked in an earlier run of the app, or lost with the connection: the line is still here. */}
      {open && !waiting && <div className="msg coach">
        <div className="bub err">{jobErrorText('lost')}</div>
        <button className="live-link" onClick={() => askCoachLive({ retry: open.id })}>{t('Try again')}</button>
      </div>}
      <div ref={endRef} />
    </div>

    <div className="live-in">
      <textarea rows={1} value={text} maxLength={maxLen || 1000} disabled={waiting}
        placeholder={t('e.g. “the second set felt heavy, what about the rest?”')} aria-label={t('Ask the Coach')}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      <button className="send" onClick={send} disabled={!text.trim() || waiting} aria-label={t('Send')}><Icon name="arrowUp" /></button>
    </div>
  </div>
}

/* One answer: what the Coach said, a card for each op, and the marks it set. An answer given
   before the workout was started may hold a card for the day instead (`line.day`): it can be
   taken where `onDay` is given, which is the sheet that asks before a workout; in a workout
   under way it is shown only when it was taken, as what led to this workout. */
export function Answer({ line, active, unit, routines, onApply, onUndoMarks, onDay, dayFits }) {
  const ops = line.ops || []
  const taken = line.taken || []
  const day = line.day && (onDay || line.dayTaken) ? line.day : null
  const dayStale = !!day && !line.dayTaken && !dayFits
  return <div className="msg coach" style={ops.length || day ? { maxWidth: '100%', width: '100%' } : undefined}>
    {!!line.text && <div className="bub">{line.text}</div>}
    {day && <div className="pcard live-ops">
      <div className={'pcard-chg' + (dayStale ? ' stale' : '')}>
        <div className="grow">
          <div className="pcard-chg-t">{t('Today')}</div>
          <div className="pcard-chg-v">{dayLine(day, routines)}</div>
          {day.why && <div className="pcard-chg-w">{day.why}</div>}
          {dayStale && <div className="pcard-chg-stale">{t('No longer fits this workout.')}</div>}
        </div>
        {line.dayTaken
          ? <span className="live-done"><Icon name="check" />{t('Applied')}</span>
          : <button className="btn sm primary live-apply" disabled={dayStale} onClick={onDay}>{t('Apply')}</button>}
      </div>
      <div className="live-only">{t('Only today changes. Your plan stays as it is.')}</div>
    </div>}
    {ops.length > 0 && <div className="pcard live-ops">
      {ops.map((op, i) => {
        const done = taken.includes(i)
        // A taken op is shown as it was suggested; one still open, against the workout as it is now.
        const now = done ? null : previewOp(active, op)
        const rec = now || { id: op.exId, op: op.op, n: op.count || op.sets, w: op.weight, r: op.reps, sec: op.sec, to: op.to }
        const stale = !done && !now
        return <div key={i} className={'pcard-chg' + (stale ? ' stale' : '')}>
          <div className="grow">
            <div className="pcard-chg-t">{nameOf(op.exId)}</div>
            <div className="pcard-chg-v">{opLine(rec, unit)}</div>
            {op.why && <div className="pcard-chg-w">{op.why}</div>}
            {stale && <div className="pcard-chg-stale">{t('No longer fits this workout.')}</div>}
          </div>
          {done
            ? <span className="live-done"><Icon name="check" />{t('Applied')}</span>
            : <button className="btn sm primary live-apply" disabled={stale} onClick={() => onApply(i)}>{t('Apply')}</button>}
        </div>
      })}
      <div className="live-only">{t('Only this workout changes. Your plan stays as it is.')}</div>
    </div>}
    {/* The marks the answer set on the exercise. Taken off again, the line goes with them. */}
    {(line.marks || []).length > 0 && !line.marksOff && <div className="live-marks">
      <span>{t('Noted: {0}', line.marks.map(f => t(FLAG_LABEL[f.flag] || f.flag)).join(', '))}</span>
      <button className="live-link" onClick={onUndoMarks}>{t('Undo')}</button>
    </div>}
  </div>
}
