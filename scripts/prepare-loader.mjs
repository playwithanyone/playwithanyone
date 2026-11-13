import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
let deployment = {};
try { deployment = JSON.parse(await readFile(path.join(root, "configs/cloud/resources.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const options = {
  source: path.join(root, "games/fixtures/loader"),
  output: path.join(root, ".generated/releases"),
  gameDomain: deployment.workerSubdomain ?? "games.example.test",
  assetOrigin: deployment.assetOrigin ?? "https://assets.example.test",
};
const names = { "--source": "source", "--output": "output", "--game-domain": "gameDomain", "--asset-origin": "assetOrigin" };
const args = process.argv.slice(2), seen = new Set();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  const key = names[flag];
  if (!key || !value || value.startsWith("--") || seen.has(flag)) throw new Error("Usage: node scripts/prepare-loader.mjs [--source directory] [--output directory] [--game-domain DNS-suffix] [--asset-origin HTTPS-origin]");
  seen.add(flag); options[key] = key === "source" || key === "output" ? path.resolve(value) : value;
}
const sourceStat = await lstat(options.source);
if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("Loader source must be a real directory.");
const source = await realpath(options.source);
const generated = path.join(root, ".generated/loader");
if (source === generated || source.startsWith(generated + path.sep) || generated.startsWith(source + path.sep)) throw new Error("Loader source and generated copy must be separate directory trees.");
const { createRelease, writeRelease } = await import(pathToFileURL(path.join(root, ".build/packages/release/src/release.js")).href);
await mkdir(path.join(root, ".generated"), { recursive: true });
if ((await lstat(path.join(root, ".generated"))).isSymbolicLink()) throw new Error("Generated output root must not be a symbolic link.");
// This exact directory is a task-owned, reproducible source copy, never a source checkout.
await rm(generated, { recursive: true, force: true });
await cp(source, generated, { recursive: true });
await build({
  entryPoints: [path.join(root, "packages/sdk/src/client.ts")], outfile: path.join(generated, "client/sdk.js"),
  bundle: true, platform: "browser", format: "esm", target: "es2022", sourcemap: false,
  minify: false, legalComments: "none", logLevel: "warning",
});
const prepared = await createRelease(generated, { gameDomain: options.gameDomain, assetOrigin: options.assetOrigin });
const written = await writeRelease(prepared, options.output);
const metadata = {
  status: "PREPARED_NOT_DEPLOYED", gameId: prepared.browserManifest.gameId,
  gameBuildId: prepared.manifest.gameBuildId, buildHostLabel: prepared.manifest.buildHostLabel,
  frameOrigin: prepared.manifest.frameOrigin, entryUrl: prepared.manifest.entryUrl,
  directory: written.directory,
  releaseDirectory: written.directory,
  manifestPath: path.join(written.directory, "manifest.json"),
  browserManifestPath: path.join(written.directory, "public/browser-manifest.json"),
  publicDirectory: path.join(written.directory, "public"),
  privateDirectory: path.join(written.directory, "private"),
  publicBytes: prepared.files.filter(file => file.descriptor.scope !== "server-private").reduce((sum, file) => sum + file.descriptor.bytes, 0),
  privateBytes: prepared.files.filter(file => file.descriptor.scope === "server-private").reduce((sum, file) => sum + file.descriptor.bytes, 0),
};
await writeFile(path.join(root, ".generated/loader-release.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata, null, 2));
