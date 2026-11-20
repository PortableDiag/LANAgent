/**
 * Pre-PR module load check for the self-modification pipeline.
 *
 * `node --check` cannot see a bad named import or a missing relative module,
 * and nothing else loaded a changed file before a PR opened — two of five
 * crypto-side PRs on 2026-09-14 would have crashed boot. These cases mirror
 * those two plus the classifications that must NOT block.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SelfModificationService } from '../../src/services/selfModification.js';

// Construct the real class: a constructor that throws is the failure mode
// this file exists to rule out.
const svc = new SelfModificationService();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfmod-load-'));
svc.developmentPath = dir;

const write = (name, code) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, code);
  return p;
};

const good = write('good.js', "export default class Good {}\nexport const NAME = 'good';\n");

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a loadable module passes', () => {
  const r = svc.verifyModuleLoads(good);
  assert.deepStrictEqual(r, { ok: true, fatal: false, message: '' });
});

test('a syntax error (await in a non-async method) is fatal', () => {
  const p = write('bad-syntax.js', 'export class X { start() { await this.load(); } }\n');
  const r = svc.verifyModuleLoads(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true);
  assert.match(r.message, /syntax: |SyntaxError/);
});

test('importing a named export the module does not provide is fatal (invisible to node --check)', () => {
  const p = write('bad-named-import.js', "import { TrustService } from './good.js';\nexport const t = TrustService;\n");
  const r = svc.verifyModuleLoads(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true);
  assert.match(r.message, /does not provide an export named 'TrustService'/);
});

test('a missing relative module is fatal', () => {
  const p = write('bad-relative.js', "import x from './nope.js';\nexport default x;\n");
  const r = svc.verifyModuleLoads(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true);
  assert.match(r.message, /missing module .*nope\.js/);
});

test('a bare package that is not installed is only a warning', () => {
  const p = write('missing-pkg.js', "import x from 'definitely-not-installed-pkg-xyz';\nexport default x;\n");
  const r = svc.verifyModuleLoads(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, false);
  assert.match(r.message, /not installed in the analysis repo/);
});

test('a load-time ReferenceError is fatal', () => {
  const p = write('bad-ref.js', 'export const LEVELS = { basic: 1, full: { ...LEVELS.basic } };\n');
  const r = svc.verifyModuleLoads(p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true);
  assert.match(r.message, /ReferenceError/);
});

test('classifyLoadFailure keeps unknown failures non-fatal', () => {
  const r = svc.classifyLoadFailure('Error: ECONNREFUSED 127.0.0.1:27017\n    at connect', 'src/x.js');
  assert.strictEqual(r.fatal, false);
  assert.match(r.message, /src\/x\.js: Error: ECONNREFUSED/);
});

test('browser code under src/interfaces/web/public is syntax-checked only, never imported in Node', () => {
  const pub = path.join(dir, 'src', 'interfaces', 'web', 'public', 'lib');
  fs.mkdirSync(pub, { recursive: true });
  const p = path.join(pub, 'three.wrapper.js');
  fs.writeFileSync(p, 'export const w = window.devicePixelRatio;\n');
  assert.deepStrictEqual(svc.verifyModuleLoads(p), { ok: true, fatal: false, message: '' });
  // The same code outside public/ is server code and still fails the import.
  const server = write('uses-window.js', 'export const w = window.devicePixelRatio;\n');
  const r = svc.verifyModuleLoads(server);
  assert.strictEqual(r.fatal, true, JSON.stringify(r));
  assert.match(r.message, /window is not defined/);
});

test('the live avatar page sources (avatar-live/src) are browser code: syntax-checked only', () => {
  const src = path.join(dir, 'src', 'interfaces', 'web', 'avatar-live', 'src');
  fs.mkdirSync(src, { recursive: true });
  const p = path.join(src, 'lanagent.js');
  fs.writeFileSync(p, 'export const w = window.location.origin;\n');
  assert.deepStrictEqual(svc.verifyModuleLoads(p), { ok: true, fatal: false, message: '' });
});
