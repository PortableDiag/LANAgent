import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrice } from '../../src/services/webtools/priceExtractor.js';

const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const variants = `<html><head><title>Shirt</title>${ld({
  '@type': 'Product', name: 'Shirt',
  offers: [
    { '@type': 'Offer', name: 'Small', sku: 'S1', price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    { '@type': 'Offer', name: 'Large', sku: 'L1', price: '24.99', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
    { '@type': 'Offer', name: 'Large', sku: 'L1', price: '24.99', priceCurrency: 'USD' }
  ]
})}</head><body><main>Free shipping over $50. Save $5 today.</main></body></html>`;

test('single mode is unchanged: the first JSON-LD offer', () => {
  const r = extractPrice(variants);
  assert.equal(r.price, 19.99);
  assert.equal(r.source, 'jsonld');
  assert.equal(r.title, 'Shirt');
});

test('allOffers returns each distinct JSON-LD offer with its variant name, and no page-text amounts', () => {
  const offers = extractPrice(variants, { allOffers: true });
  assert.deepEqual(offers.map(o => [o.name, o.sku, o.price, o.availability]), [
    ['Small', 'S1', 19.99, 'InStock'],
    ['Large', 'L1', 24.99, 'OutOfStock']
  ]);
  assert.ok(offers.every(o => o.source === 'jsonld'));
});

test('allOffers without JSON-LD falls back to the single best reading, or []', () => {
  const meta = '<html><head><meta property="product:price:amount" content="12.50"><meta property="product:price:currency" content="EUR"></head><body>$3 off</body></html>';
  const offers = extractPrice(meta, { allOffers: true });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].source, 'meta');
  assert.deepEqual(extractPrice('<html><body>nothing here</body></html>', { allOffers: true }), []);
});
