---
name: literature-review
description: Find and summarise the research on a topic from arXiv papers, with citations and a short synthesis of what is known, disputed and open - use when asked what the research says about something, to find papers on a topic, for a literature review, the state of the art, or the latest papers in a field.
source: lanagent
inspired_by: hermes-agent arxiv / research-paper-writing
---

## Procedure
1. Turn the question into 2-3 search phrasings (the plain term, the technical term, a close synonym).
2. research.arxivSearch({ query, max: 10 }) for each; add sort: "date" when the operator wants recent work. For "what's new in <field>" use research.arxivLatest({ category: "cs.AI" }) (cs.CL language, cs.LG learning, cs.CV vision, cs.CR security, stat.ML).
3. Deduplicate by arXiv id. Keep the 5-8 most relevant; read each abstract with research.arxivPaper({ id }) when the search summary is thin.
4. Synthesise, do not list: group papers by approach or finding, say where they agree, where results conflict, and what remains open. Note dates — a 2019 result may be superseded.
5. Cite every claim inline as [n] and end with a Sources list: [n] Title — first author et al. (year) — arXiv link.
6. Offer next steps: a deeper read of one paper (scraper.scrape on the arXiv HTML version), or a document of the review (office.createDocument).

## Rules
- arXiv preprints are not peer reviewed; say so when a claim rests on one paper.
- Never cite a paper that was not returned by a search or lookup in this session.
- If the search fell back to OpenAlex (the result says so), mention that coverage may differ.
