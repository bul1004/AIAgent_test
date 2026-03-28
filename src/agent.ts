import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface CollectedArticle {
  title: string;
  url: string;
  source: string;
  category: string;
  summary: string;
  collectedAt: string;
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function webSearch(query: string): Promise<SearchResult[]> {
  console.log(`  [web_search] "${query}"`);

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
        snippet: desc
          ? desc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
          : "",
        source: src ?? "Google News",
      });
    }
  }

  return results;
}

async function fetchArticle(url: string): Promise<FetchedArticle> {
  console.log(`  [fetch_article] ${url.slice(0, 80)}...`);

  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);

  const html = await res.text();
  const finalUrl = res.url;

  const rawTitle =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? finalUrl;

  const title = rawTitle
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  const content = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6_000);

  return { title, content, url: finalUrl };
}

async function summarizeArticle(
  title: string,
  content: string
): Promise<string> {
  console.log(`  [summarize] "${title.slice(0, 50)}..."`);

  const res = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          "以下の保険関連記事を日本語で150〜200字程度に要約してください。",
          "重要なポイントを簡潔にまとめてください。",
          "",
          `タイトル: ${title}`,
          "",
          `記事内容:\n${content}`,
        ].join("\n"),
      },
    ],
  });

  const block = res.content[0];
  return block.type === "text" ? block.text : "要約を生成できませんでした。";
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search for insurance news articles by keyword. Returns a list of articles with titles, URLs, and snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query (e.g. "life insurance news 2025", "insurtech startup funding")',
        },
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
        url: {
          type: "string",
          description: "The URL of the article to retrieve",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "summarize",
    description:
      "Summarize a news article in Japanese. Stores the result with category metadata.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Article title",
        },
        content: {
          type: "string",
          description: "Full article text to summarize",
        },
        url: {
          type: "string",
          description: "Article URL",
        },
        category: {
          type: "string",
          description:
            "News category: 生命保険 | 損害保険 | 再保険 | InsurTech",
        },
      },
      required: ["title", "content", "url", "category"],
    },
  },
];

// ── Main agent ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI agent that collects and analyzes global insurance industry news.

Your task is to gather recent news from these four categories:
1. 生命保険 (life insurance) — search: "life insurance news 2025"
2. 損害保険 (property casualty insurance) — search: "property casualty insurance news 2025"
3. 再保険 (reinsurance) — search: "reinsurance market news 2025"
4. InsurTech — search: "insurtech startup innovation 2025"

For each category:
- Use web_search to find recent articles
- Pick 2–3 of the most relevant and recent articles
- Use fetch_article to get the full content of each
- Use summarize to create a Japanese summary, passing title, content, url, and the category name in Japanese

Work through all four categories systematically. When done, say "収集完了" and nothing else.`;

async function runAgent(): Promise<void> {
  console.log("\n保険ニュース自動収集 AI Agent");
  console.log("=".repeat(60));

  const collectedArticles: CollectedArticle[] = [];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        "世界の最新保険ニュースを4カテゴリ分収集し、各記事を日本語で要約してください。",
    },
  ];

  const MAX_STEPS = 40;

  for (let step = 1; step <= MAX_STEPS; step++) {
    process.stdout.write(`\n[Step ${step}] `);

    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4_096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    // Print any text blocks
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(block.text.trim().slice(0, 200));
      }
    }

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use") break;

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const { id, name, input } = block;
      let result: string;

      try {
        switch (name) {
          case "web_search": {
            const { query } = input as { query: string };
            const items = await webSearch(query);
            result = JSON.stringify(items, null, 2);
            break;
          }

          case "fetch_article": {
            const { url } = input as { url: string };
            const article = await fetchArticle(url);
            result = JSON.stringify(article, null, 2);
            break;
          }

          case "summarize": {
            const { title, content, url, category } = input as {
              title: string;
              content: string;
              url: string;
              category: string;
            };
            const summary = await summarizeArticle(title, content);

            collectedArticles.push({
              title,
              url,
              source: extractDomain(url),
              category,
              summary,
              collectedAt: new Date().toISOString(),
            });

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

  // ── Display results ─────────────────────────────────────────────────────────

  console.log("\n" + "=".repeat(60));
  console.log("収集した保険ニュース一覧");
  console.log("=".repeat(60));

  if (collectedArticles.length === 0) {
    console.log("記事を収集できませんでした。");
  } else {
    for (let i = 0; i < collectedArticles.length; i++) {
      const a = collectedArticles[i];
      console.log(`\n[${i + 1}] [${a.category}]`);
      console.log(`    タイトル: ${a.title}`);
      console.log(`    ソース  : ${a.source}`);
      console.log(`    URL     : ${a.url}`);
      console.log(`    要約    : ${a.summary}`);
    }
  }

  // ── Save to JSON ─────────────────────────────────────────────────────────────

  const dataDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dateStr = new Date().toISOString().split("T")[0];
  const outputPath = path.join(dataDir, `insurance_news_${dateStr}.json`);

  const output = {
    generatedAt: new Date().toISOString(),
    totalArticles: collectedArticles.length,
    categories: ["生命保険", "損害保険", "再保険", "InsurTech"],
    articles: collectedArticles,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n結果を保存しました: ${outputPath}`);
  console.log(`合計 ${collectedArticles.length} 件の記事を収集しました。`);
}

runAgent().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
