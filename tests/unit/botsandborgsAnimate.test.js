// Store Animation API (bnb-motion/1, llms.txt "Animation API"): the agent writes what its body does, the store solves it
// on the worn avatar, the clip is installed, pushed and played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';
import { parseMotionScript, motionName, readJob, reportFailures, motionTags, motionPrompt } from '../../src/services/store/animSolve.js';

const WAVE = { format: 'bnb-motion/1', name: 'Big Wave!', duration: 3, loop: false, keys: [
  { t: 1.2, hands: { right: { at: { landmark: 'rightEar', offset: [-0.2, 0.05, 0.1] }, palm: 'forward', shape: 'open', elbow: 'out' } } },
  { t: 0.1, hands: { right: { rest: 'hang' } }, bogus: 1 },
  { t: 3, hands: { right: { rest: 'hang' } } }
] };

test('a script is tidied to what the store takes: name, sorted keys from t 0, no stray fields', () => {
  const { script, error } = parseMotionScript(`Here you go:\n${JSON.stringify({ ...WAVE, extra: true })}`);
  assert.equal(error, undefined);
  assert.equal(script.name, 'big-wave');
  assert.equal(script.keys[0].t, 0);
  assert.deepEqual(script.keys.map(k => k.t), [0, 1.2, 3]);
  assert.equal('bogus' in script.keys[0], false);
  assert.equal('extra' in script, false);
  assert.equal(script.format, 'bnb-motion/1');
});

test('what the store would refuse is caught before a solve is spent', () => {
  assert.match(parseMotionScript('no json').error, /no JSON/);
  assert.match(parseMotionScript(JSON.stringify({ ...WAVE, duration: 45 })).error, /limit is 30/);
  assert.match(parseMotionScript(JSON.stringify({ ...WAVE, keys: [{ t: 0, hands: { right: { at: { landmark: 'elbow' } } } }] })).error, /unknown landmark elbow/);
  assert.match(parseMotionScript(JSON.stringify({ ...WAVE, keys: [{ t: 0, hands: { right: { shape: 'claw' } } }] })).error, /shape claw/);
  assert.match(parseMotionScript(JSON.stringify({ ...WAVE, keys: Array.from({ length: 65 }, (_, i) => ({ t: i * 0.1 })) })).error, /limit is 64/);
  assert.ok(parseMotionScript(JSON.stringify({ ...WAVE, keys: [{ t: 0, hands: { left: { at: { landmark: 'leftThigh@0.5' } } } }] })).script);
});

test('names, tags, job replies and failed checks', () => {
  assert.equal(motionName('Salute — left hand'), 'salute-left-hand');
  assert.equal(motionName('!!!'), 'move');
  assert.deepEqual(motionTags('make yourself an animation of waving with both hands'), ['waving', 'both', 'hands']);
  assert.deepEqual(readJob({ job: 'aj_1', poll: '/api/anim/jobs/aj_1' }), { id: 'aj_1', status: 'queued', report: null, vrma: null, preview: null, reason: null });
  assert.equal(readJob({ job: { id: 'aj_2', status: 'passed', vrma: { url: '/v' } } }).vrma, '/v');
  assert.equal(readJob({ id: 'aj_3', status: 'failed', report: [] }).status, 'failed');
  assert.equal(reportFailures({ checks: [{ name: 'wrist_bend', pass: false, value: 52, limit: 40, unit: '°' }, { name: 'seam', pass: true }] }), 'wrist bend 52° (limit 40°)');
  assert.equal(reportFailures(null), '');
  // The store's own shape (3910 #1929).
  assert.equal(reportFailures({ status: 'failed', checks: { through: { pass: false, worst_mm: 5.5, limit_mm: 3, at_t: 1.9, where: 'right->arm' }, wrist: { pass: true, peak_deg: 12 } }, nudges: 3, rounds: 6 }),
    'through 5.5 mm (limit 3 mm) at 1.9 s, right->arm');
  assert.match(motionPrompt('wave', { props: ['mug'] }), /"prop".*mug/);
  assert.match(motionPrompt('wave', { error: 'unknown field foo', previous: { a: 1 } }), /refused: unknown field foo/);
});

function plugin({ routes = {}, answers = [JSON.stringify(WAVE)], passes = [] } = {}) {
  const store = { live: { passes } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const prompts = [];
  const agent = { agentModel: { activeVRMModel: 'store-vrm-racer-blue' }, providerManager: { generateResponse: async (prompt) => { prompts.push(prompt); return { content: answers.shift() ?? JSON.stringify(WAVE) }; } } };
  const p = new BotsAndBorgsPlugin(agent);
  p.accountKey = async () => 'bnba_test';
  const calls = [];
  p.api = async (method, route, opts = {}) => {
    calls.push({ method, route, body: opts.body });
    const h = routes[`${method} ${route.split('?')[0]}`];
    if (typeof h === 'function') return h(opts);
    if (h) return h;
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  const told = [];
  p.agent.notify = async (text) => { told.push(text); };
  return { p, store, calls, told, prompts };
}

test('solved on the worn live pass, installed for that body, tagged and played', async () => {
  const t = plugin({
    passes: [{ slug: 'vrm-racer-blue', key: 'enc', state: 'active' }],
    routes: {
      'post /api/anim/solve': { job: 'aj_9', poll: '/api/anim/jobs/aj_9' },
      'get /api/anim/jobs/aj_9': { job: { id: 'aj_9', status: 'passed', vrma: '/api/anim/jobs/aj_9/clip.vrma', preview: '/api/anim/jobs/aj_9/preview.mp4', report: {} } }
    }
  });
  const fetched = [];
  t.p.http = async (req) => { fetched.push(req.url); assert.equal(req.headers.Authorization, 'Bearer bnba_test'); return { status: 200, data: Buffer.from('x') }; };
  let ingested = null;
  t.p.ingest = async (a) => { ingested = a; return { variant: a.variant, files: [{ kind: 'animation', name: 'big-wave.vrma', label: 'Big Wave', size: 1 }] }; };
  let saved = null; t.p.saveLibraryItem = async (i) => { saved = i; };
  t.p.publishAnimations = async () => [];
  let played = null; t.p.playClip = async (a) => { played = a; return { success: true, result: 'Doing Big Wave now, in AvatarX.' }; };
  const orig = t.p.followAnim.bind(t.p);
  t.p.followAnim = (rec, key, first) => orig(rec, key, first, { pollMs: 1 });
  const r = await t.p.animate({ motion: 'wave with both hands over your head', wait: true });
  assert.equal(r.success, true, r.error);
  const sent = t.calls.find(c => c.route === '/api/anim/solve').body;
  assert.deepEqual(sent.avatar, { live: 'vrm-racer-blue' });
  assert.equal(sent.script.name, 'big-wave');
  assert.deepEqual(fetched, ['https://botsandborgs.com/api/anim/jobs/aj_9/clip.vrma', 'https://botsandborgs.com/api/anim/jobs/aj_9/preview.mp4']);
  assert.equal(ingested.variant, 'solved-big-wave-animations');
  assert.equal(saved.solvedFor, 'store-vrm-racer-blue');
  assert.ok(saved.files[0].tags.includes('wave'));
  assert.deepEqual(played, { item: 'solved-big-wave-animations', clip: 'Big Wave' });
  assert.equal(t.told.length, 0, 'a waited answer is the reply itself');
  assert.equal(t.store.animJobs.jobs[0].status, 'installed');
});

test('a 400 is fed back to the model once; a failed solve says why in the store\'s numbers', async () => {
  let n = 0;
  const t = plugin({
    routes: {
      'post /api/anim/solve': () => { if (n++ === 0) throw Object.assign(new Error('keys[1].lean.tilt: unknown field'), { status: 400 }); return { job: 'aj_5' }; },
      'get /api/anim/jobs/aj_5': { id: 'aj_5', status: 'failed', report: { checks: [{ name: 'body_clearance', pass: false, value: 22.8, limit: 3, unit: ' mm' }] } }
    }
  });
  const orig = t.p.followAnim.bind(t.p);
  t.p.followAnim = (rec, key, first) => orig(rec, key, first, { pollMs: 1 });
  const r = await t.p.animate({ motion: 'touch your toes', wait: true });
  assert.equal(r.success, false);
  assert.match(r.error, /body clearance 22\.8 mm \(limit 3 mm\)/);
  // A 400 rewrite, then the failed solve rewritten from its numbers once (it fails again here): three solves, no more.
  assert.equal(t.calls.filter(c => c.route === '/api/anim/solve').length, 3);
  assert.match(t.prompts[2], /checks failed: body clearance 22\.8 mm/);
  assert.equal(t.store.animJobs.jobs[0].retryOf, 'aj_5');
  assert.match(t.prompts[1], /refused: .*keys\[1\]\.lean\.tilt/);
  // Not wearing a store pass: the store product it is.
  assert.deepEqual(t.calls[0].body.avatar, { product: 'vrm-racer-blue' });
});

test('a failed solve rewritten from the store\'s numbers can pass and is played', async () => {
  let n = 0;
  const t = plugin({
    routes: {
      'post /api/anim/solve': () => ({ job: n++ === 0 ? 'aj_a' : 'aj_b' }),
      'get /api/anim/jobs/aj_a': { id: 'aj_a', status: 'failed', report: { checks: { through: { pass: false, worst_mm: 5.5, at_t: 1.9, where: 'right->arm' } } } },
      'get /api/anim/jobs/aj_b': { id: 'aj_b', status: 'passed', vrma: '/api/anim/jobs/aj_b/clip.vrma' }
    }
  });
  t.p.http = async () => ({ status: 200, data: Buffer.from('x') });
  t.p.ingest = async (a) => ({ variant: a.variant, files: [{ kind: 'animation', name: 'big-wave.vrma', label: 'Big Wave', size: 1 }] });
  t.p.saveLibraryItem = async () => {};
  t.p.publishAnimations = async () => [];
  t.p.playClip = async () => ({ success: true, result: 'Doing Big Wave now.' });
  const orig = t.p.followAnim.bind(t.p);
  t.p.followAnim = (rec, key, first) => orig(rec, key, first, { pollMs: 1 });
  const r = await t.p.animate({ motion: 'wave with both hands', wait: true });
  assert.equal(r.success, true, r.error);
  assert.match(t.prompts[1], /through 5\.5 mm at 1\.9 s, right->arm/);
  assert.equal(t.store.animJobs.jobs[0].id, 'aj_b');
  assert.equal(t.store.animJobs.jobs[0].status, 'installed');
});

test('no store body, no request: a plain answer, nothing sent', async () => {
  const t = plugin();
  t.p.agent.agentModel.activeVRMModel = 'my-own-model';
  assert.match((await t.p.animate({ motion: 'wave' })).error, /not wearing a Bots & Borgs model/);
  assert.match((await t.p.animate({})).error, /What should the move be/);
  assert.equal(t.calls.length, 0);
});

test('a solved clip plays only on the body it was solved for', async () => {
  const t = plugin();
  const items = [{ variant: 'solved-big-wave-animations', solvedFor: 'store-vrm-other', files: [{ kind: 'animation', name: 'big-wave.vrma', label: 'Big Wave' }] }];
  t.p.libraryItems = async () => items;
  t.p.wornBody = async () => 'female';
  t.p.unsupportedProps = async () => new Map();
  const r = await t.p.chooseClip({ clip: 'big wave' });
  assert.ok(r.error, 'the other body\'s clip is not offered');
  items[0].solvedFor = 'store-vrm-racer-blue';
  const mine = await t.p.chooseClip({ clip: 'big wave' });
  assert.equal(mine.error, undefined, mine.error);
  assert.equal(mine.choice.file.label, 'Big Wave');
});
