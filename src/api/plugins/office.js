import { BasePlugin } from '../core/basePlugin.js';
import { extractParams } from '../../services/webtools/extractParams.js';
import { createDocx, createXlsx, createPptx, readOffice, editOffice, OUTPUT_DIR } from '../../services/webtools/officeDocs.js';

/** "home network security best practices" → "Home network security best practices" */
const titleFrom = (topic) => {
  const t = String(topic).replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '').slice(0, 70);
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Word, Excel and PowerPoint: make documents, spreadsheets and slide decks, read them, and
 * edit them. Asked to write something without being given the text, the plugin drafts it
 * with the agent's AI first. The file comes back to the chat and stays in workspace/documents
 * (from where trellis-notes.attachFile or email can send it on).
 */
export default class OfficePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'office';
    this.version = '1.0.0';
    this.description = 'Create, read and edit Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files';
    this.commands = [
      { command: 'createDocument', description: 'Write a Word document (.docx file): a report, letter, summary or notes about any topic, or from text you give (headings, lists and tables supported)',
        usage: 'createDocument({ title: "Q3 report", content: "# Summary\\n- point one\\n| a | b |\\n|---|---|\\n| 1 | 2 |" })  // or { topic: "a one-page lease summary" }',
        examples: ['make a word document about home security tips', 'write a short word doc about a topic', 'create a docx report about our server uptime', 'make a word document with these notes', 'draft a letter as a word file', 'turn this into a docx'] },
      { command: 'createSpreadsheet', description: 'Make an Excel spreadsheet (.xlsx file) from a table, list or CSV, with one or more sheets; cells starting with = become formulas',
        usage: 'createSpreadsheet({ filename: "budget", rows: [["Item","Cost"],["Rent",1200],["Total","=SUM(B2:B2)"]] })  // or csv: "a,b\\n1,2", or sheets: [{ name, rows }]',
        examples: ['make a spreadsheet of these expenses', 'put this table in an excel file', 'create an xlsx with a sheet per month', 'export this list to excel'] },
      { command: 'createPresentation', description: 'Make a PowerPoint presentation (.pptx slide deck) about a topic, or from an outline or list of slides',
        usage: 'createPresentation({ title: "Project update", slides: [{ title: "Status", bullets: ["On track", "Beta next week"], notes: "..." }] })  // or { outline: "# A\\n- x" } or { topic: "..." }',
        examples: ['make a powerpoint about our q3 results', 'create a slide deck from this outline', 'build a 5 slide presentation on home network security', 'turn these notes into slides'] },
      { command: 'readDocument', description: 'Read the text of a .docx, .xlsx or .pptx file the agent has (downloads, uploads, workspace)',
        usage: 'readDocument({ path: "report.docx" })', examples: ['read the word document I sent', 'what does this spreadsheet contain', 'show me the text of the slides'] },
      { command: 'editDocument', description: 'Edit an office file: find and replace text in a .docx or .pptx, or set cells in an .xlsx; saves a new "-edited" copy unless overwrite is true',
        usage: 'editDocument({ path: "contract.docx", replacements: [{ find: "2025", replace: "2026" }] })  // xlsx: { path, cells: [{ sheet: "Sheet1", cell: "B2", value: 42 }] }',
        examples: ['replace the old company name in the word document', 'change cell B2 in the spreadsheet to 42', 'update the date on the slides'] }
    ];
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    try {
      switch (action) {
        case 'createDocument': {
          let content = p.content || p.text || p.body || p.markdown;
          const topic = p.topic || p.prompt || p.about || p.subject;
          if (!content && topic) content = await this.draft('document', { ...p, topic });
          if (!content) throw new Error('give the content (text/markdown) or a topic to write about');
          const title = p.title || (topic ? titleFrom(topic) : undefined);
          return this.deliver(await createDocx({ title, content, filename: p.filename || p.name || title }), 'Word document');
        }
        case 'createSpreadsheet':
          return this.deliver(await createXlsx({ ...p, filename: p.filename || p.name }), 'spreadsheet');
        case 'createPresentation': {
          let { slides, outline } = p;
          outline = outline || p.content || p.text;
          const topic = p.topic || p.prompt || p.about || p.subject;
          if (!slides && !outline && topic) outline = await this.draft('presentation', { ...p, topic });
          const title = p.title || (topic ? titleFrom(topic) : undefined);
          return this.deliver(await createPptx({ title, subtitle: p.subtitle, slides, outline, filename: p.filename || p.name || title }), 'presentation');
        }
        case 'readDocument': {
          const r = await readOffice(p.path || p.file || p.filename);
          return { success: true, ...r, result: r.text || '(no text found)' };
        }
        case 'editDocument': {
          const r = await editOffice(p.path || p.file || p.filename, { replacements: p.replacements || (p.find ? [{ find: p.find, replace: p.replace ?? p.with ?? '' }] : undefined), cells: p.cells || (p.cell ? [{ sheet: p.sheet, cell: p.cell, value: p.value }] : undefined), overwrite: p.overwrite === true || p.overwrite === 'true' });
          if (!r.changes) return { success: false, error: 'nothing matched, so nothing was changed' };
          return this.deliver(r, `edited file (${r.changes} change${r.changes === 1 ? '' : 's'})`);
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Use: createDocument, createSpreadsheet, createPresentation, readDocument, editDocument` };
      }
    } catch (error) {
      this.logger.warn(`office ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * The file goes back to the chat as a document (the agent sends `file: { path }` results as
   * attachments, as it does for ytdlp downloads) and stays on disk.
   */
  deliver(r, what) {
    const { buffer, ...rest } = r;
    return {
      success: true, ...rest,
      file: { path: r.path, filename: r.filename },
      result: `📄 Made the ${what}: ${r.filename} (saved in ${OUTPUT_DIR})`
    };
  }

  async draft(kind, p) {
    const topic = p.topic || p.prompt || p.about;
    const pm = this.agent?.providerManager;
    if (!pm) throw new Error('no AI provider to draft the content; give the content instead');
    const ask = kind === 'presentation'
      ? `Write the outline of a ${p.slideCount || p.slides_count || '6-8'} slide presentation${p.title ? ` titled "${p.title}"` : ''} about: ${topic}\nFormat exactly: each slide starts with a line "# Slide title", followed by 3-5 lines "- bullet" (short, concrete, no filler). No title slide, no intro text, nothing else.`
      : `Write a ${p.length || 'concise'} document${p.title ? ` titled "${p.title}"` : ''} about: ${topic}\nUse markdown: "## " section headings, "- " bullets, and pipe tables where data fits. Plain, direct language; no preamble, no sign-off, no title line.`;
    const res = await pm.generateResponse(ask, { maxTokens: 3000, temperature: 0.4 });
    const text = String(res?.content || '').replace(/^```(?:markdown|md)?\s*|\s*```$/g, '').trim();
    if (!text) throw new Error('the AI returned nothing to put in the file');
    return text;
  }
}
