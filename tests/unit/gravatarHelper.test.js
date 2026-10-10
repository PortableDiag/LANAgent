import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as gravatarHelper from '../../src/utils/gravatarHelper.js';
const {
  processBulkGravatarUrls,
  batchEnrichContacts,
  checkAvatarExists,
  hasGravatarAvatar,
} = gravatarHelper;

test('processBulkGravatarUrls generates Gravatar URLs (md5 of the lowercased, trimmed email)', async () => {
  const emails = ['alice@example.com', 'bob@example.com', ' CHARLIE@EXAMPLE.COM '];
  const urls = await processBulkGravatarUrls(emails, { size: 150, defaultImage: 'identicon', rating: 'PG' });
  assert.deepStrictEqual(urls, [
    'https://www.gravatar.com/avatar/c160f8cc69a4f0bf2b0362752353d060?s=150&d=identicon&r=PG',
    'https://www.gravatar.com/avatar/4b9bb80620f03eb3719e0a061c14283d?s=150&d=identicon&r=PG',
    'https://www.gravatar.com/avatar/426b189df1e2f359efe6ee90f2d2030f?s=150&d=identicon&r=PG'
  ]);
});

test('batchEnrichContacts preserves length and order across chunks and passes through contacts without an email', async () => {
  // 23 contacts with no email exercise three chunks (10/10/3) without any network call
  const contacts = Array.from({ length: 23 }, (_, i) => ({ id: i, name: `c${i}` }));
  const out = await batchEnrichContacts(contacts);
  assert.strictEqual(out.length, 23);
  assert.deepStrictEqual(out.map(c => c.id), contacts.map(c => c.id));
  assert.strictEqual(out[7], contacts[7]);
});

test('batchEnrichContacts returns non-array and empty input unchanged', async () => {
  assert.deepStrictEqual(await batchEnrichContacts([]), []);
  assert.strictEqual(await batchEnrichContacts(null), null);
});

test('checkAvatarExists returns true when Gravatar returns 200', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    // Verify the HEAD request parameters
    assert.ok(url.includes('d=404'));
    assert.ok(url.includes('s=1'));
    assert.strictEqual(options?.method, 'HEAD');
    return { status: 200, ok: true };
  };
  try {
    const exists = await checkAvatarExists('test@example.com');
    assert.strictEqual(exists, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('checkAvatarExists returns false when Gravatar returns 404', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return { status: 404, ok: false };
  };
  try {
    const exists = await checkAvatarExists('nonexistent@example.com');
    assert.strictEqual(exists, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('checkAvatarExists throws (and does not cache) on unexpected status codes', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 429, ok: false });
  try {
    await assert.rejects(() => checkAvatarExists('error@example.com'), /Unexpected status 429/);
    // a later real answer must not be shadowed by a cached "false"
    globalThis.fetch = async () => ({ status: 200, ok: true });
    assert.strictEqual(await checkAvatarExists('error@example.com'), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('checkAvatarExists throws when the HEAD request fails', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network down');
  };
  try {
    await assert.rejects(
      () => checkAvatarExists('throw@example.com'),
      /Network down/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('checkAvatarExists returns false when email is missing', async () => {
  assert.strictEqual(await checkAvatarExists(''), false);
  assert.strictEqual(await checkAvatarExists(null), false);
  assert.strictEqual(await checkAvatarExists(undefined), false);
});

test('hasGravatarAvatar returns true when lightweight HEAD finds an avatar', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true });
  try {
    const has = await hasGravatarAvatar('exists@example.com');
    assert.strictEqual(has, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('hasGravatarAvatar returns false when lightweight HEAD returns 404', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, ok: false });
  try {
    const has = await hasGravatarAvatar('noavatar@example.com');
    assert.strictEqual(has, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('hasGravatarAvatar falls back to full profile fetch when HEAD request fails', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'HEAD') {
      throw new Error('HEAD failed');
    }
    // Return a successful profile with an avatar_url
    return {
      ok: true,
      status: 200,
      json: async () => ({ avatar_url: 'https://www.gravatar.com/avatar/someavatar.png' })
    };
  };
  try {
    const has = await hasGravatarAvatar('fallback@example.com');
    assert.strictEqual(has, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('hasGravatarAvatar returns false when both HEAD and full profile fail', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('HEAD failed');
  };
  try {
    const has = await hasGravatarAvatar('noprofile@example.com');
    assert.strictEqual(has, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('enrichContactWithGravatar still fetches the profile for a default-avatar account (no HEAD gate)', async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(options?.method || 'GET');
    return { ok: true, status: 200, json: async () => ({ display_name: 'Dee Fault' }) };
  };
  try {
    const contact = await gravatarHelper.enrichContactWithGravatar({ email: 'defaultavatar@example.com' });
    assert.strictEqual(contact.gravatar?.displayName, 'Dee Fault');
    assert.ok(!calls.includes('HEAD'), 'enrichment makes no extra HEAD request');
  } finally {
    globalThis.fetch = origFetch;
  }
});
