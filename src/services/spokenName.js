/**
 * The agent's name as a voice should read it. A name written in capitals ("ALICE") is read by some voices with the
 * weight of emphasis, differently on each take, so it is handed over as an ordinary word ("Alice"). Only the spoken text:
 * captions, messages and everything written keep the name as it is.
 * AGENT_NAME_SPOKEN sets any other spoken form; a name that is an acronym ("ADA" by its letters) can be set to itself.
 */
export function nameAsSpoken(text, name = process.env.AGENT_NAME || '', spoken = process.env.AGENT_NAME_SPOKEN || '') {
  const n = String(name || '').trim();
  const said = String(spoken || '').trim() || (/^[A-Z]{4,}$/.test(n) ? n[0] + n.slice(1).toLowerCase() : '');
  if (!n || !said || said === n || !text) return text;
  const safe = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`(?<![\\p{L}\\p{N}_@.-])${safe}(?![\\p{L}\\p{N}_@]|[.-][\\p{L}\\p{N}])`, 'gu'), () => said);
}
