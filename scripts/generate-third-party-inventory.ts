import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { collectRuntimeLicenseInventory } from "./runtime-dependencies.ts";

const root = resolve(process.cwd());
const destination = resolve(root, "THIRD_PARTY_LICENSES.json");
const inventory = await collectRuntimeLicenseInventory(root);

await writeFile(destination, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${inventory.packages.length} production dependency records to THIRD_PARTY_LICENSES.json.`,
);
