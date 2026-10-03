/**
 * Whether an instruction asks for more than one action: a sequence word, or a second verb of
 * doing joined by "and". Used only to stop a weak single-intent match from swallowing the rest.
 */
export function looksMultiStep(input) {
  const t = String(input || '');
  if (/\b(then|after that|afterwards|followed by|once (?:that|it|you)(?:'s| is|'ve| have)? ?(?:done|finished))\b/i.test(t)) return true;
  return /\b(?:and|&)\s+(?:also\s+)?(?:make|create|record|post|upload|register|sign up|add|put|write|send|submit|report|verify|check|test|run)\b/i.test(t);
}
