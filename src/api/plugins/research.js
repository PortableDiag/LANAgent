import { BasePlugin } from '../core/basePlugin.js';
import { extractParams } from '../../services/webtools/extractParams.js';
import { searchArxiv, getArxivPaper, latestArxiv, redditPosts, redditSearch, redditThread } from '../../services/webtools/research.js';

/** Academic papers (arXiv) and community discussion (Reddit), keyless. */
export default class ResearchPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'research';
    this.version = '1.0.0';
    this.description = 'Search arXiv papers and read Reddit posts, searches and threads';
    this.commands = [
      { command: 'arxivSearch', description: 'Search arXiv for research papers (by relevance or newest first, optionally in one category)',
        usage: 'arxivSearch({ query: "llm agents tool use", max: 10, sort: "relevance", category: "cs.AI" })',
        examples: ['find arxiv papers on retrieval augmented generation', 'search arxiv for the latest papers about diffusion models', 'research papers about llm agents'] },
      { command: 'arxivPaper', description: 'Get one arXiv paper\'s title, authors, abstract and PDF link by id or link',
        usage: 'arxivPaper({ id: "2305.14314" })', examples: ['what is arxiv paper 2305.14314 about', 'summarise this arxiv paper', 'get the abstract of arxiv 1706.03762'] },
      { command: 'arxivLatest', description: 'The newest papers announced in an arXiv category (cs.AI, cs.CL, cs.LG, math.CO …)',
        usage: 'arxivLatest({ category: "cs.AI", max: 15 })', examples: ['what are the newest cs.AI papers on arxiv', 'latest machine learning papers today'] },
      { command: 'redditPosts', description: 'Read a subreddit\'s posts (hot, new, top or rising)',
        usage: 'redditPosts({ subreddit: "node", sort: "top", time: "week", limit: 15 })',
        examples: ['what is trending on r/selfhosted', 'top posts this week in r/node', 'show me the newest posts on the homelab subreddit'] },
      { command: 'redditSearch', description: 'Search Reddit (everywhere, or within one subreddit)',
        usage: 'redditSearch({ query: "best nas drives", subreddit: "homelab", sort: "top" })',
        examples: ['what does reddit say about this product', 'search reddit for opinions on the framework laptop', 'find reddit threads about this error'] },
      { command: 'redditThread', description: 'Read a Reddit post and its comments from its link',
        usage: 'redditThread({ url: "https://www.reddit.com/r/node/comments/abc123/..." })',
        examples: ['read this reddit thread', 'summarise the comments on this reddit post'] }
    ];
  }

  async execute(params = {}) {
    const { action, ...p } = await extractParams(this, params.action, params);
    try {
      switch (action) {
        case 'arxivSearch': {
          const r = await searchArxiv(p.query || p.q || p.topic, { max: p.max || p.limit, sort: p.sort || p.sort_by || p.sortBy || p.order, category: p.category });
          return { success: true, ...r, result: `${r.note ? `(${r.note})\n` : ''}${r.papers.map((x, i) => `${i + 1}. ${x.title} — ${x.authors.slice(0, 3).join(', ')}${x.authors.length > 3 ? ' et al.' : ''} (${x.published})\n   ${x.url}`).join('\n') || 'No papers found.'}` };
        }
        case 'arxivPaper': {
          const x = await getArxivPaper(p.id || p.url || p.paper);
          return { success: true, paper: x, result: `${x.title}\n${x.authors.join(', ')} (${x.published})\n${x.url}${x.pdf ? `\nPDF: ${x.pdf}` : ''}\n\n${x.summary}` };
        }
        case 'arxivLatest': {
          const papers = await latestArxiv(p.category || 'cs.AI', { max: p.max || p.limit });
          return { success: true, papers, result: papers.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}`).join('\n') || 'Nothing announced.' };
        }
        case 'redditPosts': {
          const posts = await redditPosts(p.subreddit || p.sub, { sort: p.sort, time: p.time, limit: p.limit });
          return { success: true, posts, result: posts.map((x, i) => `${i + 1}. ${x.title}\n   ${x.link}`).join('\n') || 'No posts.' };
        }
        case 'redditSearch': {
          const posts = await redditSearch(p.query || p.q, { subreddit: p.subreddit || p.sub, sort: p.sort, limit: p.limit });
          return { success: true, posts, result: posts.map((x, i) => `${i + 1}. [r/${x.subreddit}] ${x.title}\n   ${x.link}`).join('\n') || 'No matching posts.' };
        }
        case 'redditThread': {
          const r = await redditThread(p.url || p.link, { limit: p.limit });
          return { success: true, ...r, result: `${r.post?.title || ''}\n${r.post?.text || ''}\n\n${r.comments.map(c => `— ${c.text}`).join('\n')}`.trim() };
        }
        default:
          return { success: false, error: `Unknown action '${action}'. Use: arxivSearch, arxivPaper, arxivLatest, redditPosts, redditSearch, redditThread` };
      }
    } catch (error) {
      this.logger.warn(`research ${action} failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
