import { test } from 'node:test';
import assert from 'node:assert/strict';
import SelfModificationService from '../../src/services/selfModification.js';

// The service's constructor wires git/AI clients; these two methods are pure, so
// bind them to a bare prototype instance rather than standing up the whole service.
const selfModification = Object.create(SelfModificationService.prototype);

// The exact description from PR #2326, which advertised an endpoint under a
// router prefix that does not exist in the project and shipped only a model
// static. This is the case the check exists to catch.
const PR_2326 = {
  description: 'Add signal correlation analysis API for identifying related arbitrage opportunities',
  implementation: "Create a new GET /api/arbitrage/signals/correlations endpoint that accepts symbol, "
    + "network, and timeWindow parameters. Implement a static method 'findCorrelatedSignals' that "
    + 'analyzes price movements and identifies signals that frequently occur together. '
    + 'Return correlation coefficients and co-occurrence statistics.'
};

const MODEL_ORIGINAL = `
import mongoose from 'mongoose';
const s = new mongoose.Schema({ symbol: String });
s.statics.getRecentSignals = function () { return this.find({}); };
export default mongoose.model('ArbSignal', s);
`;

const MODEL_WITH_STATIC_ONLY = MODEL_ORIGINAL.replace(
  's.statics.getRecentSignals',
  "s.statics.findCorrelatedSignals = function () { return this.aggregate([]); };\ns.statics.getRecentSignals"
);

test('flags an advertised endpoint when no route is registered', () => {
  const warnings = selfModification.checkAdvertisedEndpoints(
    PR_2326, MODEL_ORIGINAL, MODEL_WITH_STATIC_ONLY
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^UNWIRED_ENDPOINT:/);
  assert.match(warnings[0], /GET \/api\/arbitrage\/signals\/correlations/);
});

test('stays quiet when the change actually registers a route', () => {
  const routerOriginal = "router.get('/api/skynet/arb-signals', h);\n";
  const routerModified = routerOriginal + "router.get('/api/skynet/arb-signals/correlations', h2);\n";
  const warnings = selfModification.checkAdvertisedEndpoints(
    PR_2326, routerOriginal, routerModified
  );
  assert.deepEqual(warnings, []);
});

test('stays quiet when the description advertises no endpoint', () => {
  const improvement = {
    description: 'Add a helper that formats spread percentages',
    implementation: 'Implement formatSpread(value) returning a fixed-precision string.'
  };
  assert.deepEqual(
    selfModification.checkAdvertisedEndpoints(improvement, MODEL_ORIGINAL, MODEL_WITH_STATIC_ONLY),
    []
  );
});

test('stays quiet when the endpoint already exists in the file being edited', () => {
  const improvement = {
    description: 'Harden validation on GET /api/skynet/arb-signals',
    implementation: 'Reject non-numeric limit values.'
  };
  const original = "router.get('/api/skynet/arb-signals', (req, res) => res.json({}));\n";
  const modified = "router.get('/api/skynet/arb-signals', (req, res) => { if (!ok) return res.status(400); });\n";
  assert.deepEqual(selfModification.checkAdvertisedEndpoints(improvement, original, modified), []);
});

test('handles a missing improvement object without throwing', () => {
  assert.deepEqual(selfModification.checkAdvertisedEndpoints(null, 'a', 'b'), []);
  assert.deepEqual(selfModification.checkAdvertisedEndpoints({}, 'a', 'b'), []);
});

test('validateGeneratedCode surfaces the flag as a non-blocking warning', () => {
  const result = selfModification.validateGeneratedCode(
    MODEL_ORIGINAL, MODEL_WITH_STATIC_ONLY, 'src/models/ArbSignal.js', PR_2326
  );
  assert.ok(result.warnings.some(w => w.startsWith('UNWIRED_ENDPOINT:')),
    'expected an UNWIRED_ENDPOINT warning');
  assert.ok(!result.errors.some(e => e.startsWith('UNWIRED_ENDPOINT:')),
    'must not block the PR — the capability itself is still worth reviewing');
});

test('validateGeneratedCode still works without an improvement argument', () => {
  const result = selfModification.validateGeneratedCode(
    MODEL_ORIGINAL, MODEL_WITH_STATIC_ONLY, 'src/models/ArbSignal.js'
  );
  assert.ok(Array.isArray(result.warnings) && Array.isArray(result.errors));
});
