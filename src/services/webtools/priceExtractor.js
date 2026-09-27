import * as cheerio from 'cheerio';

/**
 * Read the price of a product page. Sources in order of trust:
 *   1. JSON-LD Product/Offer (what shops publish for search engines),
 *   2. price meta tags (og:price:amount, product:price:amount, itemprop=price),
 *   3. microdata [itemprop=price],
 *   4. a caller-supplied CSS selector,
 *   5. the first currency-marked amount in the page's main text (flagged low confidence).
 * Returns null when nothing credible is found — never a guess dressed as a reading.
 */

const SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', 'C$': 'CAD', 'A$': 'AUD' };

/** "1.299,00" / "1,299.00" / "$ 1299" → 1299 */
export function parseAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) {
    // comma is the decimal separator only when 1-2 digits follow it
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function offersOf(node) {
  const out = [];
  const visit = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const type = [].concat(n['@type'] || []).join(',');
    if (/Offer/i.test(type) && (n.price != null || n.lowPrice != null)) out.push(n);
    if (n.priceSpecification) visit(n.priceSpecification);
    for (const k of ['offers', '@graph', 'mainEntity', 'itemOffered']) if (n[k]) visit(n[k]);
    if (/PriceSpecification/i.test(type) && n.price != null) out.push(n);
  };
  visit(node);
  return out;
}

function productName(nodes) {
  for (const n of [].concat(nodes)) {
    const list = n?.['@graph'] ? n['@graph'] : [n];
    for (const x of list) if (/Product/i.test([].concat(x?.['@type'] || []).join(',')) && x.name) return String(x.name);
  }
  return null;
}

export function extractPrice(html, { selector } = {}) {
  const $ = cheerio.load(String(html || ''));
  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || '').trim().slice(0, 200);

  // 1. JSON-LD
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { blocks.push(JSON.parse($(el).contents().text())); } catch { /* malformed block */ }
  });
  for (const offer of blocks.flatMap(offersOf)) {
    const price = parseAmount(offer.price ?? offer.lowPrice);
    if (price) {
      return {
        price, currency: offer.priceCurrency || null, source: 'jsonld', confidence: 'high',
        title: productName(blocks) || title,
        availability: offer.availability ? String(offer.availability).split('/').pop() : null
      };
    }
  }

  // 2/3. meta and microdata
  const metaPrice = $('meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]').attr('content');
  const metaCurrency = $('meta[property="product:price:currency"], meta[property="og:price:currency"], meta[itemprop="priceCurrency"]').attr('content');
  const md = $('[itemprop="price"]').first();
  const mdPrice = md.attr('content') || md.text();
  for (const [raw, source] of [[metaPrice, 'meta'], [mdPrice, 'microdata']]) {
    const price = parseAmount(raw);
    if (price) return { price, currency: metaCurrency || $('[itemprop="priceCurrency"]').attr('content') || null, source, confidence: 'high', title };
  }

  // 4. selector the operator pointed at
  if (selector) {
    const raw = $(selector).first().text();
    const price = parseAmount(raw);
    if (price) return { price, currency: currencyIn(raw), source: 'selector', confidence: 'medium', title };
  }

  // 5. text pattern, low confidence
  $('script, style, noscript, nav, footer, header').remove();
  const body = $('main').text() || $('body').text();
  const m = body.match(/(C\$|A\$|[$€£¥₹₩])\s?(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  if (m) {
    const price = parseAmount(m[2]);
    if (price) return { price, currency: SYMBOLS[m[1]] || null, source: 'text', confidence: 'low', title };
  }
  return null;
}

function currencyIn(s) {
  const m = String(s).match(/C\$|A\$|[$€£¥₹₩]|\b(USD|EUR|GBP|JPY|CAD|AUD|INR)\b/);
  return m ? (SYMBOLS[m[0]] || m[1] || null) : null;
}
