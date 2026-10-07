/* The exercises someone names, found in the catalogue.
 *
 * The model may only use exercises from the slice of the library it is handed (hard rule 2), and
 * the slice is 160 of 1,324. A person who writes "引体向上 4 组、哑铃飞鸟、腿举" into their own
 * plan, or "swap the assisted pull-up back to a pull-up" into a reply, is naming exercises that
 * have to be in that slice or the plan they asked for cannot be built. The catalogue's names are
 * English, and it carries no translation a Chinese sentence could be matched against.
 *
 * So this is a small glossary: what a lifter calls a movement, in Chinese and in English, and
 * what the catalogue calls it. A movement named in the text pins a few catalogue exercises of
 * that movement into the slice — the ones on equipment the text also names first, then the
 * mainstream ones. It is a way to get the right rows in front of the model, not a parser of
 * plans: the model still reads the text itself.
 *
 * Pure, like the rest of core/. api/test/library-slice.test.js pins it.
 */

// [what they write, what the catalogue name holds, the body part when the word alone is too wide]
export const MOVEMENTS = [
  [/卧推|bench\s*press/i, /bench press/],
  [/上斜|incline/i, /incline/, 'chest'],
  [/下斜|decline/i, /decline/, 'chest'],
  [/飞鸟|夹胸|\bfl(y|ies|yes?)\b/i, /\bfly\b|flye/],
  [/俯卧撑|push[- ]?ups?/i, /push-up|push up/],
  [/双杠|\bdips?\b/i, /\bdips?\b/],
  [/引体|pull[- ]?ups?/i, /pull-up|pull up/],
  [/反手引体|chin[- ]?ups?/i, /chin-up|chin up/],
  [/下拉|pull[- ]?downs?/i, /pulldown|pull-down/],
  [/划船|\brows?\b/i, /\brow\b/, 'back'],
  [/硬拉|dead\s*lifts?/i, /deadlift/],
  [/罗马尼亚|romanian|\brdl\b/i, /romanian/],
  [/深蹲|squats?/i, /squat/, 'upper legs'],
  [/腿举|leg\s*press/i, /leg press/],
  [/腿屈伸|leg\s*extensions?/i, /leg extension/],
  [/腿弯举|leg\s*curls?/i, /leg curl/],
  [/箭步|弓步|lunges?/i, /lunge/],
  [/臀推|臀桥|hip\s*thrusts?|glute\s*bridges?/i, /hip thrust|glute bridge/],
  [/提踵|calf\s*raises?/i, /calf raise/],
  [/推举|肩推|(overhead|shoulder|military)\s*press|\bohp\b/i, /overhead press|shoulder press|military press/],
  [/侧平举|lateral\s*raises?/i, /lateral raise/],
  [/前平举|front\s*raises?/i, /front raise/],
  [/俯身飞鸟|反向飞鸟|rear\s*delt|reverse\s*fl/i, /rear delt|reverse fly|rear fly/],
  [/耸肩|shrugs?/i, /shrug/],
  [/弯举|\bcurls?\b/i, /\bcurl\b/, 'upper arms'],
  [/锤式|hammer/i, /hammer curl/],
  [/下压|push[- ]?downs?/i, /pushdown|push-down/],
  [/臂屈伸|triceps\s*extensions?|skull\s*crushers?|碎颅/i, /triceps extension|skull crusher/],
  [/卷腹|crunch(es)?/i, /crunch/],
  [/平板支撑|planks?/i, /plank/],
  [/举腿|leg\s*raises?/i, /leg raise/],
  [/高翻|power\s*cleans?/i, /power clean/],
  [/壶铃摇摆|swings?/i, /swing/]
];

// [what they write, the catalogue's equipment word]
const EQUIPMENT = [
  [/杠铃|barbell/i, 'barbell'],
  [/哑铃|dumbbell/i, 'dumbbell'],
  [/绳索|龙门架|cable/i, 'cable'],
  [/器械|固定器械|machine/i, 'leverage machine'],
  [/史密斯|smith/i, 'smith machine'],
  [/壶铃|kettlebell/i, 'kettlebell'],
  [/弹力带|\bbands?\b/i, 'band'],
  [/自重|徒手|body\s*weight/i, 'body weight']
];

/** A list reordered so its equipment kinds take turns, each kind keeping its own order. */
export function takeTurns(list) {
  const by = new Map();
  for (const e of list) { const k = e.eq || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
  const kinds = [...by.keys()].sort();
  const out = [];
  for (let i = 0; out.length < list.length; i++) for (const k of kinds) { if (by.get(k)[i]) out.push(by.get(k)[i]); }
  return out;
}

// A handful per movement: a bench press named once should not bring all forty of them.
export const HINTS_PER_MOVEMENT = 4;
export const HINTS_MAX = 48;
// What is read of one text. The intake's longest field is 1,500 characters; a reply is cut at 4,000.
const TEXT_MAX = 4000;

/**
 * Catalogue ids for the movements named in what someone wrote.
 *
 * @param {string[]} texts          their own plan, their likes, a reply — anything they typed
 * @param {object[]} pool           the exercises the slice may draw on (already equipment-filtered)
 * @param {(e:object)=>boolean} isCommon  whether an exercise is one of the mainstream ones
 * @param {object[]} [all]          the whole catalogue, for a movement the pool holds none of
 * @returns {string[]} ids, in the order the movements were listed above
 */
export function exerciseHints(texts, pool, isCommon, all) {
  const text = (Array.isArray(texts) ? texts : [texts]).filter(t => typeof t === 'string' && t.trim()).map(t => t.slice(0, TEXT_MAX)).join('\n');
  if (!text) return [];
  const named = EQUIPMENT.filter(([said]) => said.test(text)).map(([, eq]) => eq);
  const out = [];
  const taken = new Set();
  for (const [said, name, bp] of MOVEMENTS) {
    if (!said.test(text)) continue;
    const of = list => list.filter(e => name.test(e.n) && (!bp || e.bp === bp));
    // The pool is what their ticked equipment reaches. The mainstream exercise of a movement
    // they named is theirs to have named whatever was ticked — the catalogue files the ordinary
    // leg press under "sled machine", which nobody thinks to tick — and so is anything at all
    // when the pool holds none of the movement.
    const inPool = of(pool);
    const seen = new Set(inPool.map(e => e.id));
    const beyond = of(all || []).filter(e => !seen.has(e.id) && (isCommon(e) || !inPool.length));
    const rank = e => (named.includes(e.eq) ? 0 : 2) + (isCommon(e) ? 0 : 1);
    const found = [...inPool, ...beyond];
    // Best first; among equals the equipment kinds take turns, so four bench presses are not
    // four barbell ones.
    [0, 1, 2, 3].flatMap(r => takeTurns(found.filter(e => rank(e) === r)))
      .slice(0, HINTS_PER_MOVEMENT)
      .forEach(e => { if (!taken.has(e.id) && out.length < HINTS_MAX) { taken.add(e.id); out.push(e.id); } });
  }
  return out;
}
