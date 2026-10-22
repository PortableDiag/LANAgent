/**
 * A PDF on the plain-HTTP tier is read as a PDF (2026-10-22). It used to be decoded
 * as text and parsed as HTML; the binary nested deep enough that cheerio's .text()
 * threw "Maximum call stack size exceeded" on every PDF a paid caller sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import ScraperPlugin from '../../src/api/plugins/scraper.js';

// A hand-built PDF with a correct xref table. pdf-lib output is not used: the
// pdf.js bundled in pdf-parse rejects it, while real-world PDFs parse fine.
function makePdf(title) {
  const text = 'Quarterly budget overview for the test fixture';
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${title || ''}) >>`
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function serve(body, type) {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', type); res.end(body); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('a PDF returns its text, its title and no HTML', async () => {
  const { server, base } = await serve(makePdf('Budget Report'), 'application/pdf');
  try {
    const r = await new ScraperPlugin({}).scrapeWithCheerio(`${base}/docs/report.pdf`, { bypassCache: true });
    assert.equal(r.success, true);
    assert.equal(r.contentType, 'application/pdf');
    assert.equal(r.content.title, 'Budget Report');
    assert.match(r.content.text, /Quarterly budget overview/);
    assert.equal(r.content.pages, 1);
    assert.equal(r._rawHtml, undefined);
  } finally {
    server.close();
  }
});

test('a PDF served with the wrong content type is still detected, and an untitled one is named after its file', async () => {
  const { server, base } = await serve(makePdf(), 'application/octet-stream');
  try {
    const r = await new ScraperPlugin({}).scrapeWithCheerio(`${base}/files/200330a.pdf`, { bypassCache: true });
    assert.equal(r.contentType, 'application/pdf');
    assert.equal(r.content.title, '200330a.pdf', 'an empty title would send the paid route to Puppeteer');
  } finally {
    server.close();
  }
});

test('HTML is still decoded as UTF-8 text', async () => {
  const { server, base } = await serve('<html><head><title>Café</title></head><body><main>Grüße aus München</main></body></html>', 'text/html');
  try {
    const r = await new ScraperPlugin({}).scrapeWithCheerio(`${base}/`, { bypassCache: true });
    assert.equal(r.contentType, undefined);
    assert.equal(r.content.title, 'Café');
    assert.match(r.content.text, /Grüße aus München/);
    assert.equal(typeof r._rawHtml, 'string');
  } finally {
    server.close();
  }
});
