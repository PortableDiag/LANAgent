/**
 * trellis-notes, the rest of the Trellis API (v2.25.380).
 *
 * The core plugin (src/api/plugins/trellis-notes.js) reads and writes notes, tasks and
 * channels. This module adds everything else the agent can use, mixed into the same
 * class so it shares the transport, document routing and resolvers:
 *
 *   files     list / read / download / transcribe / attach / add a picture / OCR
 *   editing   edit a card, checklist lines, properties, tables, move, duplicate,
 *             rename or move a basket
 *   finding   tags, query, properties, backlinks, mentions, links, claims, channel claims
 *   layout    reorder, group, dock, arrange, fold, templates, export, clip, generate image,
 *             sharing (list / invite / revoke)
 *   delete    cards, baskets, checklist lines, files — to the document's TRASH, which keeps
 *             them 30 days — plus listTrash / restore
 *
 * Deleting is guarded three ways: it takes the item's id and its title repeated back
 * (`confirmTitle`), it only ever reaches the trash (restorable), and the intent matcher
 * holds delete/remove actions to its highest threshold. Sharing to a new person needs
 * `confirm: true` for the same reason: it gives someone else access to the operator's notes.
 *
 * Routes follow the web reference (GET /api/reference). Routes under /api/documents/{id}
 * exist only on trellis-web; on the desktop they fail with a clear message.
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import dns from 'dns/promises';
import net from 'net';
import { SKILL_BASKET_COMMANDS, skillBasketActions } from './trellisSkills.js';
import { TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, DEPLOY_PATH } from '../../utils/paths.js';

const MAX_FILE_BYTES = 40 * 1024 * 1024;      // the server's limit per file
const MAX_TEXT_CHARS = 20000;                 // extracted text returned to the caller
const DOWNLOAD_DIR = path.join(TEMP_PATH, 'trellis-files');
// Files the agent may upload from. Not DATA_PATH: it holds keys (wireguard, wallet cache).
const UPLOAD_ROOTS = [TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, path.join(DEPLOY_PATH, 'downloads')];

const isId = (v) => typeof v === 'number' || /^\d+$/.test(String(v ?? ''));
const UA = 'LANAgent/2.25 (https://github.com/PortableDiag/LANAgent; trellis-notes)';

/** True for loopback, private, link-local, CGNAT and unspecified addresses. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    (v.startsWith('::ffff:') && isPrivateAddress(v.slice(7)));
}

/** Fetch an image from the public web: http(s), public addresses only, image/*, ≤40 MB. */
export async function fetchPublicImage(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`Not a URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) image URLs can be fetched.');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Cannot resolve ${u.hostname}.`);
  if (addrs.some(a => isPrivateAddress(a.address))) throw new Error(`${u.hostname} is a private or local address; only public images can be fetched.`);
  const res = await axios.get(u.toString(), {
    responseType: 'arraybuffer', timeout: 60000, maxRedirects: 3, maxContentLength: MAX_FILE_BYTES,
    headers: { 'User-Agent': UA, Accept: 'image/*' }, validateStatus: () => true
  });
  if (res.status >= 400) throw new Error(`The image URL answered HTTP ${res.status}.`);
  const type = String(res.headers['content-type'] || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error(`That URL is ${type || 'not an image'}, not an image.`);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'img';
  const base = decodeURIComponent(path.basename(u.pathname)).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || `image.${ext}`;
  return { bytes: Buffer.from(res.data), name: /\.\w{2,4}$/.test(base) ? base : `${base}.${ext}`, contentType: type };
}

/**
 * A freely licensed picture from Wikimedia Commons for a description. Picks among the top
 * matches so repeated asks do not always return the same one. {url, name, pageUrl, credit}.
 */
const FILLER = new Set(['a', 'an', 'the', 'of', 'some', 'any', 'me', 'my', 'find', 'get', 'show', 'cool', 'nice', 'good',
  'great', 'beautiful', 'awesome', 'pretty', 'cute', 'picture', 'pictures', 'photo', 'photos', 'image', 'images', 'pic',
  'pics', 'card', 'with', 'it', 'and', 'make', 'post', 'that', 'which', 'who', 'is', 'are', 'was', 'be', 'or', 'nor',
  'but', 'in', 'on', 'for', 'to', 'please', 'one', 'real', 'actual']);
const NEGATION = new Set(['not', 'no', 'without', 'except', 'excluding', 'never', 'isnt', 'arent', 'non']);

/**
 * Split an image request into what to look for and what to keep out:
 * "frog that is not blue, red, or green" → { include: ['frog'], exclude: ['blue','red','green'] }.
 * Before this every word was searched for, so the colours the user ruled out were matched,
 * and "is"/"or" matched inside unrelated titles (a carousel salmon came back, 2026-09-28).
 */
export function parseImageQuery(query) {
  const words = String(query).toLowerCase().replace(/n't\b/g, 'nt').split(/[^a-z0-9]+/).filter(Boolean);
  const include = []; const exclude = [];
  let negating = false;
  for (const w of words) {
    if (NEGATION.has(w)) { negating = true; continue; }
    if (FILLER.has(w)) continue;
    (negating ? exclude : include).push(w);
  }
  return { include: [...new Set(include)], exclude: [...new Set(exclude)].filter(w => !include.includes(w)) };
}

export async function findCommonsImage(query) {
  // "a cool frog picture" searches Commons for "frog": filler words match book scans and
  // diagrams whose descriptions happen to contain them. Excluded words become -terms.
  const { include: terms, exclude } = parseImageQuery(query);
  const q = terms.join(' ') || String(query);
  const res = await axios.get('https://commons.wikimedia.org/w/api.php', {
    timeout: 20000, headers: { 'User-Agent': UA },
    params: {
      action: 'query', format: 'json', generator: 'search', gsrnamespace: 6,
      gsrsearch: `${q}${exclude.map(w => ` -${w}`).join('')} filetype:bitmap`, gsrlimit: 30,
      prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: 1280
    }
  });
  const pages = Object.values(res.data?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(p => ({ title: p.title, info: p.imageinfo?.[0] }))
    .filter(p => p.info && /^image\/(jpeg|png|webp)$/.test(p.info.mime) && (p.info.width || 0) >= 480);
  if (!pages.length) throw new Error(`No freely licensed picture found on Wikimedia Commons for "${q}".`);
  // Prefer files whose NAME carries the subject (a photo of a frog is usually named for it);
  // scans of old books and maps often match only in their long descriptions.
  // Whole words: a substring test let "is"/"or" match inside "Historic".
  const words = (t) => new Set(t.toLowerCase().replace(/^file:/, '').split(/[^a-z0-9]+/).filter(Boolean));
  const clean = pages.filter(p => { const w = words(p.title); return !exclude.some(x => w.has(x)); });
  const named = clean.filter(p => { const w = words(p.title); return terms.length && terms.every(t => w.has(t) || w.has(`${t}s`)); }
    ).filter(p => !/\(\d{4}\)|book|page|map|scan|diagram|plate/i.test(p.title));
  const pool = named.length ? named : (clean.length ? clean : pages);
  const pick = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
  const meta = pick.info.extmetadata || {};
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const author = strip(meta.Artist?.value).slice(0, 80);
  const license = strip(meta.LicenseShortName?.value);
  return {
    url: pick.info.thumburl || pick.info.url,
    name: pick.title.replace(/^File:/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 100),
    pageUrl: pick.info.descriptionurl,
    credit: [author, license, 'Wikimedia Commons'].filter(Boolean).join(', ')
  };
}

// ---------------------------------------------------------------- command catalogue

export const EXTRA_COMMANDS = [
  // files
  { command: 'listFiles', description: 'List the files and pictures on a Trellis card (names, sizes, index numbers)',
    usage: 'listFiles({ card: 1391 })', examples: ['what files are attached to trellis card 1391', 'list the pictures on that trellis card'] },
  { command: 'readFile', description: 'Read the text of a PDF or text file attached to a Trellis card (free)',
    usage: 'readFile({ card: 1391, index: 0 })', examples: ['read the pdf attached to trellis card 1391', 'what does the attached document on that trellis card say'] },
  { command: 'downloadFile', description: 'Download a file or picture from a Trellis card (or one posted in a channel) to a local file',
    usage: 'downloadFile({ card: 1391, index: 0, kind: "file" })  // kind: file | image | inline', examples: ['download the file from trellis card 1391', 'save the picture the operator posted in trellis'] },
  { command: 'transcribeFile', description: 'Transcribe an audio or video file attached to a Trellis card (paid from the Trellis AI allowance); appends the transcript to the card unless write is false',
    usage: 'transcribeFile({ card: 1391, index: 0, write: true })', examples: ['transcribe the recording on trellis card 1391', 'turn the voice memo in trellis into text'] },
  { command: 'attachFile', description: 'Attach a local file to a Trellis card',
    usage: 'attachFile({ card: 1391, path: "/path/to/report.pdf" })', examples: ['attach the report to the trellis card', 'upload that file to my trellis card'] },
  { command: 'addImage', description: 'Add a local picture to a Trellis card (to an image card, or pasted into a note\'s body)',
    usage: 'addImage({ card: 1391, path: "/path/to/chart.png" })', examples: ['add the chart image to the trellis card', 'put this picture on my trellis note'] },
  { command: 'ocrImage', description: 'Read the text out of a picture card in Trellis',
    usage: 'ocrImage({ card: 1391 })', examples: ['read the text in the trellis picture', 'ocr the screenshot card in trellis'] },
  { command: 'createImageCard', description: 'Make an IMAGE card in a Trellis basket from a picture: find one on the web by description (freely licensed, from Wikimedia Commons), fetch one from an image URL, or upload a local file',
    usage: 'createImageCard({ basket: "AgentTests", query: "cool frog", title: "Frog" })  // or url: "https://…/x.jpg", or path: "/…/x.png"',
    examples: ['find a cool frog picture and make an image card in trellis', 'make a trellis image card of a lighthouse', 'post this picture as an image card in trellis', 'find a picture of a cat and put it on a trellis card'] },
  // diagrams
  { command: 'connectCards', description: 'Draw an arrow (connector) from one Trellis card to another in the same basket: for diagrams, flows, cycles and lifecycles',
    usage: 'connectCards({ from: 189, to: 190, label: "hatches", style: "dashed", arrows: "end" })',
    examples: ['connect the eggs card to the tadpole card in trellis', 'draw an arrow between those two trellis cards', 'link trellis card 189 to card 190 with an arrow', 'connect the cards into a cycle'] },
  { command: 'layoutFlow', description: 'Arrange the cards a Trellis basket\'s arrows join as a flowchart, top-down or left-to-right',
    usage: 'layoutFlow({ basket: 5, dir: "right" })',
    examples: ['lay out the trellis diagram left to right', 'tidy the trellis flowchart', 'arrange the connected trellis cards as a flow'] },
  // editing
  { command: 'editCard', description: 'Change a Trellis card\'s title, body or colour (replaces the body; use appendNote to add to it)',
    usage: 'editCard({ card: 1391, title: "New title", body: "..." })', examples: ['rename the trellis card', 'rewrite the body of that trellis note', 'change the trellis card title'] },
  { command: 'addChecklistItem', description: 'Add a line to a checklist card in Trellis',
    usage: 'addChecklistItem({ card: 1391, text: "Buy milk" })', examples: ['add an item to the trellis checklist', 'put milk on my trellis shopping list'] },
  { command: 'setChecklistItem', description: 'Tick, untick or retype one checklist line in Trellis, by its id or its text',
    usage: 'setChecklistItem({ card: 1391, item: "Buy milk", done: true })', examples: ['tick off milk on the trellis checklist', 'mark that checklist line done in trellis'] },
  { command: 'setProperty', description: 'Set (or clear, with value null) a key:: value property on a Trellis card, e.g. due, status, owner',
    usage: 'setProperty({ card: 1391, key: "due", value: "2026-10-01" })', examples: ['set the due date on the trellis card', 'give that trellis card an owner property'] },
  { command: 'signOff', description: 'Sign off on a Trellis card as this agent: approve it, request changes, or reject it, bound to the content as read',
    usage: 'signOff({ card: 1391, verdict: "approved", note: "Looks right" })  // verdict: approved | changes-requested | rejected',
    examples: ['approve trellis card 1391', 'sign off on that trellis card', 'request changes on the trellis spec card', 'reject trellis card 44'] },
  { command: 'withdrawSignOff', description: "Withdraw this agent's own sign-off from a Trellis card",
    usage: 'withdrawSignOff({ card: 1391 })', examples: ['withdraw my sign-off on trellis card 1391', 'take back the approval on that trellis card'] },
  { command: 'editTable', description: 'Change a table card in Trellis with table ops: set_cell, insert_row, remove_row, insert_col, remove_col, set_bg, set_header …',
    usage: 'editTable({ card: 1391, ops: [{ op: "set_cell", row: 1, col: 2, text: "42" }] })', examples: ['update a cell in the trellis table', 'add a row to the trellis table'] },
  { command: 'moveCard', description: 'Move a Trellis card to another basket, or to the front/back of its basket',
    usage: 'moveCard({ card: 1391, toBasket: "Archive" })  // or { card, to: "front" | "back" }', examples: ['move the trellis card to the archive basket', 'send that trellis card to the back'] },
  { command: 'duplicateCard', description: 'Duplicate a Trellis card (not a task — Trellis refuses copying dated tasks)',
    usage: 'duplicateCard({ card: 1391 })', examples: ['duplicate that trellis card', 'make a copy of the trellis note'] },
  { command: 'renameBasket', description: 'Rename a Trellis basket, or set its colour',
    usage: 'renameBasket({ basket: "Old name", title: "New name" })', examples: ['rename the trellis basket', 'change the name of my notes basket'] },
  { command: 'moveBasket', description: 'Move a Trellis basket under another parent (or to the top level with parent null)',
    usage: 'moveBasket({ basket: "Ideas", parent: "Projects" })', examples: ['move the trellis basket under projects', 'reparent that notes basket'] },
  // finding
  { command: 'listTags', description: 'List the #tags used in the Trellis document, with counts (web)',
    usage: 'listTags', examples: ['what tags do I use in trellis', 'list my trellis tags'] },
  { command: 'findByTag', description: 'Find the Trellis cards carrying a #tag (web)',
    usage: 'findByTag({ tag: "lanagent" })', examples: ['show trellis cards tagged urgent', 'which trellis notes have the #idea tag'] },
  { command: 'queryNotes', description: 'Find Trellis cards by tag AND property AND text in one query (web)',
    usage: 'queryNotes({ tag: "lanagent", key: "status", value: "todo", text: "deploy" })', examples: ['find trellis cards tagged work with status todo', 'query my trellis notes by property'] },
  { command: 'listProperties', description: 'List the key:: properties used in the Trellis document, or the cards carrying one (web)',
    usage: 'listProperties({ key: "owner" })', examples: ['what properties do my trellis cards use', 'which trellis cards have an owner property'] },
  { command: 'cardLinks', description: 'What links to a Trellis card (backlinks), what mentions it without linking, and its shareable link',
    usage: 'cardLinks({ card: 1391 })', examples: ['what links to this trellis card', 'show backlinks for the trellis note'] },
  { command: 'listClaims', description: 'Trellis cards carrying verify:: (claims to re-check), optionally only the overdue ones (web)',
    usage: 'listClaims({ overdue: true })', examples: ['which trellis claims need re-verifying', 'show overdue verify cards in trellis'] },
  { command: 'claimChannel', description: 'Claim a Trellis channel so this agent is the one that auto-answers there, or release it',
    usage: 'claimChannel({ card: 2119 })  // release: claimChannel({ card: 2119, release: true })', examples: ['claim the trellis channel', 'release my claim on that trellis channel'] },
  // layout & admin
  { command: 'groupCards', description: 'Put two or more Trellis cards in a labelled group, or remove a group',
    usage: 'groupCards({ basket: "Ideas", cards: [1391, 1392], title: "Launch" })', examples: ['group these trellis cards together', 'make a trellis group of those cards'] },
  { command: 'dockCard', description: 'Dock a Trellis card to another card so they move together, or undock it (anchor null)',
    usage: 'dockCard({ card: 1392, anchor: 1391 })', examples: ['dock this trellis card to that one', 'undock the trellis card'] },
  { command: 'arrangeBasket', description: 'Tidy a Trellis basket: separate overlapping cards (or, with how "autosort", lay everything out in a grid — no undo)',
    usage: 'arrangeBasket({ basket: "Ideas", how: "overlaps" })', examples: ['tidy up the trellis basket', 'fix overlapping cards in trellis'] },
  { command: 'foldBasket', description: 'Fold or unfold a Trellis basket in the tree, optionally its whole subtree',
    usage: 'foldBasket({ basket: "Archive", expanded: false, subtree: true })', examples: ['collapse the archive basket in trellis', 'expand the trellis basket'] },
  { command: 'listTemplates', description: 'List the saved Trellis templates',
    usage: 'listTemplates', examples: ['what trellis templates do I have', 'list my note templates'] },
  { command: 'applyTemplate', description: 'Apply a saved Trellis template to a basket, or save a basket as a template (save: true)',
    usage: 'applyTemplate({ basket: "Ideas", template: "Weekly review" })', examples: ['apply the weekly review template in trellis', 'save this trellis basket as a template'] },
  { command: 'exportNotes', description: 'Export a Trellis card or basket as markdown, text, csv, json or html',
    usage: 'exportNotes({ basket: "Ideas", format: "markdown" })  // or { card: 1391, format: "text" }', examples: ['export the trellis basket as markdown', 'give me that trellis card as text'] },
  { command: 'clipPage', description: 'Save a copy of a web page as a card in a Trellis basket (paid from the Trellis AI allowance)',
    usage: 'clipPage({ basket: "Reading", url: "https://…" })', examples: ['clip this page into trellis', 'save that article to my trellis reading basket'] },
  { command: 'generateImage', description: 'Generate a picture from a description as an image card in a Trellis basket (paid, ~30 credits from the Trellis allowance)',
    usage: 'generateImage({ basket: "Ideas", prompt: "a lighthouse at dusk" })', examples: ['generate an image in trellis', 'make a picture card in my notes'] },
  { command: 'listShares', description: 'Who the Trellis document is shared with, and its share links (web, owner)',
    usage: 'listShares', examples: ['who can see my trellis notes', 'list trellis sharing'] },
  { command: 'shareNotes', description: 'Share the Trellis document, a basket or a card with a person by email (read or write), or make a read-only link. Needs confirm: true',
    usage: 'shareNotes({ email: "x@y.com", scope: "node", basket: "Ideas", permission: "read", confirm: true })', examples: ['share my trellis basket with someone', 'invite a person to my trellis notes'] },
  { command: 'unshareNotes', description: 'Revoke a Trellis share (a grant id from listShares)',
    usage: 'unshareNotes({ grant: 12 })', examples: ['stop sharing my trellis notes with them', 'revoke the trellis share'] },
  // delete & restore
  { command: 'deleteCard', description: 'Delete a Trellis card to the trash (restorable for 30 days). Needs the card id and its exact title as confirmTitle',
    usage: 'deleteCard({ card: 1391, confirmTitle: "Old draft" })', examples: ['delete trellis card 1391', 'move that trellis note to the trash'] },
  { command: 'deleteBasket', description: 'Delete a Trellis basket to the trash (restorable for 30 days). Needs the basket id and its exact title; a non-empty basket needs recursive: true',
    usage: 'deleteBasket({ basket: 42, confirmTitle: "Old project", recursive: true })', examples: ['delete the trellis basket', 'remove that notes basket'] },
  { command: 'removeChecklistItem', description: 'Remove one line from a Trellis checklist, by its id or exact text',
    usage: 'removeChecklistItem({ card: 1391, item: "Buy milk" })', examples: ['remove milk from the trellis checklist', 'delete that checklist line in trellis'] },
  { command: 'removeFile', description: 'Remove one attached file or picture from a Trellis card, by index; needs its name as confirmName',
    usage: 'removeFile({ card: 1391, index: 0, kind: "file", confirmName: "old.pdf" })', examples: ['remove the attachment from the trellis card', 'delete that picture from the trellis note'] },
  { command: 'listTrash', description: 'What was deleted from the Trellis document in the last 30 days (web)',
    usage: 'listTrash', examples: ['what is in the trellis trash', 'show deleted trellis cards'] },
  // skills
  { command: 'teachSkill', description: 'Teach one of this agent\'s skills to another agent in a Trellis channel: posts a summary with the skill attached as a SKILL.md file (sanitized; a LANAgent installs it, any agent can read it)',
    usage: 'teachSkill({ card: 2119, skill: "humanizer", to: "Orbit" })  // to optional: @mentions that agent in a group channel', examples: ['teach the humanizer skill to orbit in the trellis channel', 'share your inbox triage skill with the other agent in trellis card 2119', 'send the debugging skill to hermes in trellis'] },
  { command: 'restoreFromTrash', description: 'Put deleted Trellis cards or baskets back from the trash, with their original ids — by the batch listTrash shows (web, document owner)',
    usage: 'restoreFromTrash({ batch: "<batch id from listTrash>" })', examples: ['restore the deleted trellis card', 'undelete that trellis basket'] },
  // the document's shared Skills basket (web): src/services/trellis/trellisSkills.js
  ...SKILL_BASKET_COMMANDS
];

export const EXTRA_ACTIONS = new Set(EXTRA_COMMANDS.map(c => c.command));

// ---------------------------------------------------------------- helpers (mixed in)

const helpers = {
  /** A route under /api/documents/{id}: trellis-web only, document in the PATH. */
  async _docRoute(method, sub, { query = {}, body = null } = {}) {
    await this._ensureTarget();
    if (this.resolvedMode !== 'web') {
      throw new Error('This needs trellis-web; the desktop app has no per-document routes for it.');
    }
    const id = encodeURIComponent(this._currentDoc().id);
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return this._request(method, `/api/documents/${id}${sub}${qs ? `?${qs}` : ''}`, body);
  },

  /** GET a routed path as bytes. */
  async _download(route, query = {}) {
    await this._ensureTarget();
    const res = await axios.get(`${this._base()}${this._path(route, query)}`, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: MAX_FILE_BYTES + 1024,
      headers: { 'X-API-Key': this.credentials?.apiKey, 'X-Agent': this._agentName() },
      validateStatus: () => true
    });
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(Buffer.from(res.data).toString('utf8')).error || msg; } catch { /* bytes */ }
      const err = new Error(`Trellis refused the download: ${msg}`);
      err.status = res.status;
      throw err;
    }
    const cd = String(res.headers['content-disposition'] || '');
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
    return { bytes: Buffer.from(res.data), contentType: res.headers['content-type'] || null, name: name ? decodeURIComponent(name) : null };
  },

  /** A local file the agent may upload: inside the allowed roots, real path, under 40 MB. */
  async _readLocalFile(p) {
    if (!p) throw new Error('Give the local file path.');
    const real = await fs.realpath(path.resolve(String(p))).catch(() => null);
    if (!real) throw new Error(`No such file: ${p}`);
    const roots = await Promise.all(UPLOAD_ROOTS.map(r => fs.realpath(r).catch(() => null)));
    if (!roots.some(r => r && (real === r || real.startsWith(r + path.sep)))) {
      throw new Error(`For safety only files under ${UPLOAD_ROOTS.join(', ')} can be uploaded to Trellis.`);
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error(`${p} is not a file.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(real)} is ${(stat.size / 1048576).toFixed(1)} MB; Trellis takes 40 MB at most.`);
    return { name: path.basename(real), data_base64: (await fs.readFile(real)).toString('base64') };
  },

  /** Resolve {basket?, card} to a card object (id or title). */
  async _card(data) {
    const { target } = await this._resolveCardRef(data);
    return target;
  },

  /** Check a destructive action names what it will destroy. */
  _confirmTitle(actual, given, what) {
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    // On image and checklist cards the key:: value properties are stored as extra lines of
    // the title, so the title a person sees is its first line.
    const shown = String(actual ?? '').split('\n')[0];
    if (!given || (norm(given) !== norm(shown) && norm(given) !== norm(actual))) {
      throw new Error(`To delete this ${what}, repeat its exact title as confirmTitle: "${shown || '(untitled)'}". Nothing was deleted.`);
    }
  }
};

// ---------------------------------------------------------------- actions (mixed in)

const actions = {
  async teachSkill({ card, skill, to = null } = {}) {
    if (!(typeof card === 'number' || /^\d+$/.test(String(card ?? '')))) throw new Error('teachSkill needs the channel card id.');
    if (!skill || !String(skill).trim()) throw new Error('teachSkill needs the skill name (see: list skills).');
    const { SkillTeacher } = await import('../skills/skillTeaching.js');
    const teacher = new SkillTeacher({ providerManager: this.agent?.providerManager, teacher: this._agentName() });
    const recipient = to ? String(to).replace(/^@/, '').trim() : null;
    const msg = await teacher.teachOnRequest({ card: Number(card), skillName: String(skill).trim(), to: recipient });
    const said = await this._call('post', `/api/cards/${Number(card)}/say`, { body: { text: msg.text, files: msg.files }, timeoutMs: 120000 });
    return {
      success: true,
      card: Number(card),
      skill: msg.skill,
      seq: said?.seq ?? null,
      result: `Taught \`${msg.skill}\` in Trellis card ${card}${recipient ? ` to @${recipient}` : ''} (SKILL.md attached).`
    };
  },

  // ---- files
  async listFiles(data) {
    const c = await this._card(data);
    const [att, img] = await Promise.all([
      this._call('get', `/api/cards/${c.id}/attachments`).catch(e => ({ error: e.message })),
      this._call('get', `/api/cards/${c.id}/images`).catch(e => ({ error: e.message }))
    ]);
    return {
      success: true, card: c.id, title: c.title || null,
      files: att.attachments || [],
      images: img.images || [],
      inlineImages: img.inline_images || [],
      hint: 'downloadFile with kind "file" (files), "image" (images) or "inline" (inlineImages) and the index.'
    };
  },

  async readFile({ index = 0, ...ref }) {
    const c = await this._card(ref);
    const r = await this._call('get', `/api/cards/${c.id}/attachments/${Number(index)}/text`);
    const text = String(r.text || '');
    return { success: true, card: c.id, name: r.name || null, chars: r.chars ?? text.length,
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [${text.length - MAX_TEXT_CHARS} more chars]` : text };
  },

  async downloadFile({ index = 0, kind = 'file', ...ref }) {
    const c = await this._card(ref);
    const route = kind === 'image' ? `/api/cards/${c.id}/images/${Number(index)}`
      : kind === 'inline' ? `/api/cards/${c.id}/inline/${Number(index)}`
      : `/api/cards/${c.id}/attachments/${Number(index)}`;
    const got = await this._download(route);
    const safe = String(got.name || `${kind}-${index}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
    const file = path.join(DOWNLOAD_DIR, `${c.id}-${kind}${index}-${safe}`);
    await fs.writeFile(file, got.bytes);
    return { success: true, card: c.id, path: file, bytes: got.bytes.length, contentType: got.contentType };
  },

  async transcribeFile({ index = 0, write = true, ...ref }) {
    const c = await this._card(ref);
    const r = await this._call('post', `/api/cards/${c.id}/attachments/${Number(index)}/transcribe`, {
      query: write ? {} : { write: 0 }, timeoutMs: 600000
    });
    return { success: true, card: c.id, written: !!r.written, text: this._trim(r.text || ''), billing: r.billing || null };
  },

  async attachFile({ path: p, name = null, ...ref }) {
    const c = await this._card(ref);
    const f = await this._readLocalFile(p);
    const r = await this._call('post', `/api/cards/${c.id}/attachments`, { body: { name: name || f.name, data_base64: f.data_base64 }, timeoutMs: 120000 });
    return { success: true, card: c.id, index: r.index ?? null, name: r.name || f.name, bytes: r.bytes ?? null };
  },

  async addImage({ path: p, name = null, ...ref }) {
    const c = await this._card(ref);
    const f = await this._readLocalFile(p);
    const r = await this._call('post', `/api/cards/${c.id}/images`, { body: { image_base64: f.data_base64, name: name || f.name }, timeoutMs: 120000 });
    return { success: true, card: c.id, index: r.index ?? null, marker: r.marker || null };
  },

  async connectCards({ from, to, label, style, arrows, color } = {}) {
    const a = Number(from), b = Number(to);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
      throw new Error('connectCards needs two different card ids: from and to.');
    }
    const [ca, cb] = await Promise.all([this._call('get', `/api/cards/${a}`), this._call('get', `/api/cards/${b}`)]);
    const na = ca?.node ?? ca?.card?.node, nb = cb?.node ?? cb?.card?.node;
    if (na == null || nb == null) throw new Error(`Could not find the basket of card ${na == null ? a : b}.`);
    if (na !== nb) {
      throw new Error(`Cards ${a} and ${b} are in different baskets (${na} and ${nb}). A connector joins two cards of one basket; across baskets, link with [[#${b}]] in a card body.`);
    }
    const body = { from: a, to: b };
    if (label) body.label = String(label).slice(0, 200);
    if (style) body.style = style;
    if (arrows) body.arrows = arrows;
    if (color) body.color = color;
    const r = await this._call('post', `/api/nodes/${na}/connectors`, { body });
    const connector = r?.connector || r;
    return { success: true, basket: na, connector, result: `Connected card ${a} → card ${b}${label ? ` ("${label}")` : ''} in basket ${na}.` };
  },

  async layoutFlow({ basket, dir = 'down' } = {}) {
    const node = await this._resolveNode(basket, { allowDefault: true });
    const d = dir === 'right' ? 'right' : 'down';
    const r = await this._call('post', `/api/nodes/${node.id}/layout`, { body: { kind: 'flow', dir: d } });
    return { success: true, basket: node.id, moved: r?.moved ?? null, result: `Laid out ${node.title || `basket ${node.id}`} as a flowchart (${d === 'right' ? 'left to right' : 'top down'}): ${r?.moved ?? 0} card(s) moved.` };
  },

  async createImageCard({ basket, title, query, url, path: p, name, ...rest }) {
    // The AI parameter extractor names the search its own way ({description: "a cool frog"}).
    query = query || rest.description || rest.search || rest.searchQuery || rest.searchTerm ||
      rest.subject || rest.topic || rest.prompt || rest.keywords || rest.q || null;
    url = url || rest.imageUrl || rest.image_url || null;
    const node = await this._resolveNode(basket, { allowDefault: true });
    let picture, credit = null, source = null;
    if (p) {
      const f = await this._readLocalFile(p);
      picture = { base64: f.data_base64, name: name || f.name };
    } else {
      let fetchUrl = url;
      if (!fetchUrl) {
        if (!query) throw new Error('createImageCard needs a query (what to find), an image url, or a local path.');
        const found = await findCommonsImage(query);
        fetchUrl = found.url; credit = found.credit; source = found.pageUrl;
        name = name || found.name;
      }
      const img = await fetchPublicImage(fetchUrl);
      picture = { base64: img.bytes.toString('base64'), name: name || img.name };
      source = source || String(fetchUrl);
    }
    const cardTitle = String(title || query || picture.name).slice(0, 120);
    const r = await this._call('post', `/api/nodes/${node.id}/cards`, {
      body: { kind: 'image', title: cardTitle, image_base64: picture.base64, image_name: picture.name, fit: true },
      timeoutMs: 120000
    });
    const id = r.id ?? r.card?.id ?? null;
    // Where it came from, and whose it is, on the card itself (best effort).
    if (id && source) await this._call('post', `/api/cards/${id}/property`, { body: { key: 'source', value: source } }).catch(() => {});
    if (id && credit) await this._call('post', `/api/cards/${id}/property`, { body: { key: 'credit', value: credit } }).catch(() => {});
    return { success: true, card: id, basket: node.id, basketTitle: node.title, title: cardTitle, source, credit };
  },

  async ocrImage(data) {
    const c = await this._card(data);
    const r = await this._call('post', `/api/cards/${c.id}/ocr`, { timeoutMs: 180000 });
    return { success: true, card: c.id, text: this._trim(r.text ?? r.content ?? JSON.stringify(r)) };
  },

  // ---- editing
  async editCard({ title, body, color, ...ref }) {
    const c = await this._card(ref);
    const patch = {};
    if (title !== undefined) patch.title = String(title);
    if (body !== undefined) patch.body = String(body);
    if (color !== undefined) patch.color = color;
    if (!Object.keys(patch).length) throw new Error('editCard needs a title, body or color to change.');
    await this._call('patch', `/api/cards/${c.id}`, { body: patch });
    return { success: true, updated: { card: c.id, fields: Object.keys(patch) } };
  },

  async addChecklistItem({ text, ...ref }) {
    if (!text || !String(text).trim()) throw new Error('addChecklistItem needs text.');
    const c = await this._card(ref);
    const r = await this._call('post', `/api/cards/${c.id}/items`, { body: { text: String(text).trim() } });
    return { success: true, card: c.id, item: r.item ?? r.id ?? null };
  },

  async _itemId(card, item) {
    if (isId(item)) return Number(item);
    const items = card.items || [];
    const want = String(item ?? '').trim().toLowerCase();
    const hit = items.filter(i => String(i.text || '').trim().toLowerCase() === want);
    const loose = hit.length ? hit : items.filter(i => String(i.text || '').toLowerCase().includes(want));
    if (loose.length !== 1) {
      throw new Error(loose.length
        ? `"${item}" matches ${loose.length} lines: ${loose.slice(0, 6).map(i => `${i.text} (${i.id})`).join(', ')}.`
        : `No line matching "${item}" on that checklist.`);
    }
    return loose[0].id;
  },

  async setChecklistItem({ item, done, text, ...ref }) {
    const c = await this._card(ref);
    const id = await this._itemId(c, item);
    const body = {};
    if (done !== undefined) body.done = !!done;
    if (text !== undefined) body.text = String(text);
    if (!Object.keys(body).length) body.done = true;
    await this._call('patch', `/api/cards/${c.id}/items/${id}`, { body });
    return { success: true, card: c.id, item: id, ...body };
  },

  async setProperty({ key, value = null, ...ref }) {
    if (!key) throw new Error('setProperty needs a key.');
    const c = await this._card(ref);
    await this._call('post', `/api/cards/${c.id}/property`, { body: { key: String(key), value: value === null ? null : String(value) } });
    return { success: true, card: c.id, key, value };
  },

  /**
   * A sign-off is a verdict on the card's content as it stands (relay 2754 #283–#294). The
   * digest of the card as read goes with it, so an approval never lands on text this agent did
   * not see: the server answers 409 if the card changed in between.
   */
  async signOff({ verdict = 'approved', note = null, digest = null, ...ref }) {
    const v = String(verdict).toLowerCase().trim();
    const norm = /^(approve|approved|ok|yes|lgtm|sign)/.test(v) ? 'approved'
      : /^(change|changes|changes-requested|request)/.test(v) ? 'changes-requested'
      : /^(reject|rejected|no|deny)/.test(v) ? 'rejected' : null;
    if (!norm) throw new Error('signOff verdict is approved, changes-requested or rejected.');
    const c = await this._card(ref);
    const read = digest || c.signoff_digest || null;
    const body = { verdict: norm, ...(note ? { note: String(note).slice(0, 200) } : {}), ...(read ? { digest: read } : {}) };
    try {
      const r = await this._call('post', `/api/cards/${c.id}/signoff`, { body });
      return { success: true, card: c.id, title: c.title || null, verdict: norm, digest: r?.digest || read, signoff: r?.signoff || r?.card?.signoff || null };
    } catch (err) {
      if (err.status === 409) {
        return { success: false, card: c.id, error: 'The card changed after it was read, so nothing was signed. Read it again and decide on the current text.', currentDigest: err.data?.digest || null };
      }
      if (err.status === 400 && /channel/i.test(err.message)) {
        return { success: false, card: c.id, error: `Card ${c.id} is a channel; a sign-off is for a card's content. ${err.message}` };
      }
      throw err;
    }
  },

  async withdrawSignOff(ref) {
    const c = await this._card(ref);
    try {
      await this._call('delete', `/api/cards/${c.id}/signoff`);
      return { success: true, card: c.id, title: c.title || null, withdrawn: true };
    } catch (err) {
      if (err.status === 404) return { success: false, card: c.id, error: `There is no sign-off of mine on card ${c.id} to withdraw.` };
      throw err;
    }
  },

  async editTable({ ops, ...ref }) {
    if (!ops || (Array.isArray(ops) && !ops.length)) throw new Error('editTable needs ops, e.g. [{ op: "set_cell", row: 1, col: 0, text: "x" }].');
    const c = await this._card(ref);
    await this._call('post', `/api/cards/${c.id}/table`, { body: ops });
    return { success: true, card: c.id, applied: Array.isArray(ops) ? ops.length : 1 };
  },

  async moveCard({ toBasket, to, before, after, ...ref }) {
    const c = await this._card(ref);
    let body;
    if (toBasket !== undefined && toBasket !== null && toBasket !== '') {
      const node = await this._resolveNode(toBasket);
      body = { node: node.id };
    } else if (before !== undefined) body = { before: Number(before) };
    else if (after !== undefined) body = { after: Number(after) };
    else if (to === 'front' || to === 'back') body = { to };
    else throw new Error('moveCard needs toBasket, or to: "front" | "back", or before/after a card id.');
    const r = await this._call('post', `/api/cards/${c.id}/move`, { body });
    return { success: true, card: c.id, node: r.node ?? body.node ?? null, index: r.index ?? null };
  },

  async duplicateCard(data) {
    const c = await this._card(data);
    const r = await this._call('post', `/api/cards/${c.id}/duplicate`);
    return { success: true, original: c.id, copy: r.id ?? r.card?.id ?? null, basket: r.node ?? null };
  },

  async renameBasket({ basket, title, color }) {
    const node = await this._resolveNode(basket);
    const patch = {};
    if (title) patch.title = String(title);
    if (color !== undefined) patch.color = color;
    if (!Object.keys(patch).length) throw new Error('renameBasket needs a title or color.');
    await this._call('patch', `/api/nodes/${node.id}`, { body: patch });
    return { success: true, basket: node.id, was: node.title, ...patch };
  },

  async moveBasket({ basket, parent }) {
    const node = await this._resolveNode(basket);
    const target = parent === null || parent === 'top' ? null : (await this._resolveNode(parent)).id;
    const r = await this._call('post', `/api/nodes/${node.id}/move`, { body: { parent: target } });
    return { success: true, basket: node.id, parent: r.parent ?? target, index: r.index ?? null };
  },

  // ---- finding
  async listTags() {
    const r = await this._docRoute('get', '/tags');
    return { success: true, tags: r.tags || r };
  },

  async findByTag({ tag }) {
    if (!tag) throw new Error('findByTag needs a tag.');
    const r = await this._docRoute('get', `/tags/${encodeURIComponent(String(tag).replace(/^#/, ''))}`);
    const cards = r.hits || r.cards || r.results || [];
    return { success: true, tag, count: r.count ?? cards.length, cards: cards.slice(0, 50) };
  },

  async queryNotes({ tag, key, value, text }) {
    if (!tag && !key && !text) throw new Error('queryNotes needs at least one of tag, key or text.');
    const r = await this._docRoute('get', '/query', { query: { tag: tag ? String(tag).replace(/^#/, '') : undefined, key, value, q: text } });
    const cards = r.hits || r.cards || r.results || [];
    return { success: true, count: r.count ?? cards.length, cards: cards.slice(0, 50) };
  },

  async listProperties({ key, value } = {}) {
    const r = await this._docRoute('get', '/properties', { query: { key, value } });
    return { success: true, ...r };
  },

  async cardLinks(data) {
    const c = await this._card(data);
    const [back, ment, link] = await Promise.all([
      this._call('get', `/api/cards/${c.id}/backlinks`).catch(e => ({ error: e.message })),
      this._call('get', `/api/cards/${c.id}/mentions`).catch(e => ({ error: e.message })),
      this._call('get', `/api/cards/${c.id}/link`).catch(e => ({ error: e.message }))
    ]);
    return { success: true, card: c.id, link: link.link || null, wikilink: link.wikilink || null,
      backlinks: back.backlinks || back.cards || [], mentions: ment.mentions || ment.cards || [] };
  },

  async listClaims({ overdue = false } = {}) {
    const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
    const r = await this._docRoute('get', '/claims', { query: overdue ? { due: 'true', day } : { day } });
    return { success: true, ...r };
  },

  async claimChannel({ card, release = false }) {
    if (!isId(card)) throw new Error('claimChannel needs the channel card id.');
    const r = release
      ? await this._call('delete', `/api/cards/${Number(card)}/channel/claim`)
      : await this._call('post', `/api/cards/${Number(card)}/channel/claim`, { body: { agent: this._agentName() } });
    return { success: true, card: Number(card), claimedBy: r.claimed_by ?? null, changed: r.changed ?? null };
  },

  // ---- layout & admin
  async groupCards({ basket, cards, title, color, remove }) {
    const node = await this._resolveNode(basket, { allowDefault: true });
    if (remove !== undefined && remove !== null) {
      await this._call('delete', `/api/nodes/${node.id}/groups/${encodeURIComponent(String(remove))}`);
      return { success: true, basket: node.id, removedGroup: remove };
    }
    if (!Array.isArray(cards) || cards.length < 2) throw new Error('groupCards needs at least two card ids.');
    const r = await this._call('post', `/api/nodes/${node.id}/groups`, { body: { cards: cards.map(Number), ...(title ? { title } : {}), ...(color ? { color } : {}) } });
    return { success: true, basket: node.id, group: r.id ?? r.group ?? null };
  },

  async dockCard({ anchor = null, ...ref }) {
    const c = await this._card(ref);
    if (anchor === null) await this._call('delete', `/api/cards/${c.id}/dock`);
    else await this._call('post', `/api/cards/${c.id}/dock`, { body: { anchor: Number(anchor) } });
    return { success: true, card: c.id, anchor };
  },

  async arrangeBasket({ basket, how = 'overlaps' }) {
    if (!['overlaps', 'autosort'].includes(how)) throw new Error('how is "overlaps" or "autosort".');
    const node = await this._resolveNode(basket, { allowDefault: true });
    const r = await this._call('post', `/api/nodes/${node.id}/arrange`, { body: { how } });
    return { success: true, basket: node.id, how, result: r };
  },

  async foldBasket({ basket, expanded = false, subtree = false }) {
    const node = await this._resolveNode(basket);
    await this._call('post', `/api/nodes/${node.id}/expand`, { body: { expanded: !!expanded, subtree: !!subtree } });
    return { success: true, basket: node.id, expanded: !!expanded, subtree: !!subtree };
  },

  async listTemplates() {
    await this._ensureTarget();
    const r = await this._request('get', '/api/templates');
    return { success: true, templates: r.templates || r };
  },

  async applyTemplate({ basket, template, save = false, name }) {
    const node = await this._resolveNode(basket, { allowDefault: true });
    if (save) {
      const r = await this._request('post', '/api/templates', { node: node.id, name: String(name || node.title) });
      return { success: true, saved: r };
    }
    const list = (await this.listTemplates()).templates;
    const all = Array.isArray(list) ? list : [];
    const t = isId(template) ? all.find(x => String(x.id) === String(template))
      : all.find(x => String(x.name || x.title || '').toLowerCase() === String(template || '').toLowerCase());
    if (!t) throw new Error(`No template "${template}". Templates: ${all.map(x => x.name || x.title).join(', ') || 'none'}.`);
    const r = await this._call('post', `/api/nodes/${node.id}/from-template`, { body: { template: t.id } });
    return { success: true, basket: node.id, template: t.name || t.title, result: r };
  },

  async exportNotes({ basket, card, format = 'markdown' }) {
    if (card !== undefined && card !== null && card !== '') {
      const c = await this._card({ basket, card });
      const fmt = format === 'markdown' ? 'markdown' : format;
      const r = await this._call('get', `/api/cards/${c.id}/export`, { query: { format: fmt } });
      return { success: true, card: c.id, format: fmt, content: this._trimLong(r.content ?? '') };
    }
    const node = await this._resolveNode(basket);
    const r = await this._call('get', `/api/nodes/${node.id}/export`, { query: { format } });
    return { success: true, basket: node.id, format, content: this._trimLong(r.content ?? (typeof r === 'string' ? r : JSON.stringify(r))) };
  },

  _trimLong(text) {
    const s = String(text || '');
    return s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}\n… [${s.length - MAX_TEXT_CHARS} more chars]` : s;
  },

  async clipPage({ basket, url }) {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('clipPage needs an http(s) url.');
    const node = await this._resolveNode(basket, { allowDefault: true });
    const r = await this._call('post', `/api/nodes/${node.id}/clip`, { body: { url: String(url) }, timeoutMs: 120000 });
    return { success: true, basket: node.id, card: r.id ?? null, title: r.title ?? null };
  },

  async generateImage({ basket, prompt, title }) {
    if (!prompt) throw new Error('generateImage needs a prompt.');
    const node = await this._resolveNode(basket, { allowDefault: true });
    const r = await this._call('post', `/api/nodes/${node.id}/generate-image`, { body: { prompt: String(prompt), ...(title ? { title } : {}) }, timeoutMs: 180000 });
    return { success: true, basket: node.id, card: r.id ?? null };
  },

  async listShares() {
    const r = await this._docRoute('get', '/grants');
    return { success: true, count: r.count ?? (r.grants || []).length, grants: r.grants || [] };
  },

  async shareNotes({ email, scope = 'document', basket, card, permission = 'read', label, expiresInDays, confirm = false }) {
    if (confirm !== true) {
      throw new Error('Sharing gives someone else access to the operator\'s notes — call again with confirm: true. Nothing was shared.');
    }
    const body = { scope_kind: scope, permission, ...(email ? { email: String(email) } : {}), ...(label ? { label } : {}), ...(expiresInDays ? { expires_in_days: Number(expiresInDays) } : {}) };
    if (scope === 'node') body.scope_id = (await this._resolveNode(basket)).id;
    if (scope === 'card') body.scope_id = (await this._card({ basket, card })).id;
    const r = await this._docRoute('post', '/grants', { body });
    return { success: true, ...r };
  },

  async unshareNotes({ grant }) {
    if (!isId(grant)) throw new Error('unshareNotes needs a grant id (listShares shows them).');
    await this._ensureTarget();
    await this._request('delete', `/api/grants/${Number(grant)}`);
    return { success: true, revoked: Number(grant) };
  },

  // ---- delete & restore (to the trash)
  async deleteCard({ confirmTitle, ...ref }) {
    if (!isId(ref.card)) throw new Error('deleteCard needs the card id (a number) — titles repeat. Nothing was deleted.');
    const c = await this._card(ref);
    this._confirmTitle(c.title, confirmTitle, 'card');
    this.logger.warn(`[trellis-notes] deleting card ${c.id} "${c.title}" to the trash`);
    await this._call('delete', `/api/cards/${c.id}`);
    return { success: true, deleted: { card: c.id, title: c.title }, restore: "In the trash for 30 days: listTrash then restoreFromTrash({ batch }) with a document-owner key, or Trash in the Trellis app." };
  },

  async deleteBasket({ basket, confirmTitle, recursive = false }) {
    if (!isId(basket)) throw new Error('deleteBasket needs the basket id (a number) — titles repeat. Nothing was deleted.');
    const node = await this._resolveNode(basket);
    this._confirmTitle(node.title, confirmTitle, 'basket');
    this.logger.warn(`[trellis-notes] deleting basket ${node.id} "${node.title}"${recursive ? ' and everything under it' : ''} to the trash`);
    await this._call('delete', `/api/nodes/${node.id}`, { query: recursive ? { recursive: 'true' } : {} });
    return { success: true, deleted: { basket: node.id, title: node.title, recursive: !!recursive }, restore: "In the trash for 30 days: listTrash then restoreFromTrash({ batch }) with a document-owner key, or Trash in the Trellis app." };
  },

  async removeChecklistItem({ item, ...ref }) {
    const c = await this._card(ref);
    const id = await this._itemId(c, item);
    const line = (c.items || []).find(i => i.id === id);
    this.logger.warn(`[trellis-notes] removing checklist line ${id} from card ${c.id}`);
    const r = await this._call('delete', `/api/cards/${c.id}/items/${id}`);
    return { success: true, card: c.id, removed: { item: id, text: line?.text ?? null, index: r.index ?? null } };
  },

  async removeFile({ index, kind = 'file', confirmName, ...ref }) {
    if (!isId(index)) throw new Error('removeFile needs the index (listFiles shows them).');
    const c = await this._card(ref);
    const listing = await this.listFiles({ card: c.id });
    const list = kind === 'image' ? listing.images : listing.files;
    const f = list.find(x => Number(x.index) === Number(index));
    if (!f) throw new Error(`No ${kind} at index ${index} on card ${c.id}.`);
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    if (norm(f.name) !== norm(confirmName)) {
      throw new Error(`To remove it, repeat its name as confirmName: "${f.name}". Nothing was removed.`);
    }
    this.logger.warn(`[trellis-notes] removing ${kind} ${index} "${f.name}" from card ${c.id}`);
    await this._call('delete', kind === 'image' ? `/api/cards/${c.id}/images/${Number(index)}` : `/api/cards/${c.id}/attachments/${Number(index)}`);
    return { success: true, card: c.id, removed: { kind, index: Number(index), name: f.name } };
  },

  async listTrash() {
    const r = await this._docRoute('get', '/trash');
    return { success: true, ...r };
  },

  async restoreFromTrash({ batch }) {
    // The trash is restored by deletion BATCH (one delete = one batch), as listTrash lists it.
    if (batch === undefined || batch === null || batch === '') throw new Error('restoreFromTrash needs the batch id listTrash shows.');
    const r = await this._docRoute('post', '/trash/restore', { body: { batch } });
    return { success: true, restored: { batch }, result: r };
  }
};

/** Mix the helpers and actions into the plugin class. */
export function installTrellisExtras(PluginClass) {
  for (const [name, fn] of Object.entries({ ...helpers, ...actions, ...skillBasketActions })) {
    if (Object.prototype.hasOwnProperty.call(PluginClass.prototype, name)) {
      throw new Error(`trellisExtras: ${name} already exists on the plugin`);
    }
    PluginClass.prototype[name] = fn;
  }
}
