import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TechnicalIndicators } from '../../src/services/crypto/indicators/TechnicalIndicators.js';

describe('TechnicalIndicators - detectMACrossover', () => {
  const indicators = new TechnicalIndicators();

  describe('detectMACrossover', () => {
    it('should return bullish when short MA crosses above long MA', () => {
      // short=3, long=5, last price spike causes crossover
      const prices = [10, 10, 10, 10, 10, 10, 10, 10, 10, 20];
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'bullish');
    });

    it('should return bearish when short MA crosses below long MA', () => {
      const prices = [10, 10, 10, 10, 10, 10, 10, 10, 10, 5];
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'bearish');
    });

    it('should return neutral when no crossover occurs', () => {
      const prices = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'neutral');
    });

    it('should return neutral when insufficient data', () => {
      const prices = [10, 10, 10, 10, 10]; // length 5, need longPeriod+1 = 6
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'neutral');
    });

    it('should return neutral when short MA was already above long MA (no fresh cross)', () => {
      // steady uptrend: short > long on both the previous and current bar
      const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'neutral');
    });

    it('should return neutral when short MA was already below long MA (no fresh cross)', () => {
      const prices = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      const result = indicators.detectMACrossover(prices, 3, 5);
      assert.equal(result, 'neutral');
    });
  });

  describe('registered indicators', () => {
    it('ma_crossover_20_50 should return bullish on crossover', async () => {
      const ctx = {
        network: 'ethereum',
        marketData: {
          priceHistory: {
            ethereum: Array(51).fill(10) // 51 prices, longPeriod=50 needs 51
          }
        }
      };
      // Create a bullish crossover: last price jumps
      ctx.marketData.priceHistory.ethereum[50] = 20;
      const fn = indicators.getIndicators().get('ma_crossover_20_50');
      const result = await fn(ctx);
      assert.equal(result, 'bullish');
    });

    it('ma_crossover_50_200 should return neutral with insufficient data', async () => {
      const ctx = {
        network: 'ethereum',
        marketData: {
          priceHistory: {
            ethereum: Array(100).fill(10) // less than 201 needed
          }
        }
      };
      const fn = indicators.getIndicators().get('ma_crossover_50_200');
      const result = await fn(ctx);
      assert.equal(result, 'neutral');
    });
  });
});
