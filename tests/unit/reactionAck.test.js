import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ReactionAck, REACTION_WORKING, REACTION_DONE } from '../../src/interfaces/telegram/reactionAck.js';
import { logger } from '../../src/utils/logger.js';

describe('ReactionAck.forMessage', () => {
  let originalDebug;

  before(() => {
    originalDebug = logger.debug;
    logger.debug = () => {};
  });

  after(() => {
    logger.debug = originalDebug;
  });

  it('should react to a specific message by chatId and messageId', async () => {
    const calls = [];
    const telegram = {
      setMessageReaction: (chatId, messageId, reactions) => {
        calls.push({ chatId, messageId, reactions });
        return Promise.resolve();
      }
    };
    const ack = ReactionAck.forMessage(telegram, 123, 456);
    assert.ok(ack instanceof ReactionAck);
    await ack.flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { chatId: 123, messageId: 456, reactions: [{ type: 'emoji', emoji: REACTION_WORKING }] });
    assert.deepEqual(ack.emojis, [REACTION_WORKING]);
    assert.equal(ack.settled, false);
  });

  it('should chain ok reaction after working', async () => {
    const calls = [];
    const telegram = {
      setMessageReaction: (chatId, messageId, reactions) => {
        calls.push({ chatId, messageId, reactions });
        return Promise.resolve();
      }
    };
    const ack = ReactionAck.forMessage(telegram, 123, 456);
    ack.ok();
    await ack.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].reactions, [{ type: 'emoji', emoji: REACTION_WORKING }]);
    assert.deepEqual(calls[1].reactions, [{ type: 'emoji', emoji: REACTION_DONE }]);
    assert.deepEqual(ack.emojis, [REACTION_WORKING, REACTION_DONE]);
    assert.equal(ack.settled, true);
  });

  it('should handle reaction failures gracefully', async () => {
    const calls = [];
    const telegram = {
      setMessageReaction: (chatId, messageId, reactions) => {
        calls.push({ chatId, messageId, reactions });
        if (reactions[0].emoji === REACTION_WORKING) {
          return Promise.reject(new Error('rate limit'));
        }
        return Promise.resolve();
      }
    };
    const ack = ReactionAck.forMessage(telegram, 123, 456);
    ack.ok();
    const outcome = await ack.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(outcome.attemptedEmojis, [REACTION_WORKING, REACTION_DONE]);
    assert.deepEqual(outcome.emojis, [REACTION_DONE]);
    assert.deepEqual(outcome.failedPhases, ['working']);
    assert.equal(outcome.settled, true);
  });

  it('should only settle once', async () => {
    const calls = [];
    const telegram = {
      setMessageReaction: (chatId, messageId, reactions) => {
        calls.push({ chatId, messageId, reactions });
        return Promise.resolve();
      }
    };
    const ack = ReactionAck.forMessage(telegram, 123, 456);
    ack.ok();
    ack.fail();
    await ack.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(ack.emojis, [REACTION_WORKING, REACTION_DONE]);
  });
});
