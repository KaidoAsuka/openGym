/* The programme catalogue, and which of it one job gets to read.
 *
 * A model asked for a plan will name a programme from memory, and its memory of a programme is a
 * blend of every forum post about it. So the programmes are written down (api/coach/kb/programs/,
 * one entry each: its layout, its progression rule, how much of it this app can run, what people
 * hold against it, where it comes from and how far that was checked), and a plan may only name
 * one it was handed. Which ones it is handed is decided here, by code, from the intake answers —
 * the catalogue is seventy-nine entries and a model does not choose better from seventy-nine than
 * from six.
 *
 * An entry is a template of structure and rules. It is not evidence that the programme is the
 * best way to train; the principles prompt stays the judge of volume and effort.
 *
 * Pure, like the rest of core/: no file, no clock. The phone runs the same code when it brings
 * its own key. `kb-data.js` is generated from the JSON (scripts/build-coach-assets.mjs).
 */
import { PROGRAMS } from './kb-data.js';

export const KB_PROGRAMS = PROGRAMS;
const BY_ID = new Map(PROGRAMS.map(p => [p.id, p]));
export const programById = id => BY_ID.get(id) || null;

// How many a plan request carries: programmes that fit the answers, or ones the person named.
export const MAX_CANDIDATES = 6;
export const MAX_NAMED = 3;

/* ---------- what an entry may say ----------
   api/test/kb.test.js holds every entry to these, so a word the intake never writes cannot sit in
   an entry and quietly match nobody. */
export const KB_GOALS = ['strength', 'muscle', 'general', 'fatloss', 'endurance'];     // CoachIntake GOALS
export const KB_EXPERIENCE = ['new', 'returning', 'regular'];                          // CoachIntake EXPERIENCE
// `close`: the app runs it nearly as written. `partial`: its layout fits, a rule of it does not.
// `none`: it is built on something the app does not have, and it is never offered.
export const KB_FIT = ['close', 'partial', 'none'];
// How far an entry was checked against its source: its rules, its outline, or only that it exists.
export const KB_VERIFIED = ['A', 'B', 'C'];

/** One entry as the model reads it. No link: a URL is never the model's to repeat. */
const brief = p => ({
  id: p.id, name: p.name, author: p.author, level: p.level, days: p.days,
  ...(p.weeks ? { weeks: p.weeks } : {}),
  structure: p.structure, progression: p.progression,
  fit: p.fit, ...(p.cycle ? { cycle: true } : {}), ...(p.policy ? { policy: p.policy } : {}), ...(p.adapt ? { adapt: p.adapt } : {}),
  caveats: p.caveats, verified: p.verified
});

/** One entry as the model reads it, by id — for a job about a plan that is already running on it. */
export function programBrief(id) {
  const p = programById(id);
  return p ? brief(p) : null;
}

/** What a plan card shows for the programme a plan names — read from the catalogue, never from
 *  the answer, so the name and the link on screen are the catalogue's own. */
export function programCard(id) {
  const p = programById(id);
  return p ? { id: p.id, name: p.name, author: p.author, source: p.source } : null;
}

/* ---------- programmes that fit the intake answers ----------
   Offered only when the app can run it at least in part and its rules or outline were checked.
   An entry with no `experience` is for lifters more advanced than the intake can tell apart from
   "training regularly", and is never offered on the strength of that answer. */
function matching(profile) {
  if (!profile || typeof profile !== 'object') return [];
  const { goal, experience } = profile;
  const days = Number(profile.daysPerWeek);
  if (!KB_GOALS.includes(goal) || !KB_EXPERIENCE.includes(experience) || !Number.isInteger(days)) return [];
  // No equipment stated means the whole library, as librarySlice reads it.
  const have = (Array.isArray(profile.equipment) ? profile.equipment : []).map(e => String(e).toLowerCase());
  const fits = p => p.verified !== 'C'
    && p.goals.includes(goal) && p.experience.includes(experience) && p.days.includes(days)
    && (!have.length || p.needs.every(n => have.includes(n)));
  // Its first goal and its first number of days are what a programme was written for; then the
  // ones the app runs as written, then the better-checked. Catalogue order settles the rest, so
  // the same answers always get the same list.
  const rank = p => [p.goals[0] === goal ? 0 : 1, p.days[0] === days ? 0 : 1, p.fit === 'close' ? 0 : 1, p.verified === 'A' ? 0 : 1];
  return PROGRAMS
    .map((p, i) => ({ p, i, r: rank(p) }))
    .filter(x => fits(x.p))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3] || a.i - b.i)
    .map(x => x.p);
}

export const candidatesFor = profile => matching(profile).filter(p => p.fit !== 'none').slice(0, MAX_CANDIDATES);

/* ---------- programmes that fit the answers and cannot be run ----------
   For someone past their first year who trains for strength, the programmes most people would
   name — 5/3/1 and what grew out of it — are all built on a training max and on weeks that
   differ, and the app has neither. Leaving them out without a word would hand that person the
   catalogue's side streets as if they were the whole map. So their names travel too, with the
   reason, for the model to mention and not to build: a plan that carries a programme's name
   without its rules is worse than one that says the programme has to wait.

   How far an entry was checked decides nothing here; nothing is built from it. */
export const MAX_UNAVAILABLE = 4;
export function unavailableFor(profile) {
  const goal = profile?.goal, days = Number(profile?.daysPerWeek);
  const first = p => (p.goals[0] === goal ? 0 : 2) + (p.days[0] === days ? 0 : 1);
  return matching(profile)
    .filter(p => p.fit === 'none')
    .sort((a, b) => first(a) - first(b) || PROGRAMS.indexOf(a) - PROGRAMS.indexOf(b))
    .slice(0, MAX_UNAVAILABLE);
}

/* ---------- programmes someone named ----------
   "I want to run 5/3/1" should reach the model with the entry for 5/3/1, including the part that
   says this app cannot run it — otherwise the answer is the model's recollection, laid out with
   confidence. Any entry can be named, whatever its fit or how far it was checked.

   A name is matched whole: "hst" is not found inside "ghosts". A name in another script has no
   word edges to hold it to and is matched as it stands. */
const edge = ch => ch === undefined || !/[a-z0-9]/.test(ch);
function spans(text, name) {
  const out = [];
  const ascii = !/[^\x00-\x7f]/.test(name);
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    if (!ascii || (edge(text[i - 1]) && edge(text[i + name.length]))) out.push([i, i + name.length]);
  }
  return out;
}

export function namedIn(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const t = text.toLowerCase();
  const found = PROGRAMS.map((p, i) => {
    const names = [p.name.toLowerCase(), ...(p.aliases || [])];
    return { p, i, at: names.flatMap(n => spans(t, n)) };
  }).filter(x => x.at.length);
  // "smolov jr" also holds "smolov", and "5/3/1 for beginners" holds "5/3/1": a name found only
  // inside a longer name of another entry was not what they wrote.
  const inside = (a, b) => b[0] <= a[0] && a[1] <= b[1] && b[1] - b[0] > a[1] - a[0];
  const meant = found.filter(x => x.at.some(a => !found.some(y => y !== x && y.at.some(b => inside(a, b)))));
  const longest = x => Math.max(...x.at.map(a => a[1] - a[0]));
  return meant.sort((a, b) => longest(b) - longest(a) || a.i - b.i).slice(0, MAX_NAMED).map(x => x.p);
}

/**
 * The programmes a plan request carries (payload.programs), or null for none.
 *
 * With a plan of their own the intake answers do not choose anything: the only entries sent are
 * the ones their text names, so the model has the rules of what they asked for and is not handed
 * six other programmes to prefer.
 *
 * @param {object} profile  the cleaned intake answers (payload.js cleanProfile)
 */
export function programsForPayload(profile) {
  const own = typeof profile?.ownPlan === 'string' ? profile.ownPlan.trim() : '';
  if (own) {
    const named = namedIn(own);
    return named.length ? { matched: 'named', candidates: named.map(brief) } : null;
  }
  const candidates = candidatesFor(profile);
  const unavailable = unavailableFor(profile).map(p => ({ name: p.name, author: p.author, why: p.adapt }));
  if (!candidates.length && !unavailable.length) return null;
  return { matched: 'answers', candidates: candidates.map(brief), ...(unavailable.length ? { unavailable } : {}) };
}
