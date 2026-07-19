import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { packageManager?: unknown };
const declared = typeof manifest.packageManager === "string" ? manifest.packageManager : "";
const expected = /^bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(declared)?.[1];
const actual = process.versions.bun;

if (!expected) {
  throw new Error(`package.json must declare Bun as bun@x.y.z; found ${JSON.stringify(declared)}.`);
}
if (!actual) {
  throw new Error(`Galapagos requires Bun ${expected}; this guard was not started by Bun.`);
}
if (actual !== expected) {
  throw new Error(`Galapagos requires Bun ${expected}; found Bun ${actual}.`);
}

console.log(`Bun ${actual} verified.`);
