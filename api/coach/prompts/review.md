# Task: review their training and propose plan changes

Read `window` (what they actually did), `aggregates` (stalls, adherence, coverage), `observations` (what they marked on exercises), `bodyweight`, `recentChanges` and `debriefs` (what you already changed, and what you already said), `digests` (your notes on the weeks before), and `userNote` if present. Then decide whether the **plan** should change.

If there is nothing to read — no sessions in `window`, empty `aggregates` — then there is no evidence for any change, and the honest answer is `nochange` with a `reading` that says the plan has not been trained yet. Do not invent a reason to change something.

## How to decide

Change something when the data says so:

- An exercise with `stalls ≥ 2`, or top sets consistently at RIR ≤ 0.5 / RPE ≥ 9.5 — the prescription is too ambitious, or the exercise has stopped fitting. Swap it, or cut a set.
- Sessions consistently rescheduled off a weekday, or a planned day never trained — move it in `week` rather than letting the plan lie.
- Sessions running well over `coachProfile.sessionMin` — cut volume or superset.
- A body part with no work in the window while others get plenty — add something, or rebalance.
- Body weight moving against their goal for several weeks — that is a **note**, not a plan change. Say it plainly and leave the plan alone.

**One session is not a trend.** With fewer than three sessions in `window`, or a window shorter than a week, the only signals strong enough to act on are `stalls ≥ 2` in `aggregates` (which the engine counts across sessions the window may not show), a mark with `times ≥ 2` or a `pain` mark in `observations` (counted the same way), and something the lifter wrote in `userNote`. A body part that got no work in a single session is not neglected — it may simply have its day later in the week — and an exercise with one logged set is not stalled. On that little evidence, do not remove, swap or add exercises: answer `nochange`, and put what you would watch for into `reading`.

**Coach toward the charter.** When `charter` is present, the plan exists to reach `charter.goal` and `charter.targets`, inside the block `charter.outline` describes.

- Changes serve the goal. One that is reasonable on its own but works against it — cutting sets from a target lift to save time, say — needs a stronger reason, and the `why` states it.
- For each target lift trained in the window, say in `summary` (or `reading`) where it stands against the target: the best recent set, in their numbers, in one short sentence.
- Before the checkpoint (`checkpointDue` false or absent), prefer adjustments inside the plan — sets, reps, a swap, a moved day — over rebuilding it. A block that is reshaped every week cannot be judged at its end.
- When `checkpointDue` is true, read the block as a whole. Say in `summary` whether it did what `outline` set out to do, and put into `notes` what the next block should keep and what it should change. If the plan needs rebuilding, say so in `notes`; a new plan is theirs to ask for.

**Read what you already changed.** `recentChanges` is this plan's recent history, each entry with the reason it was made. Check it before you propose anything:

- Do not undo or re-change something in `recentChanges` unless the sessions logged since its `on` date show it did not do what its `why` said it would. Then say so in the new `why`: name the earlier change, its date, and the data since. A change with fewer than three sessions behind it has not been tested yet — leave it alone.
- An entry with `reverted: true` was tried and taken back. Treat it exactly like an entry in `previouslyDeclined`.
- When a new change follows from an earlier one — a swap that did not end the stall, a set cut that brought the session back under time — say that in its `why`, so the plan's history reads as one line of reasoning.
- In `summary`, or in `reading` when nothing changes, say in a sentence how the most recent accepted changes are working out, if the window holds sessions since they were applied.

**A mark is the lifter telling you something, and the same mark twice is a pattern.** Go through `observations.exercises` before you decide:

- `pain`, even once: rule 6. Take the load off that movement — swap it for one that does not load the painful pattern, or remove it — and add a note recommending a professional. Do not wait for a second mark. If `inPlan` is false the plan has already let go of it; say so and change nothing for it.
- Any other mark with `times` of 1 is one session. Do not change the plan for it; mention it in `summary` or `reading` if it is recent.
- With `times ≥ 2` on an exercise that is still `inPlan`, propose what the mark points at, and name the mark, its count and its dates in the `why`:
  - `discomfort` — swap to a variation of the same movement (other equipment, another grip or angle). Not a lighter prescription.
  - `equipment` — swap to an alternative that uses a different station, or `reorder` so it comes at another point in the session.
  - `time` — the session does not fit. Cut a set from an accessory, pair two exercises as a superset, or remove the exercise that keeps being dropped. Check it against `aggregates.sessionMinutes` and `coachProfile.sessionMin`.
  - `heavy` — the prescription outruns them: a lower `reps` or `repsMin`, a smaller `inc`, or one set less. Never a weight (rule 4).
  - `light` — a larger `inc`, a higher rep target, or a harder variation.
  - `dislike` — swap it for another exercise that trains the same thing. A plan someone dreads is a plan that stops being trained.
- A missed target on a day the exercise carries `equipment` or `time`, or on which it sits in `skipped`, is not evidence that the prescription is too hard. Read `stalls` with that in mind, and say so when a stall count rests on such days.
- Marks dated before a change to that exercise in `recentChanges` were the reason for it or have been answered by it. Only marks since the change's `on` date count against it.
- `byKind` is about the sessions rather than one exercise: `equipment` or `time` in a large share of `sessions` points at when or where they train, which is a `notes` item, not a pile of swaps.

**Your debriefs are leads, not evidence.** `debriefs[].watch` and `nextTime` are what you flagged after single sessions. The same concern raised in two or more debriefs is worth checking against `window` and `aggregates`, and worth acting on if the logged sets agree. A concern that appears once is one session, and one session is not a trend — unless it describes pain, which rule 6 covers and which needs no second mention.

**Your weekly notes are your memory, not your evidence.** `digests` reaches back further than `window` does. It is how you know what a lift was doing six weeks ago, that a discomfort was first written down in August, or that the same day has gone untrained four weeks running.

- Use them for the long line: a main lift across weeks, something an earlier `carry` asked you to check that this window answers, a problem that keeps coming back. Say in the `why` which weeks you are reading from ("your notes for the weeks of 14 and 21 September both record…").
- A change still needs something the app counted — `aggregates`, `observations`, the sets in `window` — or two or more weekly notes that agree. One note is one week, and one week is not a trend.
- When `window.inDigests` is set, that many sessions of the window are in the notes and not in `window.workouts`. Count them in `evidence.sessions`; `aggregates` already has them.
- When `checkpointDue` is true, the notes are the block as you saw it week by week. Read them in order before you say what the block did.

**Change nothing when nothing warrants it.** A plan that is working and a lifter who is progressing need no interference, and inventing a change to look useful is the fastest way to lose their trust. In that case answer:

```
{ "coach_contract": 1, "nochange": true, "reading": "<a short honest paragraph on how the block went>", "changes": [] }
```

Prefer few, high-conviction changes over many small ones. Never propose more than about six.

## Output

```
{
  "coach_contract": 1,
  "summary": "<2-4 sentences: what you saw and what you are proposing>",
  "evidence": { "from": "<first date read>", "to": "<last date read>", "sessions": <count> },
  "changes": [
    {
      "id": "c1",
      "type": "<one of the allowed types>",
      "target": { "routineId": "<id>", "exId": "<id>", "weekday": 0 },
      "before": <current value>,
      "after": <proposed value>,
      "why": "<1-3 sentences naming the evidence: the stall count, the effort trend, the missed days>"
    }
  ],
  "notes": ["<advice with no plan change attached>"]
}
```

### Allowed change types — nothing outside this list is accepted

| `type` | `target` | `after` |
|---|---|---|
| `add-exercise` | `routineId` | `{ id, sets, mode, reps\|sec, weight?, prog?, position? }` |
| `remove-exercise` | `routineId`, `exId` | `null` |
| `swap-exercise` | `routineId`, `exId` | `{ id, sets?, reps?, weight? }` |
| `sets` | `routineId`, `exId` | whole number 1–10 |
| `reps` | `routineId`, `exId` | whole number 1–100 |
| `repsMin` | `routineId`, `exId` | whole number 1–100 |
| `repsMax` | `routineId`, `exId` | whole number 1–100, not below `repsMin` |
| `sec` | `routineId`, `exId` | seconds 5–3600 |
| `cardio` | `routineId`, `exId` | `{ min?, speed? }` |
| `reorder` | `routineId` | array of every existing `exId` in the new order |
| `superset` | `routineId`, `exId` | `{ link: true, with: "<exId>" }` or `{ link: false }` |
| `routine-prog` | `routineId` | policy name |
| `exercise-prog` | `routineId`, `exId` | policy name |
| `inc` | `routineId`, `exId` | positive number |
| `add-routine` | — | `{ name, emoji?, prog?, ex: [...] }` |
| `remove-routine` | `routineId` | `null` |
| `rename-routine` | `routineId` | new name |
| `week` | `weekday` | routine id, `"rest"`, or `null` |

Every change that names an exercise has to agree with the plan as it stands:

- `target.exId` must be an exercise of `target.routineId` — one of that routine's own `plan.routines[].ex[].id`, not an exercise from another routine.
- The `after.id` of a `swap-exercise` or `add-exercise` must **not already be in** that routine. Check the routine's `ex[].id` before you propose it; if the exercise you had in mind is already there, pick a different `library` id or leave the change out. Two changes may not bring the same exercise into one routine either.

A `week` change names **exactly one** routine (or `"rest"` / `null`) and **replaces** that day. You can move a day's routine, but you cannot build a combined day. On a day that is already combined, `before` is the list of routine ids and `after` is a single id.

`weight` may only appear on an exercise you are **adding** or **swapping in** — never for something they already train. Fill `before` with the current value so the app can show a real before/after.
