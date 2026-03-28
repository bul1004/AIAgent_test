# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Insurance news AI Agent that automatically collects global insurance news (life, P&C, reinsurance, InsurTech), fetches article content, and saves Japanese-language summaries to JSON.

## Commands

```bash
npm install          # install dependencies
npm run dev          # run with tsx (development, no build step)
npm run build        # compile TypeScript → dist/
npm start            # run compiled output
```

Requires a `.env` file with `ANTHROPIC_API_KEY=sk-ant-...`

## Architecture

```
src/agent.ts          — single-file implementation
data/insurance_news_YYYY-MM-DD.json  — output (created at runtime)
```

**Agent loop** (`src/agent.ts`):

1. Claude orchestrates the session using three tools:
   - `web_search` — queries Google News RSS and returns up to 10 results
   - `fetch_article` — fetches a URL, strips HTML, returns plain text (6000 char max)
   - `summarize` — calls Claude API (`claude-opus-4-6`) to produce a 150–200 char Japanese summary, and **also stores the article** in the in-memory `collectedArticles` array with category metadata
2. The agent loop runs until `stop_reason === "end_turn"` or the 40-step limit
3. On completion, results are printed to stdout and written to `data/`

**Key design point**: article collection is driven by the `summarize` tool call — the `url` and `category` fields on that tool are how the agent records which articles it has processed. There is no secondary JSON-parsing step.
