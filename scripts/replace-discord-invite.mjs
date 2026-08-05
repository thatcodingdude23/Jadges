import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const oldInvite = `https://discord.gg/${"jay" + "cord"}`;
const newInvite = "https://discord.gg/h63eG654F";
const roots = ["src", "web", "vencord-plugin", "revenge-plugin", "kettu-plugin"];
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".html"]);

async function replaceInDirectory(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await replaceInDirectory(path);
      continue;
    }
    if (!textExtensions.has(extname(entry.name))) continue;

    const source = await readFile(path, "utf8");
    if (!source.includes(oldInvite)) continue;
    await writeFile(path, source.replaceAll(oldInvite, newInvite));
    console.log(`[invite] updated ${path}`);
  }
}

for (const root of roots) await replaceInDirectory(root);
