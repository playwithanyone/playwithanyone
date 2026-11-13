import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
if (process.argv.length !== 2) throw new Error("Usage: node scripts/prepare-connect-four.mjs (uses explicit configs/cloud/resources.json)");
const resources = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
if (resources.environment !== "preview") throw new Error("Only the approved preview release is enabled.");
const generatedRoot = path.join(root, ".generated");
await mkdir(generatedRoot, { recursive: true });
if ((await lstat(generatedRoot)).isSymbolicLink()) throw new Error("Generated root cannot be a symbolic link.");
const generated = path.join(generatedRoot, "connect-four");
await rm(generated, { recursive: true, force: true });
await mkdir(path.join(generated, "server-private"), { recursive: true });
// Source contains TypeScript and provenance outside release scopes. Only the
// actual client, declared assets and compiled private rules are publication inputs.
await cp("games/connect-four/client", path.join(generated, "client"), { recursive: true });
await cp("games/connect-four/game-package.json", path.join(generated, "game-package.json"));
for (const scope of ["assets", "public-simulation"]) {
  try { await cp(path.join(root, "games/connect-four", scope), path.join(generated, scope), { recursive: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await build({ entryPoints: ["packages/sdk/src/client.ts"], outfile: path.join(generated, "client/sdk.js"),
  bundle: true, platform: "browser", format: "esm", target: "es2022", sourcemap: false, legalComments: "none", logLevel: "warning" });
await build({ entryPoints: ["games/connect-four/src/rules.ts"], outfile: path.join(generated, "server-private/rules.js"),
  bundle: true, platform: "browser", format: "esm", target: "es2022", sourcemap: false, legalComments: "none", logLevel: "warning" });
const license = await readFile("games/connect-four/LICENSE", "utf8");
const provenance = JSON.parse(await readFile("games/connect-four/provenance.json", "utf8"));
await writeFile(path.join(generated, "server-private/third-party-notices.json"), JSON.stringify({ provenance, license }, null, 2) + "\n");
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await writeFile(path.join(generated, "client/licenses.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Four · Open-source notices</title><body><main><h1>Open-source notices</h1><p>Gravity and winner detection adapted from BattleBox at ${provenance.commit}. Platform networking and presentation are implemented by PlayWithAnyone.</p><pre>${escape(license)}</pre></main></body></html>\n`);
const { createRelease, writeRelease } = await import(pathToFileURL(path.join(root, ".build/packages/release/src/release.js")).href);
const prepared = await createRelease(generated, { gameDomain: resources.workerSubdomain, assetOrigin: resources.assetOrigin });
const written = await writeRelease(prepared, path.join(generatedRoot, "releases"));
const metadata = { status: "PREPARED_NOT_DEPLOYED", gameId: "connect-four", gameBuildId: prepared.manifest.gameBuildId,
  buildHostLabel: prepared.manifest.buildHostLabel, frameOrigin: prepared.manifest.frameOrigin, entryUrl: prepared.manifest.entryUrl,
  directory: written.directory, publicBytes: prepared.files.filter(file => file.descriptor.scope !== "server-private").reduce((sum, file) => sum + file.descriptor.bytes, 0),
  privateBytes: prepared.files.filter(file => file.descriptor.scope === "server-private").reduce((sum, file) => sum + file.descriptor.bytes, 0) };
await writeFile(path.join(generatedRoot, "connect-four-release.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata));
