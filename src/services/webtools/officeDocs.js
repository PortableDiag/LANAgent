import { promises as fs } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, LevelFormat
} from 'docx';
import { TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, DEPLOY_PATH } from '../../utils/paths.js';

/**
 * Word, Excel and PowerPoint files: create from simple input (markdown text, rows, slide
 * lists), read back as text, and edit (find/replace text in .docx/.pptx, set cells in .xlsx).
 * New files go to <workspace>/documents; files are only read from the agent's own work areas.
 */

export const OUTPUT_DIR = path.join(WORKSPACE_PATH, 'documents');
const READ_ROOTS = [TEMP_PATH, UPLOADS_PATH, WORKSPACE_PATH, path.join(DEPLOY_PATH, 'downloads')];
const MAX_BYTES = 40 * 1024 * 1024;

export function safeFilename(name, ext) {
  const base = String(name || 'document').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w .()-]+/g, '').replace(/^[.\s]+/, '').replace(/\s+/g, '_').slice(0, 80) || 'document';
  return `${base}.${ext}`;
}

async function uniquePath(file) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const ext = path.extname(file), stem = path.basename(file, ext);
  for (let i = 0; i < 1000; i++) {
    const p = path.join(OUTPUT_DIR, i ? `${stem}-${i + 1}${ext}` : `${stem}${ext}`);
    try { await fs.access(p); } catch { return p; }
  }
  throw new Error('too many files with that name');
}

/** Resolve a path the caller gave to a real file inside the agent's work areas. */
export async function resolveInput(p) {
  if (!p) throw new Error('a file path is required');
  const candidate = path.isAbsolute(p) ? p : path.join(OUTPUT_DIR, p);
  const real = await fs.realpath(candidate).catch(() => null);
  if (!real) throw new Error(`${p} was not found`);
  const roots = await Promise.all(READ_ROOTS.map(r => fs.realpath(r).catch(() => null)));
  if (!roots.some(r => r && (real === r || real.startsWith(r + path.sep)))) {
    throw new Error(`For safety only files under ${READ_ROOTS.join(', ')} can be opened.`);
  }
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`${p} is not a file`);
  if (st.size > MAX_BYTES) throw new Error(`${path.basename(real)} is larger than 40 MB`);
  return real;
}

// ── markdown-ish → docx ──────────────────────────────────────────────────

/** **bold**, *italic* / _italic_, `code` → TextRuns */
export function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
    else if (tok.startsWith('`')) runs.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas' }));
    else runs.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs.length ? runs : [new TextRun('')];
}

const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function markdownToBlocks(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() }); continue; }
    const b = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (b) { flush(); blocks.push({ type: 'bullet', level: Math.min(Math.floor(b[1].length / 2), 3), text: b[2] }); continue; }
    const n = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (n) { flush(); blocks.push({ type: 'number', level: Math.min(Math.floor(n[1].length / 2), 3), text: n[2] }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      blocks.push({ type: 'table', rows });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

export async function createDocx({ title, content, filename }) {
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  for (const bl of markdownToBlocks(content)) {
    if (bl.type === 'h') children.push(new Paragraph({ children: inlineRuns(bl.text), heading: HEADINGS[bl.level - 1] }));
    else if (bl.type === 'bullet') children.push(new Paragraph({ children: inlineRuns(bl.text), bullet: { level: bl.level } }));
    else if (bl.type === 'number') children.push(new Paragraph({ children: inlineRuns(bl.text), numbering: { reference: 'num', level: bl.level } }));
    else if (bl.type === 'table') {
      const width = Math.max(...bl.rows.map(r => r.length));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: bl.rows.map((r, ri) => new TableRow({
          tableHeader: ri === 0,
          children: Array.from({ length: width }, (_, ci) => new TableCell({
            children: [new Paragraph({ children: ri === 0 ? [new TextRun({ text: r[ci] || '', bold: true })] : inlineRuns(r[ci] || '') })]
          }))
        }))
      }));
      children.push(new Paragraph(''));
    } else children.push(new Paragraph({ children: inlineRuns(bl.text) }));
  }
  const doc = new Document({
    creator: process.env.AGENT_NAME || 'LANAgent',
    title: title || undefined,
    numbering: { config: [{ reference: 'num', levels: [0, 1, 2, 3].map(level => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: children.length ? children : [new Paragraph('')] }]
  });
  const buf = await Packer.toBuffer(doc);
  const out = await uniquePath(safeFilename(filename || title, 'docx'));
  await fs.writeFile(out, buf);
  return { path: out, filename: path.basename(out), buffer: buf };
}

// ── spreadsheets ─────────────────────────────────────────────────────────

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ''));
}

/** "42" → 42, "=SUM(A1:A3)" → formula, everything else as given */
export function cellValue(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('=') && t.length > 1) return { formula: t.slice(1) };
    if (/^-?\d{1,15}(\.\d+)?$/.test(t)) return Number(t);
  }
  return v ?? null;
}

export function normaliseSheets({ sheets, rows, csv, headers, sheetName }) {
  let list = sheets;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  if (!Array.isArray(list) || !list.length) {
    let r = rows;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = parseCsv(r); } }
    if (!r && csv) r = parseCsv(csv);
    if (Array.isArray(r) && r.length && !Array.isArray(r[0]) && typeof r[0] === 'object') {
      const keys = [...new Set(r.flatMap(o => Object.keys(o)))];
      r = [keys, ...r.map(o => keys.map(k => o[k]))];
    } else if (Array.isArray(r) && headers) r = [[].concat(headers), ...r];
    list = [{ name: sheetName || 'Sheet1', rows: r || [] }];
  }
  return list.map((sh, i) => ({ name: String(sh.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, '').slice(0, 31) || `Sheet${i + 1}`, rows: Array.isArray(sh.rows) ? sh.rows : parseCsv(sh.csv || '') }));
}

export async function createXlsx({ title, filename, ...input }) {
  const sheets = normaliseSheets(input);
  if (!sheets.some(s => s.rows.length)) throw new Error('no rows to put in the spreadsheet (give rows, csv or sheets)');
  const wb = new ExcelJS.Workbook();
  wb.creator = process.env.AGENT_NAME || 'LANAgent';
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    sh.rows.forEach(r => ws.addRow([].concat(r).map(cellValue)));
    if (sh.rows.length > 1) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
    ws.columns.forEach(col => {
      let w = 8;
      col.eachCell({ includeEmpty: false }, c => { w = Math.max(w, Math.min(60, String(c.value?.formula ? '' : c.value ?? '').length + 2)); });
      col.width = w;
    });
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const out = await uniquePath(safeFilename(filename || title || sheets[0].name, 'xlsx'));
  await fs.writeFile(out, buf);
  return { path: out, filename: path.basename(out), buffer: buf, sheets: sheets.map(s => ({ name: s.name, rows: s.rows.length })) };
}

// ── presentations ────────────────────────────────────────────────────────

export function normaliseSlides(slides, outline) {
  let list = slides;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; outline = outline || slides; } }
  if (Array.isArray(list) && list.length) {
    return list.map(s => (typeof s === 'string' ? { title: s, bullets: [] } : {
      title: String(s.title || ''), bullets: [].concat(s.bullets || s.points || (s.content ? String(s.content).split('\n') : [])).map(b => String(b).replace(/^\s*[-*•]\s*/, '')).filter(Boolean), notes: s.notes || ''
    }));
  }
  // outline: "# Slide title" lines followed by "- bullet" lines
  const out = [];
  for (const line of String(outline || '').split('\n')) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) { out.push({ title: h[1].trim(), bullets: [] }); continue; }
    const b = line.match(/^\s*[-*•]\s+(.*)$/);
    if (b && out.length) out[out.length - 1].bullets.push(b[1].trim());
    else if (line.trim() && out.length) out[out.length - 1].bullets.push(line.trim());
  }
  return out;
}

export async function createPptx({ title, subtitle, slides, outline, content, filename }) {
  const list = normaliseSlides(slides, outline || content);
  if (!list.length && !title) throw new Error('no slides to make (give slides or an outline with "# Slide title" lines)');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = process.env.AGENT_NAME || 'LANAgent';
  if (title) pptx.title = title;
  if (title) {
    const s = pptx.addSlide();
    s.addText(title, { x: 0.6, y: 2.4, w: 12.1, h: 1.2, fontSize: 40, bold: true, align: 'center', color: '1F2937' });
    if (subtitle) s.addText(subtitle, { x: 0.6, y: 3.7, w: 12.1, h: 0.8, fontSize: 20, align: 'center', color: '6B7280' });
  }
  for (const sl of list) {
    const s = pptx.addSlide();
    s.addText(sl.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.9, fontSize: 30, bold: true, color: '111827' });
    if (sl.bullets.length) {
      s.addText(sl.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.4, w: 11.9, h: 5.6, fontSize: sl.bullets.length > 7 ? 16 : 20, valign: 'top', color: '374151', paraSpaceAfter: 6 });
    }
    if (sl.notes) s.addNotes(String(sl.notes));
  }
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  const out = await uniquePath(safeFilename(filename || title || list[0]?.title, 'pptx'));
  await fs.writeFile(out, buf);
  return { path: out, filename: path.basename(out), buffer: buf, slides: list.length + (title ? 1 : 0) };
}

// ── reading ──────────────────────────────────────────────────────────────

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const encodeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const slideOrder = names => names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));

export async function readOffice(p, { maxChars = 20000 } = {}) {
  const file = await resolveInput(p);
  const ext = path.extname(file).toLowerCase();
  const buf = await fs.readFile(file);
  let text, meta = {};
  if (ext === '.docx') {
    text = (await mammoth.extractRawText({ buffer: buf })).value;
  } else if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const parts = [];
    meta.sheets = [];
    wb.eachSheet(ws => {
      meta.sheets.push({ name: ws.name, rows: ws.rowCount });
      const rows = [];
      ws.eachRow({ includeEmpty: false }, row => {
        rows.push(row.values.slice(1).map(v => (v && typeof v === 'object' ? (v.result ?? v.text ?? (v.formula ? `=${v.formula}` : JSON.stringify(v))) : v ?? '')).join('\t'));
      });
      parts.push(`## ${ws.name}\n${rows.join('\n')}`);
    });
    text = parts.join('\n\n');
  } else if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(buf);
    const slides = slideOrder(Object.keys(zip.files));
    const parts = [];
    for (const [i, name] of slides.entries()) {
      const xml = await zip.file(name).async('string');
      const paras = xml.split(/<\/a:p>/).map(pp => [...pp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => decodeXml(m[1])).join('')).filter(Boolean);
      parts.push(`## Slide ${i + 1}\n${paras.join('\n')}`);
    }
    meta.slides = slides.length;
    text = parts.join('\n\n');
  } else {
    throw new Error('only .docx, .xlsx and .pptx files can be read here');
  }
  const truncated = text.length > maxChars;
  return { path: file, type: ext.slice(1), text: truncated ? `${text.slice(0, maxChars)}\n…(truncated)` : text, truncated, ...meta };
}

// ── editing ──────────────────────────────────────────────────────────────

/**
 * Replace text in every paragraph of an OOXML part. A match inside one run keeps that run's
 * formatting; a match that spans runs merges the paragraph's text into its first run (the
 * rest of that paragraph takes the first run's formatting).
 */
export function replaceInXml(xml, pairs, { p = 'w:p', t = 'w:t' } = {}) {
  let count = 0;
  const tRe = new RegExp(`(<${t}(?:\\s[^>]*)?>)([^<]*)(</${t}>)`, 'g');
  const out = xml.replace(new RegExp(`<${p}[ >][\\s\\S]*?</${p}>`, 'g'), para => {
    let changed = para;
    for (const { find, replace } of pairs) {
      if (!find) continue;
      // within runs
      changed = changed.replace(tRe, (m, open, body, close) => {
        const text = decodeXml(body);
        if (!text.includes(find)) return m;
        count += text.split(find).length - 1;
        return `${open.includes('xml:space') || t !== 'w:t' ? open : open.replace(`<${t}`, `<${t} xml:space="preserve"`)}${encodeXml(text.split(find).join(replace))}${close}`;
      });
      // across runs
      const texts = [...changed.matchAll(tRe)];
      const whole = texts.map(m => decodeXml(m[2])).join('');
      if (texts.length > 1 && whole.includes(find)) {
        count += whole.split(find).length - 1;
        const merged = whole.split(find).join(replace);
        let first = true;
        changed = changed.replace(tRe, (m, open, body, close) => {
          if (first) { first = false; return `${t === 'w:t' && !open.includes('xml:space') ? open.replace(`<${t}`, `<${t} xml:space="preserve"`) : open}${encodeXml(merged)}${close}`; }
          return `${open}${close}`;
        });
      }
    }
    return changed;
  });
  return { xml: out, count };
}

export async function editOffice(p, { replacements, cells, overwrite = false }) {
  const file = await resolveInput(p);
  const ext = path.extname(file).toLowerCase();
  const buf = await fs.readFile(file);
  let outBuf, changes = 0;

  if (ext === '.docx' || ext === '.pptx') {
    const pairs = [].concat(replacements || []).map(r => ({ find: String(r.find ?? r.from ?? r.old ?? ''), replace: String(r.replace ?? r.with ?? r.to ?? r.new ?? '') })).filter(r => r.find);
    if (!pairs.length) throw new Error('give replacements: [{ find, replace }]');
    const zip = await JSZip.loadAsync(buf);
    const parts = ext === '.docx'
      ? Object.keys(zip.files).filter(n => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n))
      : [...slideOrder(Object.keys(zip.files)), ...Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))];
    for (const name of parts) {
      const { xml, count } = replaceInXml(await zip.file(name).async('string'), pairs, ext === '.docx' ? {} : { p: 'a:p', t: 'a:t' });
      if (count) { zip.file(name, xml); changes += count; }
    }
    outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } else if (ext === '.xlsx') {
    const list = [].concat(cells || []);
    if (!list.length) throw new Error('give cells: [{ sheet, cell: "B2", value }]');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    for (const c of list) {
      const ws = c.sheet ? wb.getWorksheet(String(c.sheet)) : wb.worksheets[0];
      if (!ws) throw new Error(`no sheet named ${c.sheet}`);
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(String(c.cell || ''))) throw new Error(`"${c.cell}" is not a cell reference like B2`);
      ws.getCell(String(c.cell).toUpperCase()).value = cellValue(c.value);
      changes++;
    }
    outBuf = Buffer.from(await wb.xlsx.writeBuffer());
  } else {
    throw new Error('only .docx, .xlsx and .pptx files can be edited here');
  }

  if (!changes) return { path: file, changes: 0 };
  const out = overwrite ? file : await uniquePath(`${path.basename(file, ext)}-edited${ext}`);
  await fs.writeFile(out, outBuf);
  return { path: out, filename: path.basename(out), buffer: outBuf, changes };
}
