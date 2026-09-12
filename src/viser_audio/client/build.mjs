// Bundles the browser runtime into ../runtime.js, which is checked in and
// shipped in wheels: the Python package injects its source into viser clients.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const clientDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(clientDir, "index.ts")],
  outfile: path.join(clientDir, "..", "runtime.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  charset: "ascii",
  logLevel: "info",
});

// An ES module for players that provide their own clock and message transport.
await build({
  entryPoints: [path.join(clientDir, "audio.ts")],
  outfile: path.join(clientDir, "..", "engine.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  charset: "ascii",
  logLevel: "info",
});
