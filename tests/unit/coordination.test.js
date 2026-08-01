import { test } from 'node:test';
import assert from 'node:assert/strict';
import agentCoordinationService from '../../src/services/crypto/agentCoordinationService.js';
import AgentCoordination from '../../src/models/AgentCoordination.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function stubFind(docs) {
    const orig = AgentCoordination.find;
    AgentCoordination.find = () => ({ lean: async () => docs });
    return () => { AgentCoordination.find = orig; };
}

test('calculateParticipantReputation computes rates from recorded history', async (t) => {
    const base = new Date('2026-01-01T00:00:00Z');
    const restore = stubFind([
        {
            proposer: OTHER,
            status: 'Executed',
            createdAt: base,
            participants: [
                { address: ADDR, accepted: true, acceptedAt: new Date(base.getTime() + 60000) },
                { address: OTHER, accepted: true }
            ]
        },
        {
            proposer: OTHER,
            status: 'Executed',
            createdAt: base,
            participants: [
                // mixed-case address exercises case-insensitive matching
                { address: ADDR.toUpperCase().replace('0X', '0x'), accepted: true, acceptedAt: new Date(base.getTime() + 180000), executionResult: { status: 'failed' } }
            ]
        },
        {
            proposer: ADDR,
            status: 'Expired',
            createdAt: base,
            participants: [{ address: ADDR, accepted: false }]
        },
        {
            proposer: OTHER,
            status: 'Proposed',
            createdAt: base,
            participants: [{ address: ADDR, accepted: true, acceptedAt: new Date(base.getTime() + 60000) }]
        }
    ]);
    t.after(restore);

    const rep = await agentCoordinationService.calculateParticipantReputation(ADDR);

    assert.equal(rep.participant, ADDR);
    assert.equal(rep.sampleSize.invited, 4);
    assert.equal(rep.sampleSize.accepted, 3);
    assert.equal(rep.sampleSize.completed, 1);
    assert.equal(rep.sampleSize.executionFailed, 1);
    assert.equal(rep.sampleSize.expiredUnaccepted, 1);
    assert.equal(rep.sampleSize.proposedByThem, 1);
    assert.equal(rep.acceptanceRate, 0.75);
    // 2 settled (1 completed, 1 failed) — the pending Proposed doc is excluded
    assert.equal(rep.completionRate, 0.5);
    assert.equal(rep.avgAcceptLatencyMs, 100000);
    assert.equal(rep.score, Math.round(100 * (0.5 * 0.75 + 0.5 * 0.5)));
});

test('calculateParticipantReputation returns null rates with no history', async (t) => {
    const restore = stubFind([]);
    t.after(restore);

    const rep = await agentCoordinationService.calculateParticipantReputation(ADDR);
    assert.equal(rep.acceptanceRate, null);
    assert.equal(rep.completionRate, null);
    assert.equal(rep.avgAcceptLatencyMs, null);
    assert.equal(rep.score, null);
    assert.equal(rep.sampleSize.invited, 0);
});

test('calculateParticipantReputation rejects invalid addresses with statusCode 400', async () => {
    await assert.rejects(
        () => agentCoordinationService.calculateParticipantReputation('not-an-address'),
        (err) => err.statusCode === 400 && /Invalid participant address/.test(err.message)
    );
    await assert.rejects(
        () => agentCoordinationService.calculateParticipantReputation(''),
        (err) => err.statusCode === 400
    );
});
