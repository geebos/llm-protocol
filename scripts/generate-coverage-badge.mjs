#!/usr/bin/env node
/**
 * Generate a shields.io endpoint badge JSON from vitest coverage output.
 *
 * Reads coverage/coverage-summary.json (produced by `npm run test:coverage`,
 * json-summary reporter) and writes coverage/coverage-badge.json in the
 * shields.io endpoint schema. ci.yml publishes this file to the `badges`
 * branch, and the README renders it via
 *   https://img.shields.io/endpoint?url=.../raw/geebos/llm-protocol/badges/coverage.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = join(root, "coverage", "coverage-summary.json");
const outPath = join(root, "coverage", "coverage-badge.json");

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf8"));
} catch (err) {
  console.error(`Cannot read ${summaryPath}: ${err.message}`);
  console.error("Run `npm run test:coverage` first.");
  process.exit(1);
}

const pct = summary.total?.lines?.pct;
if (typeof pct !== "number") {
  console.error(`No total.lines.pct found in ${summaryPath}`);
  process.exit(1);
}

const rounded = Math.round(pct * 10) / 10;
const color =
  rounded >= 90 ? "green" : rounded >= 80 ? "yellowgreen" : rounded >= 70 ? "yellow" : "red";

const badge = {
  schemaVersion: 1,
  label: "coverage",
  message: `${rounded}%`,
  color,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(badge, null, 2) + "\n", "utf8");
console.log(`coverage ${rounded}% -> ${outPath}`);
