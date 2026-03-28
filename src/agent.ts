import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Exported types ────────────────────────────────────────────────────────────

export interface CollectedArticle {
  title: string;
  url: string;
  source: string;
  category: string;
  summary: string;
  collectedAt: string;
}

export type AgentEvent =
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "summarize"; title: string }
  | { type: "article"; article: CollectedArticle }
  | { type: "complete"; articles: CollectedArticle[]; savedPath: string }
  | { type: "error"; message: string };

// ── Internal types ────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface FetchedArticle {
  title: string;
  content: string;
  url: string;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function webSearch(query: string): Promise<SearchResult[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    headers: { "User-Agent": "InsuranceNewsAgent/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Search failed: ${res.status}`);

  const xml = await res.text();
  const results: SearchResult[] = [];

  for (const match of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10)) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1]?.trim();
    const link  = item.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/)?.[1]?.trim();
    const desc  = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1];
    const src   = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim();

    if (title) {
      results.push({
        title,
        url: link ?? "",
        snippet: desc ? desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "",
        source: src ?? "Google News",
      });
    }
  }

  return results;
}

async function fetchArticle(url: string): Promise<FetchedArticle> {
  // ── Bug fix: never throw — return partial content on any error ────────────
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [fetch_article] 接続エラー (${msg.slice(0, 60)}): ${url.slice(0, 60)}`);
    return { title: url, content: `[接続エラー: ${msg}]`, url };
  }

  // Non-2xx → return status info instead of throwing; Claude will skip gracefully
  if (!res.ok) {
    console.warn(`  [fetch_article] HTTP ${res.status}: ${url.slice(0, 80)}`);
    return { title: url, content: `[HTTP ${res.status}: 記事を取得できませんでした]`, url };
  }

  let html: string;
  try {
    html = await res.text();
  } catch {
    return { title: url, content: "[レスポンス読み取りエラー]", url };
  }

  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? res.url;

  const title = rawTitle
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim().slice(0, 6_000);

  return { title, content, url: res.url };
}

async function summarizeArticle(title: string, content: string): Promise<string> {
  const res = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 400,
    messages: [{
      role: "user",
      content: [
        "以下の保険関連記事を日本語で150〜200字程度に要約してください。重要なポイントを簡潔にまとめてください。",
        "",
        `タイトル: ${title}`,
        "",
        `記事内容:\n${content}`,
      ].join("\n"),
    }],
  });

  const block = res.content[0];
  return block.type === "text" ? block.text : "要約を生成できませんでした。";
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "unknown"; }
}

const MAX_ARTICLES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description: "Search for insurance news articles by keyword. Returns a list of articles with titles, URLs, and snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'e.g. "life insurance news 2025"' },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_article",
    description: "Fetch the full text content of a news article from its URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Article URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "summarize",
    description: "Summarize a news article in Japanese and store it with category metadata.",
    input_schema: {
      type: "object",
      properties: {
        title:    { type: "string", description: "Article title" },
        content:  { type: "string", description: "Full article text" },
        url:      { type: "string", description: "Article URL" },
        category: { type: "string", description: "生命保険 | 損害保険 | 再保険 | InsurTech" },
      },
      required: ["title", "content", "url", "category"],
    },
  },
];

const SYSTEM_PROMPT = `You are an AI agent that collects and analyzes global insurance industry news.

Collect at most ${MAX_ARTICLES} articles in total across these four categories:
1. 生命保険 (life insurance)         — search: "life insurance news 2025"
2. 損害保険 (property casualty)       — search: "property casualty insurance news 2025"
3. 再保険 (reinsurance)               — search: "reinsurance market news 2025"
4. InsurTech                          — search: "insurtech startup innovation 2025"

For each category:
- web_search to find recent articles
- Pick 1–2 relevant articles; fetch_article to get full content
- summarize with title, content, url, and the Japanese category name

Stop as soon as you have collected ${MAX_ARTICLES} articles total. When done, say "収集完了" only.`;

// ── Main exported function ────────────────────────────────────────────────────

export async function collectNews(
  onEvent?: (event: AgentEvent) => void
): Promise<CollectedArticle[]> {
  const collectedArticles: CollectedArticle[] = [];
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: "世界の最新保険ニュースを4カテゴリ分収集し、各記事を日本語で要約してください。",
  }];

  for (let step = 1; step <= 40; step++) {
    if (collectedArticles.length >= MAX_ARTICLES) {
      console.log(`最大記事数 (${MAX_ARTICLES}) に達しました。`);
      break;
    }

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 4_096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        console.warn(`Rate Limit エラー。${collectedArticles.length} 件を保存して終了します。`);
        onEvent?.({ type: "error", message: `Rate limit を超過しました。${collectedArticles.length} 件を保存して終了します。` });
        break;
      }
      throw err;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const { id, name, input } = block;
      let result: string;

      try {
        switch (name) {
          case "web_search": {
            const { query } = input as { query: string };
            console.log(`  [web_search] "${query}"`);
            onEvent?.({ type: "search", query });
            const items = await webSearch(query);
            result = JSON.stringify(items, null, 2);
            break;
          }

          case "fetch_article": {
            const { url } = input as { url: string };
            console.log(`  [fetch_article] ${url.slice(0, 80)}...`);
            onEvent?.({ type: "fetch", url });
            const article = await fetchArticle(url);
            result = JSON.stringify(article, null, 2);
            break;
          }

          case "summarize": {
            if (collectedArticles.length >= MAX_ARTICLES) {
              result = `最大記事数 (${MAX_ARTICLES}) に達しました。`;
              break;
            }

            const { title, content, url, category } = input as {
              title: string; content: string; url: string; category: string;
            };
            console.log(`  [summarize] "${title.slice(0, 50)}..."`);
            onEvent?.({ type: "summarize", title });

            // ── Bug fix: inner try/catch so push() ALWAYS executes ────────
            // If summarizeArticle throws (e.g. API error), the outer catch would
            // swallow the error and skip collectedArticles.push entirely.
            let summary: string;
            try {
              summary = await summarizeArticle(title, content);
            } catch (sumErr) {
              console.error("  [summarize] API error:", sumErr);
              summary = "要約を生成できませんでした。";
            }

            const article: CollectedArticle = {
              title, url, source: extractDomain(url), category, summary,
              collectedAt: new Date().toISOString(),
            };

            collectedArticles.push(article);           // always reached
            onEvent?.({ type: "article", article });
            console.log(`  収集済み: ${collectedArticles.length}/${MAX_ARTICLES} 件`);

            if (collectedArticles.length < MAX_ARTICLES) {
              await sleep(2_000);
            }

            result = summary;
            break;
          }

          default:
            result = `Unknown tool: ${name}`;
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`  ERROR (${name}):`, result);
      }

      toolResults.push({ type: "tool_result", tool_use_id: id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Save to JSON
  const dataDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dateStr = new Date().toISOString().split("T")[0];
  const savedPath = path.join(dataDir, `insurance_news_${dateStr}.json`);

  fs.writeFileSync(savedPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalArticles: collectedArticles.length,
    categories: ["生命保険", "損害保険", "再保険", "InsurTech"],
    articles: collectedArticles,
  }, null, 2), "utf-8");

  console.log(`\n結果を保存: ${savedPath} (${collectedArticles.length} 件)`);
  onEvent?.({ type: "complete", articles: collectedArticles, savedPath });

  return collectedArticles;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  console.log("\n保険ニュース自動収集 AI Agent");
  console.log("=".repeat(60));

  collectNews().then((articles) => {
    console.log("\n" + "=".repeat(60));
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      console.log(`\n[${i + 1}] [${a.category}] ${a.title}`);
      console.log(`    ${a.source} | ${a.url}`);
      console.log(`    ${a.summary}`);
    }
    console.log(`\n合計 ${articles.length} 件`);
  }).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
