// Hold-to-use interaction kinds the presentation animates (docs/conquest.md
// "Interaction animations", docs/development.md Search & Destroy): the player
// row's `interaction` {kind, site, progress} names one of these while a hold
// runs. S&D sends plant / defuse, Bastion repair, Conquest revive / repair and
// the map-event points (plant / defuse charges; any other verb animates as
// `hack`, the handheld tablet). Presentation only: the server timing is the
// mode's own.

export const INTERACT_KINDS = Object.freeze(['plant', 'defuse', 'revive', 'repair', 'hack']);

const VERB_KINDS = Object.freeze([
  [/\b(DEFUSE|DISARM)\b/, 'defuse'],
  [/\b(PLANT|PLACE|ARM)\b/, 'plant'],
  [/\b(REPAIR|FIX|WELD|MEND)\b/, 'repair'],
  [/\b(REVIVE)\b/, 'revive'],
]);

/** The animation kind of a map-event point verb ('Plant charge' -> plant); anything else (USE, HACK, ...) is `hack`. */
export function interactKindOfVerb(verb) {
  const text = String(verb ?? '').toUpperCase();
  for (const [pattern, kind] of VERB_KINDS) if (pattern.test(text)) return kind;
  return 'hack';
}

/** A known interaction kind, else null. */
export const interactKind = kind => (INTERACT_KINDS.includes(kind) ? kind : null);
