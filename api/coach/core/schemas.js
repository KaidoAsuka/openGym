/* JSON schemas for the four answer shapes, handed to providers that can enforce a schema
 * while decoding (Ollama/llama.cpp grammar sampling, LM Studio, vLLM, OpenAI json_schema).
 *
 * Deliberately flat: no $ref, no anyOf/oneOf, no additionalProperties tricks — llama.cpp's
 * grammar converter has a history of choking on those (ollama#8444, #8063). The schema
 * guarantees *shape* so a small model cannot ramble; validate.js remains the only judge of
 * whether the contents are safe to act on. Fields that may hold any JSON value (`before`,
 * `after`) say so with a type union, which the grammar converter does support.
 */
const ANY = { type: ['number', 'string', 'boolean', 'object', 'array', 'null'] };
const STR = { type: 'string' };
const STRINGS = { type: 'array', items: { type: 'string' } };

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    nochange: { type: 'boolean' },
    reading: STR,
    summary: STR,
    evidence: {
      type: 'object',
      properties: { from: STR, to: STR, sessions: { type: 'integer' } }
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: STR,
          type: STR,
          target: {
            type: 'object',
            properties: { routineId: STR, exId: STR, weekday: { type: 'integer' } }
          },
          before: ANY,
          after: ANY,
          why: STR
        },
        required: ['type', 'why']
      }
    },
    notes: STRINGS
  },
  required: ['coach_contract']
};

const EX_SCHEMA = {
  type: 'object',
  properties: {
    id: STR, sets: { type: 'integer' }, mode: STR,
    reps: { type: 'integer' }, sec: { type: 'integer' },
    min: { type: 'integer' }, speed: { type: 'number' },
    weight: { type: 'number' }, prog: STR, inc: { type: 'number' },
    repsMin: { type: 'integer' }, repsMax: { type: 'integer' },
    bodyweight: { type: 'boolean' }, side: { type: 'boolean' },
    sg: STR, why: STR, position: { type: 'integer' }
  },
  required: ['id', 'sets']
};

// One exercise's numbers for one week, and one week of a cycle (core/cycle.js).
const CYCLE_EX = {
  type: 'object',
  properties: { id: STR, sets: { type: 'integer' }, reps: { type: 'integer' }, sec: { type: 'integer' }, weight: { type: 'number' } },
  required: ['id']
};
const CYCLE_WEEK = {
  type: 'object',
  properties: {
    week: { type: 'integer' }, focus: STR,
    sessions: { type: 'array', maxItems: 7, items: { type: 'object', properties: { routine: STR, ex: { type: 'array', maxItems: 20, items: CYCLE_EX } }, required: ['routine', 'ex'] } }
  },
  required: ['week']
};

// `week` and `routines[].id` are required, not optional: the week is the only thing that says
// which day trains which routine, and it points at a routine by id. A schema that leaves either
// out lets a small local model answer with routines that have no id and a week naming "r1" —
// grammar-valid, and something validate.js can only ever reject ("the week schedules 0 days but
// 3 were asked for"), through the repair round and out as a failed job.
export const CREATE_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    name: STR,
    summary: STR,
    basedOn: STR,
    // The catalogue programme the plan was built from, by id, and — for a plan the person brought
    // themselves — where it departs from the principles. Both optional.
    program: STR,
    differences: { type: 'array', maxItems: 6, items: { type: 'string' } },
    // The weeks of the block when they differ: what each routine's exercises are done at.
    cycle: { type: 'array', maxItems: 26, items: CYCLE_WEEK },
    // How long the plan runs before it is looked at whole, and what those weeks are for. Flat,
    // and optional: a plan without one is still a plan.
    block: { type: 'object', properties: { weeks: { type: 'integer' }, outline: STR } },
    week: { type: 'object' },
    // The caps are the validator's own (MAX_ROUTINES, MAX_EX_PER_ROUTINE), stated here as well
    // because "1-7 routines, each 3-12 exercises" in create.md is only a request. A small model
    // that starts repeating itself does not stop at a request: qwen2.5:3b walks the library id by
    // id, three sets of eight apiece, until it hits the output limit — twelve minutes for an
    // answer that arrives cut in half and cannot be parsed. maxItems ends that run at seven
    // routines instead.
    routines: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        properties: {
          id: STR, name: STR, emoji: STR, prog: STR, why: STR,
          ex: { type: 'array', maxItems: 20, items: EX_SCHEMA }
        },
        required: ['id', 'name', 'ex']
      }
    },
    customEx: {
      type: 'array',
      items: { type: 'object', properties: { id: STR, n: STR, bp: STR, desc: STR }, required: ['id', 'n'] }
    }
  },
  required: ['coach_contract', 'week', 'routines']
};

export const DEBRIEF_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    summary: STR,
    score: { type: 'integer' },
    highlights: STRINGS,
    watch: STRINGS,
    nextTime: STRINGS
  },
  required: ['coach_contract', 'summary', 'score']
};

// The item counts are the validator's (DIGEST_ITEMS_MAX), stated here for the reason the create
// schema states its own: a small model that starts listing does not stop at a request.
const FEW = { type: 'array', maxItems: 4, items: { type: 'string' } };
export const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    summary: STR,
    progress: FEW,
    issues: FEW,
    carry: FEW
  },
  required: ['coach_contract', 'summary']
};

// The daily look at a running cycle: numbers of weeks not yet trained, and nothing else.
export const ADJUST_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    nochange: { type: 'boolean' },
    reading: STR,
    summary: STR,
    changes: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        properties: { week: { type: 'integer' }, routine: STR, exId: STR, sets: { type: 'integer' }, reps: { type: 'integer' }, sec: { type: 'integer' }, weight: { type: 'number' }, why: STR },
        required: ['week', 'routine', 'exId', 'why']
      }
    },
    weeks: { type: 'array', maxItems: 26, items: { type: 'object', properties: { week: { type: 'integer' }, focus: STR }, required: ['week', 'focus'] } },
    notes: FEW
  },
  required: ['coach_contract']
};

// An answer given during a session: a few sentences, ops on the session itself (core/live.js)
// and marks for what was just said about an exercise. The counts are live.js's LIVE_OPS_MAX and
// LIVE_FLAGS_MAX, stated here for the reason the create schema states its own.
export const LIVE_SCHEMA = {
  type: 'object',
  properties: {
    coach_contract: { type: 'integer' },
    reply: STR,
    ops: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          op: STR, entry: { type: 'integer' }, exId: STR, to: STR, count: { type: 'integer' },
          sets: { type: 'integer' }, reps: { type: 'integer' }, sec: { type: 'integer' }, weight: { type: 'number' }, why: STR
        },
        required: ['op', 'entry', 'exId', 'why']
      }
    },
    flags: {
      type: 'array',
      maxItems: 3,
      items: { type: 'object', properties: { entry: { type: 'integer' }, exId: STR, flag: STR }, required: ['entry', 'exId', 'flag'] }
    }
  },
  required: ['coach_contract', 'reply']
};

export const SCHEMAS = { review: REVIEW_SCHEMA, create: CREATE_SCHEMA, refine: CREATE_SCHEMA, debrief: DEBRIEF_SCHEMA, digest: DIGEST_SCHEMA, adjust: ADJUST_SCHEMA, live: LIVE_SCHEMA };
