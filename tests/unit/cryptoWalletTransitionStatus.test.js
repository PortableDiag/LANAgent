import test from 'node:test';
import assert from 'node:assert/strict';
import CryptoWallet from '../../src/models/CryptoWallet.js';
import { logger } from '../../src/utils/logger.js';

function stubFOAU(impl) {
    const original = CryptoWallet.findOneAndUpdate;
    const calls = [];
    CryptoWallet.findOneAndUpdate = async (filter, update, options) => {
        calls.push({ filter, update, options });
        return impl(filter, update, options);
    };
    const origErr = logger.error;
    const origInfo = logger.info;
    logger.error = () => {};
    logger.info = () => {};
    return {
        calls,
        restore() {
            CryptoWallet.findOneAndUpdate = original;
            logger.error = origErr;
            logger.info = origInfo;
        }
    };
}

test('transitionMap is exposed on the model', () => {
    assert.deepEqual(CryptoWallet.transitionMap.pending, ['confirmed', 'failed']);
});

test('transitionStatus matches hash and status on the same element', async () => {
    const s = stubFOAU(() => ({ transactions: [{ hash: '0xabc', status: 'confirmed' }] }));
    try {
        const tx = await CryptoWallet.transitionStatus('w1', '0xabc', 'confirmed');
        assert.equal(tx.status, 'confirmed');
        const { filter, update } = s.calls[0];
        assert.equal(filter._id, 'w1');
        assert.deepEqual(filter.transactions, {
            $elemMatch: { hash: '0xabc', status: { $in: ['pending'] } }
        });
        assert.equal(filter['transactions.hash'], undefined);
        assert.deepEqual(update, { $set: { 'transactions.$.status': 'confirmed' } });
    } finally {
        s.restore();
    }
});

test('transitionStatus rejects unknown status without touching the DB', async () => {
    const s = stubFOAU(() => null);
    try {
        await assert.rejects(() => CryptoWallet.transitionStatus('w1', '0xabc', 'bogus'), /Invalid status/);
        assert.equal(s.calls.length, 0);
    } finally {
        s.restore();
    }
});

test('transitionStatus refuses a target no state can reach (pending)', async () => {
    const s = stubFOAU(() => null);
    try {
        await assert.rejects(() => CryptoWallet.transitionStatus('w1', '0xabc', 'pending'), /No transitions allowed/);
        assert.equal(s.calls.length, 0);
    } finally {
        s.restore();
    }
});

test('transitionStatus throws when no element is in an allowed state', async () => {
    const s = stubFOAU(() => null);
    try {
        await assert.rejects(() => CryptoWallet.transitionStatus('w1', '0xabc', 'failed'), /not found or invalid transition/);
    } finally {
        s.restore();
    }
});
