import express from "express";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { collectNews, AgentEvent } from "./agent";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "..", "public")));

// ── State ─────────────────────────────────────────────────────────────────────

let isCollecting = false;

// ── SSE: start news collection ────────────────────────────────────────────────

app.get("/api/collect", (req, res) => {
  if (isCollecting) {
    res.status(409).json({ error: "Collection already in progress" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  isCollecting = true;

  const send = (event: AgentEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  collectNews(send)
    .then((articles) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "done", count: articles.length })}\n\n`);
        res.end();
      }
    })
    .catch((err: Error) => {
      console.error("Agent error:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    })
    .finally(() => {
      isCollecting = false;
    });

  req.on("close", () => {
    isCollecting = false;
  });
});

// ── GET latest saved news ─────────────────────────────────────────────────────

app.get("/api/news/latest", (_req, res) => {
  const dataDir = path.join(__dirname, "..", "data");

  try {
    if (!fs.existsSync(dataDir)) {
      res.json({ articles: [], generatedAt: null });
      return;
    }

    const files = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith("insurance_news_") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) {
      res.json({ articles: [], generatedAt: null });
      return;
    }

    const raw = fs.readFileSync(path.join(dataDir, files[0]), "utf-8");
    res.json(JSON.parse(raw));
  } catch {
    res.json({ articles: [], generatedAt: null });
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  res.json({ collecting: isCollecting });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("\n保険ニュース収集 AI Agent — Web Server");
  console.log(`http://localhost:${PORT}\n`);
});
