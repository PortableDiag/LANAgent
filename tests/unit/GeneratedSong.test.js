import test from 'node:test';
import assert from 'node:assert/strict';
import { GeneratedSong } from '../../src/models/GeneratedSong.js';

test('generateWithRetry should attempt fallback providers on failure', async (t) => {
  const mockFn = (provider) => {
    if (provider === 'suno') throw new Error('Suno failed');
    if (provider === 'mubert') throw new Error('Mubert failed');
    return { success: true, provider };
  };

  const originalHealth = GeneratedSong.getProviderHealth;
  const originalUpdate = GeneratedSong.updateProviderHealth;
  const originalReset = GeneratedSong.resetProviderHealth;
  const originalHealthy = GeneratedSong.getHealthyProviders;

  GeneratedSong.getHealthyProviders = () => ['suno', 'mubert', 'soundverse'];
  GeneratedSong.updateProviderHealth = () => {};
  GeneratedSong.resetProviderHealth = () => {};

  try {
    const result = await GeneratedSong.generateWithRetry(mockFn, { provider: 'suno', retries: 1 });
    assert.equal(result.success, true);
    assert.equal(result.provider, 'soundverse');
  } finally {
    GeneratedSong.getProviderHealth = originalHealth;
    GeneratedSong.updateProviderHealth = originalUpdate;
    GeneratedSong.resetProviderHealth = originalReset;
    GeneratedSong.getHealthyProviders = originalHealthy;
  }
});
