// Goal & checkpoint — the charter sheet, opened from the Coach's menu.
//
// Three things a person can say here that the questionnaire has no room for: what they are
// training toward in their own words, the lifts they want to reach, and how long the current
// plan should run before the Coach reads all of it. The block's outline is the Coach's own text
// from the plan it built, shown and not edited: it is what the next review holds the block to.
//
// The sheet edits a local copy and writes once, on Save, through lib/coach-charter.js — the
// same cut the payload builder makes, so nothing typed here reaches a prompt longer than the
// field allowed it to be.
import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { exTitle } from '../lib/coach.js'
import {
  cleanCharter, saveCharter, targetChoices, addDays,
  CHARTER_GOAL_MAX, CHARTER_TARGETS_MAX, BLOCK_WEEKS_CHOICES
} from '../lib/coach-charter.js'
import Icon from '../components/Icon.jsx'
import { Button, TextArea, NumberField, Section, Row, SelectRow } from '../components/ui.jsx'

const NUM = { width: 64, textAlign: 'center' }

export default function CharterSheet({ close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const [c, setC] = useState(() => cleanCharter(S.coach?.charter))
  const set = patch => setC(v => ({ ...v, ...patch }))
  const today = todayISO()

  const lifts = targetChoices(S)
  const free = lifts.filter(x => !c.targets.some(g => g.id === x.id))
  // Starts at what the plan prescribes today, so the number to type is the distance from here.
  const addTarget = id => {
    const from = lifts.find(x => x.id === id)
    set({ targets: [...c.targets, { id, weight: from?.weight || 0, reps: from?.reps || 1 }] })
  }
  const setTarget = (i, patch) => set({ targets: c.targets.map((g, j) => (j === i ? { ...g, ...patch } : g)) })
  const dropTarget = i => set({ targets: c.targets.filter((_, j) => j !== i) })

  // A new length moves the checkpoint with it; a checkpoint typed by hand stays where it was put.
  const setWeeks = w => set(w
    ? { blockWeeks: w, startedAt: c.startedAt || today, checkpoint: addDays(c.startedAt || today, w * 7) }
    : { blockWeeks: null, startedAt: null, checkpoint: null })
  const weekOptions = [...new Set([...BLOCK_WEEKS_CHOICES, ...(c.blockWeeks ? [c.blockWeeks] : [])])].sort((a, b) => a - b)

  const save = () => {
    update(s => { saveCharter(s, c) })
    toast(t('Saved'))
    close()
  }

  return <div className="chat-menu">
    <h3>{t('Goal & checkpoint')}</h3>

    <Section title={t('What are you working toward?')} footer={t('In your own words. The Coach reads this with every plan and every review.')}>
      <div style={{ padding: '10px 12px' }}>
        <TextArea rows={3} maxLength={CHARTER_GOAL_MAX} value={c.goal} onChange={e => set({ goal: e.target.value })}
          placeholder={t('e.g. “squat 140 kg by spring without gaining weight”')} />
      </div>
    </Section>

    {(!!c.targets.length || !!free.length) && <Section title={t('Target lifts')} footer={t('A weight and a rep count for the lifts that matter most, chosen from your plan.')}>
      {c.targets.map((g, i) => <Row key={g.id} icon="target" iconTint="var(--red)" title={exTitle(g.id)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginInlineStart: 'auto' }}>
          <NumberField className="timef" style={NUM} value={g.weight || ''} onChange={v => setTarget(i, { weight: v })} aria-label={t('Weight ({0})', S.unit)} />
          <span className="dim">{S.unit} ×</span>
          <NumberField className="timef" style={NUM} decimal={false} value={g.reps || ''} onChange={v => setTarget(i, { reps: v })} aria-label={t('reps')} />
          <button className="iconbtn" aria-label={t('Remove')} onClick={() => dropTarget(i)}><Icon name="xmark" /></button>
        </span>
      </Row>)}
      {c.targets.length < CHARTER_TARGETS_MAX && !!free.length && <SelectRow icon="plus" iconTint="var(--acc)" title={t('Add a target lift')} value={null}
        options={free.map(x => ({ value: x.id, label: exTitle(x.id) }))} onChange={addTarget} />}
    </Section>}

    <Section title={t('This block')} footer={t('At the checkpoint the Coach looks at the whole block, not just the last few sessions.')}>
      <SelectRow icon="calendar" iconTint="var(--orange)" title={t('Block length')} value={c.blockWeeks || 0} onChange={setWeeks}
        options={[{ value: 0, label: t('None') }, ...weekOptions.map(n => ({ value: n, label: t('{0} weeks', n) }))]} />
      {!!c.blockWeeks && <Row icon="flag" iconTint="var(--green)" title={t('Next checkpoint')}>
        <input type="date" className="timef" value={c.checkpoint || ''} min={today} onChange={e => set({ checkpoint: e.target.value || null })} />
      </Row>}
    </Section>

    {!!c.outline && <Section title={t('How the Coach laid out this block')}>
      <p style={{ margin: 0, padding: '12px 16px', fontSize: 15, lineHeight: 1.42, color: 'var(--label-2)', whiteSpace: 'pre-wrap' }}>{c.outline}</p>
    </Section>}

    <div style={{ padding: '4px 0 14px' }}>
      <Button variant="primary" style={{ width: '100%' }} onClick={save}>{t('Save')}</Button>
    </div>
  </div>
}
