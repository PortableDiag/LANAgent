---
name: competitor-news-monitor
description: Set up ongoing monitoring of a company, competitor, product or topic across its blog, release notes, news and Reddit, with alerts for new posts - use when asked to keep an eye on a competitor, follow a company's announcements, watch for news about a product, or track a blog or changelog.
source: lanagent
inspired_by: hermes-agent competitor-news-monitor / blogwatcher
---

## Procedure
1. Pin down the target: company or product name, its website, and what matters to the operator (pricing, releases, outages, hiring, lawsuits…). Turn those into 2-5 keywords.
2. Find the sources:
   - feeds.discover({ url: "<company site>" }) and the same for its blog, newsroom and changelog/releases page. GitHub projects publish `https://github.com/<org>/<repo>/releases.atom`.
   - For community talk: `https://www.reddit.com/r/<subreddit>/search.rss?restrict_sr=1&q=<name>&sort=new` is a feed too.
   - websearch.search({ query: "<company> news" }) to find a newsroom or a news source with a feed.
3. Show the operator the feeds found (name + URL) before watching anything.
4. Watch each chosen feed: feeds.watch({ url, name: "<Company> blog", keywords: [...], interval: 60 }). Official channels: no keywords (every post matters). Broad sources (news, Reddit search): always set keywords. The first check only records existing posts; alerts come for newer ones.
5. Confirm with feeds.list and state: what is watched, how often, and that alerts arrive on Telegram.
6. On request, summarise a batch: feeds.read({ url, limit: 10 }) and group items by theme, newest first, each with its link.

## Rules
- A site without a feed cannot be watched here; say so rather than inventing one. If the page matters, suggest a price/page check instead.
- Do not watch more than ~10 feeds per target without asking; it becomes noise.
- Report only what the items say; do not speculate about a competitor's plans beyond the text.
