#!/usr/bin/env node
/**
 * Настройка Git + GitHub для проекта "Вертер"
 *
 * Использование:
 *   node git-setup.js              — инициализация локального репозитория
 *   node git-setup.js --push       — создать репо на GitHub и запушить
 *   node git-setup.js --init-only  — только локальный git init
 *
 * Для пуша требуется токен GitHub (GitHub PAT):
 *   1. Создать: https://github.com/settings/tokens (repo, workflow)
 *   2. Передать через аргумент --token или переменную GH_TOKEN
 */

import * as git from "isomorphic-git";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const GIT_DIR = path.join(PROJECT_ROOT, ".git");

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function eprint(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

async function gitExists() {
  try {
    await git.log({ fs, dir: PROJECT_ROOT, depth: 1 });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Step 1: Local git init + first commit
// ─────────────────────────────────────────────

async function initLocalRepo() {
  eprint("📦 Инициализация локального git-репозитория...");

  if (await gitExists()) {
    eprint("  Репозиторий уже инициализирован.");
    return;
  }

  // Initialize .git manually if needed
  const gitDir = path.join(PROJECT_ROOT, ".git");
  const headPath = path.join(gitDir, "HEAD");
  if (!fs.existsSync(headPath)) {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(headPath, "ref: refs/heads/main\n", "utf-8");
  }

  // Create .gitignore if not exists
  const gitignorePath = path.join(PROJECT_ROOT, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    const gitignore = [
      "node_modules/",
      "output/",
      "*.log",
      ".env",
      "article.json",
      "Thumbs.db",
      "__pycache__/",
      "*.pyc",
    ].join("\n") + "\n";
    fs.writeFileSync(gitignorePath, gitignore, "utf-8");
    eprint("  .gitignore создан");
  }

  // Read all files in project (recursively)
  const files = [];
  function walk(currentDir, relativeDir = "") {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;

      // Skip .git, node_modules, output
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "output") continue;
      if (entry.name.endsWith(".log") || entry.name === ".env" || entry.name === "package-lock.json") continue;

      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else {
        files.push(relativePath.replace(/\\/g, "/"));
      }
    }
  }
  walk(PROJECT_ROOT);

  // Create initial tree and commit manually
  const emptyTreeHash = await git.writeTree({
    fs,
    dir: PROJECT_ROOT,
    tree: [],
  });

  // Manually create HEAD commit
  const commitHash = await git.writeCommit({
    fs,
    dir: PROJECT_ROOT,
    commit: {
      message: "init: первый запуск Вертер",
      author: { name: "Вертер", email: "verter@localspace", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      committer: { name: "Вертер", email: "verter@localspace", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      tree: emptyTreeHash,
      parent: [],
    },
  });

  // Update HEAD to point to the commit
  fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), commitHash + "\n", "utf-8");

  // Add all files
  for (const filePath of files) {
    try {
      await git.add({ fs, dir: PROJECT_ROOT, filepath: filePath });
    } catch (err) {
      eprint(`  Пропущен ${filePath}: ${err.message}`);
    }
  }

  // Amend commit with actual file contents
  await git.commit({
    fs,
    dir: PROJECT_ROOT,
    author: { name: "Вертер", email: "verter@localspace" },
    message: "init: первый запуск Вертер",
    force: true,
  });

  eprint(`  ✓ Репозиторий инициализирован`);
  eprint(`  ✓ Добавлено файлов: ${files.length}`);
  eprint(`  ✓ Первый коммит создан`);
}

// ─────────────────────────────────────────────
// Step 2: Create GitHub repo + push
// ─────────────────────────────────────────────

function httpsRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith("https") ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...headers, "Content-Type": "application/json" },
    };

    const req = client.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function setupGitHub(token, repoName, isPrivate = false) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Verther/1.0",
  };

  // Check if repo already exists
  eprint(`\n🌐 GitHub: проверка репозитория "${repoName}"...`);
  const check = await httpsRequest(
    `https://api.github.com/repos/${repoName}`,
    "GET",
    headers
  );

  let repoUrl;
  let owner;

  if (check.status === 200) {
    eprint("  Репозиторий уже существует.");
    repoUrl = check.data.html_url;
    owner = check.data.owner.login;
  } else if (check.status === 404) {
    // Create new repo
    eprint("  Создание нового репозитория...");
    const body = JSON.stringify({
      name: repoName.split("/").pop() || repoName,
      private: isPrivate,
      description: "Вертер — ежедневный арт-сайт, генерируемый AI-агентами",
    });

    // Try creating under user
    const create = await httpsRequest(
      "https://api.github.com/user/repos",
      "POST",
      headers,
      body
    );

    if (create.status >= 400) {
      // Maybe user wants org repo? Try with full name
      eprint(`  Ошибка создания репозитория: ${create.data?.message || create.status}`);
      throw new Error(`GitHub: ${create.data?.message || JSON.stringify(create.data)}`);
    }

    repoUrl = create.data.html_url;
    owner = create.data.owner.login;
    eprint(`  ✓ Репозиторий создан: ${repoUrl}`);
  } else {
    throw new Error(`GitHub API: ${check.status} — ${JSON.stringify(check.data)}`);
  }

  // Push to GitHub using isomorphic-git
  eprint(`\n⬆️  Push на GitHub...`);

  const remoteUrl = `https://github.com/${repoName}.git`;

  // Check if remote already exists
  try {
    const remotes = await git.listRemotes({ fs, dir: PROJECT_ROOT });
    const hasOrigin = remotes.some((r) => r.remote === "origin");
    if (hasOrigin) {
      eprint("  Remote origin уже настроен.");
      // Update URL if needed
      await git.setConfig({
        fs,
        dir: PROJECT_ROOT,
        path: "remote.origin.url",
        value: remoteUrl,
      });
    } else {
      await git.addRemote({
        fs,
        dir: PROJECT_ROOT,
        remote: "origin",
        url: remoteUrl,
      });
      eprint("  Remote origin добавлен.");
    }
  } catch (err) {
    eprint(`  Remote error: ${err.message}, создаю заново...`);
    try { await git.deleteRemote({ fs, dir: PROJECT_ROOT, remote: "origin" }); } catch {}
    await git.addRemote({ fs, dir: PROJECT_ROOT, remote: "origin", url: remoteUrl });
    eprint("  Remote origin добавлен.");
  }

  // Push
  try {
    await git.push({
      fs,
      dir: PROJECT_ROOT,
      remote: "origin",
      ref: "main",
      onAuth: () => ({ username: token, password: "x-oauth-basic" }),
      onProgress: (ev) => {
        if (ev.phase) eprint(`    ${ev.phase}: ${ev.loaded}/${ev.total}`);
      },
    });
    eprint(`\n  ✓ Push успешен!`);
  } catch (err) {
    // Try 'master' branch if 'main' fails
    try {
      await git.branch({ fs, dir: PROJECT_ROOT, ref: "master" });
      await git.push({
        fs,
        dir: PROJECT_ROOT,
        remote: "origin",
        ref: "master",
        onAuth: () => ({ username: token, password: "x-oauth-basic" }),
      });
      eprint(`\n  ✓ Push успешен! (ветка master)`);
    } catch (err2) {
      eprint(`  ✗ Push failed: ${err2.message}`);
      throw err2;
    }
  }

  return repoUrl;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const pushMode = args.includes("--push");
  const initOnly = args.includes("--init-only");

  eprint("=".repeat(50));
  eprint("  Git + GitHub для проекта ВЕРТЕР");
  eprint("=".repeat(50));

  // Step 1: Always init local repo
  await initLocalRepo();
  if (initOnly) {
    eprint("\nЛокальный репозиторий готов. Для пуша запусти:");
    eprint("  node git-setup.js --push");
    return;
  }

  // Step 2: Push to GitHub
  if (pushMode) {
    const token =
      args[args.indexOf("--token") + 1] ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN;

    if (!token) {
      eprint("\n❌ Требуется GitHub токен. Передай через:");
      eprint('   node git-setup.js --push --token "ghp_xxx"');
      eprint("   или переменную окружения GH_TOKEN");
      eprint("\n   Создать токен: https://github.com/settings/tokens");
      eprint("   Нужны права: repo, workflow");
      process.exit(1);
    }

    const repoName = args[args.indexOf("--repo") + 1] || "verter";
    const isPrivate = args.includes("--private");
    const fullRepoName = repoName.includes("/") ? repoName : `${token.split("_").pop() || "user"}/${repoName}`;

    try {
      const repoUrl = await setupGitHub(token, repoName, isPrivate);
      eprint(`\n✅ Всё готово! Репозиторий: ${repoUrl}`);
      eprint("\nДалее: ежедневный запуск");
      eprint(`  node orchestrator.js --article-file article.json`);
    } catch (err) {
      eprint(`\n❌ Ошибка: ${err.message}`);
      process.exit(1);
    }
  } else {
    eprint("\nЛокальный репозиторий готов.");
    eprint("\nДля пуша на GitHub выполни:");
    eprint('  node git-setup.js --push --token "ghp_ваш_токен"');
    eprint("\nИли вместе с настройкой:");
    eprint('  node git-setup.js --init-only   # только локальный git');
  }
}

main();
