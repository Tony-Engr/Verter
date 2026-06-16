import * as git from "isomorphic-git";
import fs from "fs";
import path from "path";

const dir = path.resolve(".");

async function init() {
  const files = [];
  function walk(dirPath, rel) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dirPath, e.name);
      const rp = rel ? path.join(rel, e.name) : e.name;
      if (e.name === ".git" || e.name === "node_modules" || e.name === "output") continue;
      if (e.name.endsWith(".log")) continue;
      if (e.isDirectory()) walk(fp, rp);
      else files.push(rp.replace(/\\/g, "/"));
    }
  }
  walk(dir, "");

  for (const f of files) {
    try {
      await git.add({ fs, dir, filepath: f });
    } catch (_) {
      // skip binary or problematic files
    }
  }

  const hash = await git.commit({
    fs,
    dir,
    author: { name: "Verter", email: "verter@localspace" },
    message: "init: первый запуск Вертер",
  });

  console.log("OK");
  console.log("Commit:", hash);
  console.log("Files:", files.length);
}

init().catch((e) => {
  console.log("ERR:" + e.message);
  process.exit(1);
});
