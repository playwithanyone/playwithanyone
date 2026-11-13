import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalize, createRelease, digestToBase32, normalizeArtifactPath, parseJson, ReleaseError, validateDefinition, writeRelease } from "../../release/src/release.js";
import type { GamePackageDefinition, PreparedRelease } from "../../release/src/release.js";
import { main as releaseCli } from "../../../apps/release-cli/src/main.js";

const selected = { gameDomain: "fixture-account.workers.dev", assetOrigin: "https://assets.fixture.example" };
const fixture = path.resolve("games/fixtures/loader");
const hasCode = (code: string) => (error: unknown): boolean => error instanceof ReleaseError && error.code === code;
async function temporary(run: (source: string, output: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pwa-release-"));
  try {
    const source = path.join(directory, "source");
    await cp(fixture, source, { recursive: true });
    // Publication tests inspect the module graph without executing this fixture.
    // Real SDK execution is covered separately; prepare-loader bundles its real client.
    await writeFile(path.join(source, "client/sdk.js"), "export const connectGameClient = null;\n");
    await run(source, path.join(directory, "releases"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function definition(): Promise<GamePackageDefinition> {
  return validateDefinition(parseJson(await readFile(path.join(fixture, "game-package.json"), "utf8")));
}

test("release JCS uses explicit UTF-16 order and ECMAScript number serialization", () => {
  assert.equal(canonicalize({ "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji", "\u0080": "Control", "ö": "Latin" }),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin","€":"Euro Sign","😀":"Emoji","דּ":"Hebrew Letter Dalet With Dagesh"}');
  assert.equal(canonicalize([-0, 1e30, 2e-3, 1e-27, 333333333.33333329]), "[0,1e+30,0.002,1e-27,333333333.3333333]");
  assert.equal(canonicalize({ z: [3, { b: true, a: null }], a: '"\\\n' }), '{"a":"\\"\\\\\\n","z":[3,{"a":null,"b":true}]}');
});

test("release JCS rejects lossy/non-JSON input, duplicate members and invalid Unicode without executing getters", () => {
  const cycle: Record<string, unknown> = {}; cycle["self"] = cycle;
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { getterCalls++; return 1; } });
  const namedArray: unknown[] = [];
  Object.defineProperty(namedArray, "4294967295", { value: 1 });
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("x"), new Date(), { value: undefined }, cycle, Array(2), accessor, namedArray, "\ud800", "\udc00"]) {
    assert.throws(() => canonicalize(value), hasCode("INVALID_JSON"));
  }
  assert.equal(getterCalls, 0);
  for (const json of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1,}', '[1,]', '1 2', '"\\ud800"', '1e999']) assert.throws(() => parseJson(json), hasCode("INVALID_JSON"));
});

test("release full digest maps to a fixed 52-character lowercase unpadded base32 DNS label", () => {
  assert.equal(digestToBase32("00".repeat(32)), "a".repeat(52));
  assert.equal(digestToBase32("ff".repeat(32)), "7".repeat(51) + "q");
  assert.throws(() => digestToBase32("ff".repeat(8)), hasCode("BUILD_DIGEST"));
  assert.throws(() => digestToBase32("FF".repeat(32)), hasCode("BUILD_DIGEST"));
});

test("release identity is independent of origins and changes for content, rules or private implementation", async () => {
  await temporary(async (source) => {
    const a = await createRelease(source, selected);
    const b = await createRelease(source, { gameDomain: "another.example", assetOrigin: "https://other-assets.example" });
    assert.equal(a.manifest.gameBuildId, b.manifest.gameBuildId);
    assert.notEqual(a.manifest.frameOrigin, b.manifest.frameOrigin);
    assert.match(a.manifest.gameBuildId, /^[0-9a-f]{64}$/);
    assert.match(a.manifest.buildHostLabel, /^b-[a-z2-7]{52}$/);
    assert.equal(a.manifest.buildHostLabel.length, 54);
    assert.deepEqual(a.manifest.identity.artifacts.map(item => item.path), ["assets/sample.json", "client/index.html", "client/main.js", "client/sdk.js", "client/style.css", "server-private/marker.js"]);
    assert.equal(a.manifest.identity.artifacts.find(item => item.path === "assets/sample.json")?.mime, "application/json; charset=utf-8");
    assert.equal(JSON.stringify(a.manifest.identity).includes(a.manifest.gameBuildId), false);
    assert.equal(JSON.stringify(a.manifest.identity).includes("https://"), false);
    await writeFile(path.join(source, "assets/sample.json"), '{"fixture":"changed"}');
    const changedAsset = await createRelease(source, selected);
    assert.notEqual(a.manifest.gameBuildId, changedAsset.manifest.gameBuildId);
    await writeFile(path.join(source, "server-private/marker.js"), 'export const marker = "changed-private";');
    const changedPrivate = await createRelease(source, selected);
    assert.notEqual(changedAsset.manifest.gameBuildId, changedPrivate.manifest.gameBuildId);
    const def = JSON.parse(await readFile(path.join(source, "game-package.json"), "utf8")) as GamePackageDefinition;
    await writeFile(path.join(source, "game-package.json"), JSON.stringify({ ...def, rules: { ...def.rules, version: 2 } }));
    assert.notEqual(changedPrivate.manifest.gameBuildId, (await createRelease(source, selected)).manifest.gameBuildId);
  });
});

test("release schema requires explicit contracts, budgets and capability declarations", async () => {
  const def = await definition();
  const { recovery: _recovery, ...missing } = def;
  assert.throws(() => validateDefinition(missing), hasCode("MANIFEST_SCHEMA"));
  assert.throws(() => validateDefinition({ ...def, budgets: { ...def.budgets, maxFrameBytes: 16385 } }), hasCode("MANIFEST_SCHEMA"));
  assert.throws(() => validateDefinition({ ...def, protocol: { min: 1, max: 2 } }), hasCode("PROTOCOL_VERSION"));
  assert.throws(() => validateDefinition({ ...def, browserCapabilities: ["threads"] }), hasCode("MANIFEST_SCHEMA"));
  assert.throws(() => validateDefinition({ ...def, requiredAssets: ["server-private/marker.js"] }), hasCode("PRIVATE_DEPENDENCY"));
  assert.throws(() => validateDefinition({ ...def, entries: { ...def.entries, client: "server-private/marker.js" } }), hasCode("MANIFEST_SCHEMA"));
});

test("release publication separates private objects, is idempotent, and refuses immutable overwrite", async () => {
  await temporary(async (source, output) => {
    const prepared = await createRelease(source, selected), first = await writeRelease(prepared, output);
    assert.equal(first.reused, false);
    assert.equal((await writeRelease(prepared, output)).reused, true);
    assert.deepEqual(await readdir(path.join(first.directory, "public")), ["assets", "browser-manifest.json", "client"]);
    const browser = await readFile(path.join(first.directory, "public/browser-manifest.json"), "utf8");
    assert.equal(browser.includes("server-private"), false);
    assert.equal(browser.includes("PWA_FIXTURE_SERVER_PRIVATE_MUST_NOT_BECOME_PUBLIC"), false);
    assert.match(await readFile(path.join(first.directory, "private/server-private/marker.js"), "utf8"), /PWA_FIXTURE_SERVER_PRIVATE_MUST_NOT_BECOME_PUBLIC/);
    await writeFile(path.join(first.directory, "public/assets/sample.json"), "tampered");
    await assert.rejects(() => writeRelease(prepared, output), hasCode("IMMUTABLE_RELEASE"));
    assert.equal(await readFile(path.join(first.directory, "public/assets/sample.json"), "utf8"), "tampered");
  });
});

test("release validates content again before writing a prepared in-memory bundle", async () => {
  await temporary(async (source, output) => {
    const prepared = await createRelease(source, selected), asset = prepared.files.find(file => file.descriptor.path === "assets/sample.json")!;
    asset.content[0] = 0;
    await assert.rejects(() => writeRelease(prepared, output), hasCode("BUILD_DIGEST"));
    assert.deepEqual(await readdir(output), []);
    await assert.rejects(() => writeRelease(prepared, path.join(source, "output")), hasCode("OUTPUT_PATH"));
  });
});

test("release rejects public imports of private code, dynamic/bare imports, external URLs and missing modules", async () => {
  const examples = [
    ['import "../server-private/marker.js";', "PRIVATE_DEPENDENCY"],
    ['export * from "../server-private/marker.js";', "PRIVATE_DEPENDENCY"],
    ['const x = import("../server-private/marker.js");', "PRIVATE_DEPENDENCY"],
    ['const x = import(window.moduleName);', "DYNAMIC_DEPENDENCY"],
    ['import "https://unregistered.example/game.js";', "EXTERNAL_DEPENDENCY"],
    ['import "some-game-backend";', "EXTERNAL_DEPENDENCY"],
    ['import "./missing.js";', "MISSING_DEPENDENCY"],
    ['new URL("../server-private/marker.js", import.meta.url);', "PRIVATE_DEPENDENCY"],
  ] as const;
  await temporary(async (source) => {
    for (const [code, expected] of examples) {
      await writeFile(path.join(source, "client/main.js"), code);
      await assert.rejects(() => createRelease(source, selected), hasCode(expected));
    }
    await mkdir(path.join(source, "public-simulation"));
    await writeFile(path.join(source, "client/main.js"), 'import "../public-simulation/sim.js";');
    await writeFile(path.join(source, "public-simulation/sim.js"), 'import "../server-private/marker.js";');
    await assert.rejects(() => createRelease(source, selected), hasCode("PRIVATE_DEPENDENCY"));
  });
});

test("release rejects unsafe paths, symbolic links and source map source disclosure", async () => {
  for (const name of ["../secret", "/client/main.js", "client/../server-private/x.js", "client/%2e%2e/private.js", "client\\main.js", "client/a.js?secret=1", "client/./main.js", "client/a:b.js"]) assert.throws(() => normalizeArtifactPath(name), hasCode("ARTIFACT_PATH"));
  await temporary(async (source) => {
    await symlink(path.join(source, "server-private/marker.js"), path.join(source, "client/link.js"));
    await assert.rejects(() => createRelease(source, selected), hasCode("SYMLINK_ARTIFACT"));
    await rm(path.join(source, "client/link.js"));
    await writeFile(path.join(source, "client/main.js.map"), JSON.stringify({ version: 3, sources: ["../server-private/marker.ts"], sourcesContent: ["private answer"] }));
    await assert.rejects(() => createRelease(source, selected), hasCode("PRIVATE_SOURCE_MAP"));
  });
});

test("release HTML and CSS require registered external scripts and styles compatible with CSP", async () => {
  await temporary(async (source) => {
    const htmlPath = path.join(source, "client/index.html"), original = await readFile(htmlPath, "utf8");
    for (const html of [
      '<script>alert("inline")</script>', '<style>body{color:red}</style>',
      '<body onload="alert(1)"></body>', '<img src=https://unregistered.example/pixel>',
      '<script src="https://unregistered.example/main.js"></script>', '<base href="https://unregistered.example">',
    ]) {
      await writeFile(htmlPath, html);
      await assert.rejects(() => createRelease(source, selected), (error: unknown) => error instanceof ReleaseError && ["CSP_INCOMPATIBLE", "EXTERNAL_DEPENDENCY"].includes(error.code));
    }
    await writeFile(htmlPath, original);
    await writeFile(path.join(source, "client/style.css"), 'body { background: url("https://unregistered.example/pixel"); }');
    await assert.rejects(() => createRelease(source, selected), hasCode("EXTERNAL_DEPENDENCY"));
  });
});

test("release CLI prepares a real filesystem bundle without deploying or mutating source", async () => {
  await temporary(async (source, output) => {
    const sourceBefore = await readFile(path.join(source, "game-package.json"), "utf8");
    await releaseCli(["--source", source, "--output", output, "--game-domain", selected.gameDomain, "--asset-origin", selected.assetOrigin]);
    const folders = await readdir(output);
    assert.equal(folders.length, 1);
    const manifest = JSON.parse(await readFile(path.join(output, folders[0]!, "manifest.json"), "utf8")) as PreparedRelease["manifest"];
    assert.equal(folders[0], manifest.gameBuildId);
    assert.equal(await readFile(path.join(source, "game-package.json"), "utf8"), sourceBefore);
  });
});
