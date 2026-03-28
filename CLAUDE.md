# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Insurance news AI Agent that automatically collects global insurance news (生命保険, 損害保険, 再保険, InsurTech), fetches article content, generates Japanese summaries, and displays results in a web UI.

## Commands

```bash
npm install        # install dependencies
npm run dev        # start Express server at http://localhost:3000
npm run agent      # run agent as CLI (no server)
npm run build      # compile TypeScript → dist/
npm start          # run compiled server
```

Requires a `.env` file with `ANTHROPIC_API_KEY=sk-ant-...`

## Architecture

```
src/
  agent.ts   — core agent logic; exports collectNews(onEvent?) + AgentEvent type
  server.ts  — Express server; SSE /api/collect, static /public, GET /api/news/latest
public/
  index.html — single-file frontend (inline CSS + JS, no build step)
data/
  insurance_news_YYYY-MM-DD.json  — output (created at runtime)
```

### Agent loop (`src/agent.ts`)

Three tools in the agentic loop:
- `web_search` — queries Google News RSS, returns ≤10 results per search
- `fetch_article` — fetches URL, strips HTML, returns plain text (≤6000 chars)
- `summarize` — calls `claude-opus-4-6` for Japanese summary; **also appends to `collectedArticles[]`** and emits `{ type: "article" }` event

Article collection is tracked via the `summarize` tool call (carries `url` + `category` params). There is no secondary JSON-parsing step.

`collectNews(onEvent?)` is the exported function. It saves to `data/` and resolves with the collected array. `require.main === module` check at the bottom keeps CLI usage (`npm run agent`) working unchanged.

### Server (`src/server.ts`)

| Endpoint | Description |
|---|---|
| `GET /` | Serves `public/index.html` |
| `GET /api/collect` | SSE stream — runs `collectNews`, forwards `AgentEvent` objects as `data:` frames |
| `GET /api/news/latest` | Returns the most recent `data/insurance_news_*.json` file |
| `GET /api/status` | `{ collecting: boolean }` |

Only one concurrent collection is allowed (`isCollecting` guard → 409 if busy).

### Frontend (`public/index.html`)

- Connects to `/api/collect` via `EventSource` on button click
- Cards appear in real-time as each `article` event arrives (no page reload)
- Category tabs filter the grid client-side
- On page load, calls `/api/news/latest` to restore the previous session's results
