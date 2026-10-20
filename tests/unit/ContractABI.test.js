/**
 * Contract security-audit storage.
 *
 * The schema half is exercised against the real mongoose schema (no connection
 * needed — validate() is local), because the bug worth pinning is a vocabulary
 * mismatch: the contractAudit plugin emits an 'info' severity that the original
 * enum rejected, so persisting a real audit would have thrown on save.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractABI } from '../../src/models/ContractABI.js';

const SEVERITIES_THE_AUDITOR_EMITS = ['critical', 'high', 'medium', 'low', 'info'];

test('accepts every severity the contract auditor actually produces', () => {
  for (const severity of SEVERITIES_THE_AUDITOR_EMITS) {
    const doc = new ContractABI({
      address: '0xabc', network: 'bsc',
      securityAudit: {
        auditStatus: 'passed',
        vulnerabilities: [{ id: 'v1', severity, title: 't', description: 'd' }]
      }
    });
    const err = doc.validateSync();
    const vulnErr = err?.errors && Object.keys(err.errors).find(k => k.includes('severity'));
    assert.equal(vulnErr, undefined, `severity '${severity}' must be accepted`);
  }
});

test('still rejects a severity outside the vocabulary', () => {
  const doc = new ContractABI({
    address: '0xabc', network: 'bsc',
    securityAudit: { vulnerabilities: [{ id: 'v1', severity: 'catastrophic' }] }
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(Object.keys(err.errors).some(k => k.includes('severity')));
});

test('audit status vocabulary is enforced', () => {
  const ok = new ContractABI({ address: '0xa', network: 'bsc', securityAudit: { auditStatus: 'in_progress' } });
  assert.equal(ok.validateSync()?.errors?.['securityAudit.auditStatus'], undefined);

  const bad = new ContractABI({ address: '0xa', network: 'bsc', securityAudit: { auditStatus: 'maybe' } });
  assert.ok(bad.validateSync()?.errors?.['securityAudit.auditStatus'], 'expected auditStatus to be rejected');
});

test('a partial update does not erase the previous scan findings', async () => {
  // The bug this guards: setting every key unconditionally wrote `undefined`
  // over vulnerabilities when a caller only meant to move the status forward.
  let captured = null;
  const orig = ContractABI.findOneAndUpdate;
  ContractABI.findOneAndUpdate = (filter, update) => {
    captured = update;
    return Promise.resolve({ address: '0xa', network: 'bsc' });
  };
  try {
    await ContractABI.updateSecurityAudit('0xa', 'bsc', { auditStatus: 'in_progress' });
    assert.ok(captured, 'expected an update');
    assert.equal(captured.$set['securityAudit.auditStatus'], 'in_progress');
    assert.ok(
      !('securityAudit.vulnerabilities' in captured.$set),
      'vulnerabilities must be left alone when not supplied'
    );
    assert.ok(captured.$set['securityAudit.lastScanDate'] instanceof Date);
  } finally {
    ContractABI.findOneAndUpdate = orig;
  }
});

test('supplied vulnerabilities are written through', async () => {
  let captured = null;
  const orig = ContractABI.findOneAndUpdate;
  ContractABI.findOneAndUpdate = (filter, update) => {
    captured = update;
    return Promise.resolve({ address: '0xa', network: 'bsc' });
  };
  try {
    const vulns = [{ id: 'v1', severity: 'info', title: 't' }];
    await ContractABI.updateSecurityAudit('0xa', 'bsc', { auditStatus: 'passed', vulnerabilities: vulns });
    assert.deepEqual(captured.$set['securityAudit.vulnerabilities'], vulns);
  } finally {
    ContractABI.findOneAndUpdate = orig;
  }
});

test('compareABIs: removing a function is breaking, adding one is not', () => {
  const withdraw = {
    type: 'function', name: 'withdraw',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable'
  };
  const removed = ContractABI.compareABIs([withdraw], []);
  assert.equal(removed.compatible, false);
  assert.equal(removed.removedFunctions[0].name, 'withdraw');
  assert.match(JSON.stringify(removed.breakingChanges), /withdraw/);

  const added = ContractABI.compareABIs([], [withdraw]);
  assert.equal(added.compatible, true);
  assert.equal(added.addedFunctions.length, 1);
});

test('compareABIs: tuple vs tuple[] parameters are different signatures', () => {
  const fn = (type) => ({
    type: 'function', name: 'f', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'x', type, components: [{ name: 'a', type: 'uint256' }, { name: 'b', type: 'address' }] }]
  });
  const r = ContractABI.compareABIs([fn('tuple')], [fn('tuple[]')]);
  assert.equal(r.compatible, false);
  assert.equal(r.removedFunctions[0].inputTypes[0], '(uint256,address)');
  assert.equal(r.addedFunctions[0].inputTypes[0], '(uint256,address)[]');
});

test('compareABIs: mutability changes are breaking only when existing callers break', () => {
  const fn = (m) => ({ type: 'function', name: 'g', inputs: [], outputs: [], stateMutability: m });
  const breaking = (a, b) => !ContractABI.compareABIs([fn(a)], [fn(b)]).compatible;
  assert.equal(breaking('payable', 'nonpayable'), true);    // value-sending callers revert
  assert.equal(breaking('view', 'nonpayable'), true);       // static callers break
  assert.equal(breaking('nonpayable', 'payable'), false);
  assert.equal(breaking('view', 'pure'), false);
  assert.equal(breaking('nonpayable', 'view'), false);
});

test('compareStoredABIs validates input before querying', async () => {
  await assert.rejects(() => ContractABI.compareStoredABIs('0xnothex', 'bsc', []), TypeError);
  await assert.rejects(() => ContractABI.compareStoredABIs('0x' + '1'.repeat(40), 'solana', []), TypeError);
});

// --- findBySignature tests ---
// Fixtures are RAW ABI arrays, the shape abiManager.saveABI stores.

const ERC20_RAW = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Transfer', anonymous: false,
    inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256' }] }
];

function stubFind(docs, capture = {}) {
  const orig = ContractABI.find;
  ContractABI.find = async (query) => { capture.query = query; return docs; };
  return () => { ContractABI.find = orig; };
}

test('findBySignature: rejects invalid signature object', async () => {
  await assert.rejects(() => ContractABI.findBySignature(null), TypeError);
  await assert.rejects(() => ContractABI.findBySignature({}), TypeError);
  await assert.rejects(() => ContractABI.findBySignature({ type: 'function' }), TypeError);
  await assert.rejects(() => ContractABI.findBySignature({ type: 'function', name: 'transfer' }), TypeError);
  await assert.rejects(() => ContractABI.findBySignature({ type: 'function', name: 'transfer', inputTypes: 'notarray' }), TypeError);
});

test('findBySignature: rejects invalid network', async () => {
  const sig = { type: 'function', name: 'transfer', inputTypes: ['address', 'uint256'] };
  await assert.rejects(() => ContractABI.findBySignature(sig, 'solana'), TypeError);
  await assert.rejects(() => ContractABI.findBySignature(sig, 123), TypeError);
});

test('findBySignature: matches a stored raw ABI and narrows by name, arity and network', async () => {
  const capture = {};
  const restore = stubFind([{ address: '0x1', network: 'polygon', abi: ERC20_RAW }], capture);
  try {
    const sig = { type: 'event', name: 'Transfer', inputTypes: ['address', 'address', 'uint256'] };
    const result = await ContractABI.findBySignature(sig, 'polygon');
    assert.deepEqual(capture.query, {
      abi: { $elemMatch: { name: 'Transfer', inputs: { $size: 3 } } },
      network: 'polygon'
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].address, '0x1');
  } finally { restore(); }
});

test('findBySignature: drops candidates whose types, order or entry type differ', async () => {
  const swapped = [{ type: 'function', name: 'transfer', inputs: [{ type: 'uint256' }, { type: 'address' }] }];
  const restore = stubFind([
    { address: '0xa', network: 'bsc', abi: ERC20_RAW },
    { address: '0xb', network: 'bsc', abi: swapped }
  ]);
  try {
    const fn = await ContractABI.findBySignature({ type: 'function', name: 'transfer', inputTypes: ['address', 'uint256'] });
    assert.deepEqual(fn.map(d => d.address), ['0xa']);
    const wrongType = await ContractABI.findBySignature({ type: 'event', name: 'transfer', inputTypes: ['address', 'uint256'] });
    assert.deepEqual(wrongType, []);
  } finally { restore(); }
});

test('findBySignature: tuple inputs match their expanded signature', async () => {
  const raw = [{ type: 'function', name: 'submit', inputs: [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }] }] }];
  const restore = stubFind([{ address: '0xc', network: 'base', abi: raw }]);
  try {
    const r = await ContractABI.findBySignature({ type: 'function', name: 'submit', inputTypes: ['(address,uint256)[]'] });
    assert.equal(r.length, 1);
  } finally { restore(); }
});
