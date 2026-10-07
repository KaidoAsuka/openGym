# Task: build a weekly training plan

Design a complete plan from `coachProfile` (their intake answers) and, if present, `charter` (what they are training toward) and `history` (what they have already been lifting).

## Constraints

- Schedule exactly `coachProfile.daysPerWeek` training days. Use `preferredDays` when given (0 = Sunday … 6 = Saturday).
- Fit `coachProfile.sessionMin` minutes, counted the way principle V6 counts them: 2.5 minutes per straight set, 1.5 per set of an exercise in a superset (`sg`). Add each day up before you answer; a day over the limit is rejected. For cardio, `sets` is the number of bouts, so one 20-minute bout is `sets: 1` with `min: 20`.
- Keep every body part at or under its weekly ceiling (principle V2): add up `sets` by the `bp` of each exercise, over the days in `week`, before you answer. A routine trained on two days counts twice.
- Only exercises from `library`. Respect `equipment`, `limitations`, and `dislikes` — a plan someone will not do is a plan that failed.
- If `history.workingWeights` is present, any starting `weight` you set must be at or below what they have already handled for that exercise. For anything they have not trained, omit `weight` entirely — the app's first session sets the baseline.
- 1–7 routines, each 3–12 exercises, compound work before accessories.
- If `observations` is present, it is what they marked on exercises in the last twelve weeks. Leave out an exercise marked `pain`, and one marked `dislike` or `discomfort` twice or more (`times ≥ 2`), and choose something else for the same job. `equipment` twice or more means that station is often taken — prefer an alternative. Say in the `why` of the replacement what it replaces and which mark led to it.
- When `charter.goal` or `charter.targets` is present, build the plan for it: the target lifts are in the plan and trained first, and `summary` says how the plan serves the goal. If a target is not realistic inside one block, say what this block is expected to reach instead. Do not promise a number.

## Output

```
{
  "coach_contract": 1,
  "opengym_plan": 1,
  "name": "<short plan name>",
  "summary": "<2-4 sentences: the shape of the plan and why it fits what they asked for>",
  "basedOn": "<what you used — e.g. 'your last 12 weeks' or 'no history yet'>",
  "block": { "weeks": 8, "outline": "<2-4 short sentences: what these weeks build toward, where an easier week falls if you plan one, and what will be looked at when the block ends>" },
  "week": { "1": "r1", "3": "r2", "5": "r3" },
  "routines": [
    {
      "id": "r1",
      "name": "<routine name>",
      "emoji": "<one icon: figureStrength, arm, abs, legs, pullup, dumbbell, barbell, kettlebell, plate, machine, figureRun, bike, swim, boxing, timer, stretch, moon, heart, flame or bolt>",
      "prog": "linear",
      "why": "<1-2 sentences: what this day is for>",
      "ex": [
        {
          "id": "<library id>",
          "sets": 3,
          "mode": "reps",
          "reps": 8,
          "prog": "linear",
          "inc": 2.5,
          "repsMin": 8,
          "sg": "a",
          "why": "<1-2 sentences naming why this exercise, here, at this prescription>"
        }
      ]
    }
  ],
  "customEx": []
}
```

- `week` keys are weekday numbers as strings, values are `routines[].id` from this same answer.
- `mode` is `reps` (use `reps`), `time` (use `sec`), or `cardio` (use `min` and `speed`).
- `prog` on a routine is its default; on an exercise it overrides. `inc` is the load step in `meta.unit`; `repsMin` only matters for `double`.
- `sg`: give two exercises the same short string to superset them. They must be adjacent in the list.
- `block` says how long this plan is meant to run before it is looked at as a whole. Use `charter.blockWeeks` when it is given; otherwise choose 4–12 weeks from their goal and experience — shorter for someone new or coming back, longer for someone training steadily. `outline` is a statement of intent, not a schedule the app runs: the app trains the same week until the plan is changed, and the progression engine sets every load (rule 4). So no week-by-week weights or percentages, and no phases the plan itself does not contain.
- `customEx` stays empty unless the library genuinely lacks something the plan needs; then add `{ "id": "cx1", "n": "<name>", "bp": "<body part>", "desc": "<how to do it>" }` and reference `cx1` from a routine.
