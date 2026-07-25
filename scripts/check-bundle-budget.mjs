import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const assetsDirectory = join(projectRoot, "apps", "web", "dist", "assets");
const maximumJavaScriptBytes = 500 * 1024;

let entries;
try {
  entries = await readdir(assetsDirectory, { withFileTypes: true });
} catch (error) {
  console.error("Web assets are missing. Run `npm run build` before checking the bundle budget.");
  throw error;
}

const javascriptAssets = entries.filter(
  (entry) => entry.isFile() && entry.name.endsWith(".js"),
);

if (javascriptAssets.length === 0) {
  throw new Error("No JavaScript assets were produced by the web build.");
}

const measuredAssets = await Promise.all(
  javascriptAssets.map(async (entry) => {
    const path = join(assetsDirectory, entry.name);
    return {
      path: relative(projectRoot, path),
      bytes: (await stat(path)).size,
    };
  }),
);

const overBudget = measuredAssets.filter(
  (asset) => asset.bytes > maximumJavaScriptBytes,
);

for (const asset of measuredAssets.sort((left, right) => right.bytes - left.bytes)) {
  console.log(`${asset.path}: ${(asset.bytes / 1024).toFixed(2)} kB`);
}

if (overBudget.length > 0) {
  const names = overBudget.map((asset) => asset.path).join(", ");
  throw new Error(
    `JavaScript bundle budget exceeded (${maximumJavaScriptBytes / 1024} kB): ${names}`,
  );
}
