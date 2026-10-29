#!/usr/bin/env node
/**
 * Puts the Rust style compiler (wasm + its JS bindings) in vendor/vectorstyle,
 * where src/VectorStyle.ts imports it from.
 *
 *   node scripts/fetch-vector-assets.mjs            fetch it if missing or stale
 *   node scripts/fetch-vector-assets.mjs --force    fetch again regardless
 *
 * It is built and released by MapConductor/vectortile, not here. The tag and
 * the SHA-256 of the asset are pinned in scripts/vector-assets.json, and an
 * asset that does not match its checksum is refused. `prebuild` runs this, so a
 * clean checkout builds, tests and publishes the same bytes.
 *
 * react-vectortile fetches the renderer from the same release the same way,
 * from its own copy of this script; keep the two tags in step.
 *
 * To try a local build of mapconductor-vectortile instead, point
 * MAPCONDUCTOR_VECTORTILE_DIR at that checkout (after `npm run build` in its
 * bindings/js-style). Nothing is verified then, and the stamp says so, so the
 * next plain run fetches the pinned release again.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = JSON.parse(readFileSync(join(ROOT, "scripts", "vector-assets.json"), "utf8"));

/** Release asset -> where it is unpacked, and where a local build keeps it. */
const TARGET = { asset: "vectorstyle-web.tgz", dest: "vendor/vectorstyle", local: "bindings/js-style" };

const force = process.argv.includes("--force");
const localDir = process.env.MAPCONDUCTOR_VECTORTILE_DIR;

function stampOf(dest) {
  const path = join(ROOT, dest, ".release");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function fromLocalBuild({ dest, local }) {
  const src = join(localDir, local);
  for (const part of ["pkg", "dist", "package.json"]) {
    if (!existsSync(join(src, part))) throw new Error(`${join(src, part)} is missing; build it first`);
  }
  const out = join(ROOT, dest);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const part of ["pkg", "dist", "package.json"]) cpSync(join(src, part), join(out, part), { recursive: true });
  // wasm-pack's own `*` .gitignore; harmless here, but it is not in a release either.
  rmSync(join(out, "pkg", ".gitignore"), { force: true });
  writeFileSync(join(out, ".release"), `local ${src}\n`);
  console.log(`${dest} <- ${src} (local build, unverified)`);
}

async function fromRelease({ asset, dest }) {
  const expected = PIN.assets[asset];
  if (!expected) throw new Error(`scripts/vector-assets.json pins no checksum for ${asset}`);
  const stamp = `${PIN.tag} ${expected}`;
  if (!force && stampOf(dest) === stamp) return;

  const url = `https://github.com/${PIN.repository}/releases/download/${PIN.tag}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`${asset} from ${PIN.tag}: SHA-256 ${actual}, expected ${expected}`);
  }

  const archive = join(tmpdir(), `mapconductor-${PIN.tag}-${asset}`);
  writeFileSync(archive, bytes);
  const out = join(ROOT, dest);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", archive, "-C", out], { stdio: "inherit" });
  } finally {
    rmSync(archive, { force: true });
  }
  writeFileSync(join(out, ".release"), `${stamp}\n`);
  console.log(`${dest} <- ${PIN.repository}@${PIN.tag} ${asset}`);
}

if (localDir) fromLocalBuild(TARGET);
else await fromRelease(TARGET);
