#!/usr/bin/env node
/**
 * Оркестратор арт-проекта "Вертер"
 *
 * Использование:
 *   node orchestrator.js                                          # авто-фетч статьи (требуется HTTP доступ)
 *   node orchestrator.js --article-file article.json              # статья из JSON-файла
 *   node orchestrator.js --article-text "Заголовок: ...\n\nТекст..." # статья из текста
 *   node orchestrator.js --article-url "https://..."              # статья по URL
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "agents_config.json");
const OUTPUT_ROOT = path.join(__dirname, "output");
const STATE_PATH = path.join(__dirname, ".verter_state.json");
const TEMP_MIN = 0.3;
const TEMP_MAX = 1.7;
const TEMP_STEP = 0.1;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function eprint(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function save(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { temperature: TEMP_MIN, runCount: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function nextTemperature(current) {
  const next = Math.round((current + TEMP_STEP) * 10) / 10;
  return next > TEMP_MAX ? TEMP_MIN : next;
}

// ─────────────────────────────────────────────
// Ollama API
// ─────────────────────────────────────────────

class OllamaError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

async function callOllama(model, messages, { timeoutMs = 600_000, temperature } = {}) {
  const url = "http://localhost:11434/api/chat";
  const body = JSON.stringify({
    model, messages, stream: false,
    options: temperature !== undefined ? { keep_alive: 0, temperature } : { keep_alive: 0 },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Heartbeat — keep process alive while waiting for model to load
  const heartbeat = setInterval(() => eprint("  ...waiting"), 30_000);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (err.name === "AbortError") throw new OllamaError(`Request timed out after ${timeoutMs}ms`);
    throw new OllamaError(`Fetch failed: ${err.message}`);
  }
  clearTimeout(timer);
  clearInterval(heartbeat);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new OllamaError(`HTTP ${resp.status}: ${text}`, resp.status);
  }

  const data = await resp.json();
  if (!data?.message?.content) {
    throw new OllamaError(`Unexpected response: ${JSON.stringify(data)}`);
  }
  return data.message.content.trim();
}

async function callAgent(agentCfg, userInput, extraOpts = {}) {
  const model = agentCfg.model;
  const systemPrompt = agentCfg.prompt_template;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInput },
  ];
  eprint(`  model=${model}${extraOpts.temperature !== undefined ? ` temp=${extraOpts.temperature}` : ""}`);
  try {
    return await callOllama(model, messages, extraOpts);
  } catch (err) {
    eprint(`  ERROR: ${err.message}`);
    throw err;
  }
}

function extractCode(text, language) {
  const patterns = language
    ? [new RegExp(`\`\`\`${language}\\s*\\n([\\s\\S]*?)\`\`\``, "i")]
    : [/```(?:\w+)?\s*\n([\s\S]*?)```/g];

  for (const p of patterns) {
    if (p instanceof RegExp && !p.flags.includes("g")) {
      const m = p.exec(text);
      if (m) return m[1].trim();
    } else {
      p.lastIndex = 0;
      const m = p.exec(text);
      if (m) return m[1].trim();
    }
  }
  return text.trim();
}

// ─────────────────────────────────────────────
// Article fetching
// ─────────────────────────────────────────────

async function fetchArticleFromUrl(url) {
  eprint(`  Fetching URL: ${url}`);
  const resp = await fetch(url, { headers: { "User-Agent": "Verther/1.0" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const html = await resp.text();
  // crude text extraction: strip tags
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title: url.split("/").pop() || url,
    content: text.slice(0, 8000),
    url,
    source: "web",
  };
}

// ─────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────

async function runPipeline(article) {
  const config = loadConfig();
  const agents = config.agents;

  const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const dayDir = path.join(OUTPUT_ROOT, dateStr);

  eprint("=".repeat(60));
  eprint(`  ВЕРТЕР — Ежедневный цикл  (${dateStr})`);
  eprint("=".repeat(60));

  // Save article
  save(dayDir, "article.json", JSON.stringify(article, null, 2));
  const articleText = `Заголовок: ${article.title}\n\nИсточник: ${article.source}\nURL: ${article.url}\n\n---\n\n${article.content}`;
  eprint(`\n[0] Статья: ${article.source}: ${article.title}`);

  // Step 1: Creative → TZ (with temperature cycle)
  const state = loadState();
  const temp = state.temperature;
  eprint(`\n[1] Креативщик → ТЗ (temp=${temp})`);
  const tz = await callAgent(agents.creative, articleText, { temperature: temp });
  // Increment temperature for next run
  state.temperature = nextTemperature(temp);
  state.runCount = (state.runCount || 0) + 1;
  saveState(state);
  save(dayDir, "01_tz.txt", tz);

  // Step 2: Designer → CSS
  eprint("\n[2] Дизайнер → CSS");
  let css = await callAgent(agents.designer, tz);
  css = extractCode(css, "css") || extractCode(css);
  save(dayDir, "02_design.css", css);

  // Step 3: Frontend → raw HTML
  eprint("\n[3] Фронтенд → HTML+JS");
  let htmlRaw = await callAgent(agents.frontend, `ТЗ:\n${tz}\n\nCSS:\n${css}`);
  htmlRaw = extractCode(htmlRaw, "html") || extractCode(htmlRaw);
  save(dayDir, "03_index_raw.html", htmlRaw);

  // Step 4: Editor → content
  eprint("\n[4] Редактор → контент");
  const content = await callAgent(agents.editor, tz);
  save(dayDir, "04_content.html", content);

  // Step 5: Critic → review
  eprint("\n[5] Критик → ревью");
  const review = await callAgent(agents.critic,
    `ТЗ:\n${tz}\n\nСгенерированный HTML:\n${htmlRaw}\n\nКонтент:\n${content}\n\nПроверь на ошибки, соответствие ТЗ, предложи улучшения.`);
  save(dayDir, "05_review.txt", review);

  // Step 6: Fix
  eprint("\n[6] Фронтенд → фикс по ревью");
  let finalHtml = await callAgent(agents.frontend,
    `ТЗ:\n${tz}\n\nТекущий HTML:\n${htmlRaw}\n\nРевью:\n${review}\n\nИсправь все проблемы. Верни ПОЛНЫЙ HTML-файл с embedded CSS и JS.`);
  finalHtml = extractCode(finalHtml, "html") || extractCode(finalHtml);

  // Ensure proper document structure
  if (!/<!DOCTYPE/i.test(finalHtml) && !/<html/i.test(finalHtml)) {
    finalHtml = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Вертер — ${article.title}</title>
  <style>${css}</style>
</head>
<body>
${finalHtml}
</body>
</html>`;
  }

  save(dayDir, "index.html", finalHtml);

  // Summary
  const summary = [
    `Сайт: ${dayDir}\\index.html`,
    `Источник: ${article.source}: ${article.title}`,
    `URL: ${article.url}`,
    `Дата: ${dateStr}`,
    `Temp: ${temp}`,
  ].join("\n");
  save(dayDir, "summary.txt", summary);

  eprint("\n" + "=".repeat(60));
  eprint("  ГОТОВО!");
  eprint(`  Результат: ${dayDir}\\index.html`);
  eprint("=".repeat(60));
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    eprint(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);

  let article;

  if (args.includes("--article-file")) {
    const idx = args.indexOf("--article-file");
    const filePath = args[idx + 1];
    if (!filePath) { eprint("--article-file requires path"); process.exit(1); }
    const raw = fs.readFileSync(filePath, "utf-8");
    article = JSON.parse(raw);
  } else if (args.includes("--article-text")) {
    const idx = args.indexOf("--article-text");
    const text = args[idx + 1];
    article = {
      title: "Ручной ввод",
      content: text,
      url: "",
      source: "manual",
    };
  } else if (args.includes("--article-url")) {
    const idx = args.indexOf("--article-url");
    const url = args[idx + 1];
    article = await fetchArticleFromUrl(url);
  } else {
    eprint("Usage: node orchestrator.js --article-file <file>");
    eprint("       node orchestrator.js --article-text <text>");
    eprint("       node orchestrator.js --article-url <url>");
    process.exit(1);
  }

  try {
    await runPipeline(article);
  } catch (err) {
    if (err instanceof OllamaError) {
      eprint(`\nOllama error: ${err.message}`);
      eprint("Make sure Ollama is running (ollama serve)");
    } else {
      eprint(`\nError: ${err.message}`);
      console.error(err);
    }
    process.exit(1);
  }
}

main();
