import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { canonicalize, parseJson, ReleaseError } from "./canonical.js";
export { canonicalize, parseJson, ReleaseError } from "./canonical.js";

export type ArtifactScope = "client" | "public-simulation" | "server-private" | "assets";
export type ProfileId = "server-turn" | "server-snapshot" | "deterministic-lockstep" | "duel-rollback" | "peer-host-snapshot";
export interface VersionRange { readonly min: number; readonly max: number }
export interface CodecDeclaration { readonly id: string; readonly version: number }
export interface GamePackageDefinition {
  readonly formatVersion: 1;
  readonly gameId: string;
  readonly sdk: VersionRange;
  readonly protocol: VersionRange;
  readonly profile: { readonly id: ProfileId; readonly version: number };
  readonly rules: { readonly id: string; readonly version: number };
  readonly schemas: { readonly command: string | null; readonly input: string | null; readonly publicState: string; readonly privateState: string | null };
  readonly codecs: { readonly command: CodecDeclaration | null; readonly input: (CodecDeclaration & { readonly bytes: number }) | null; readonly state: CodecDeclaration };
  readonly entries: { readonly client: string; readonly publicSimulation: string | null; readonly serverPrivate: string | null };
  /** Declarations, not a claim that an engine/browser capability has passed runtime tests. */
  readonly browserCapabilities: readonly string[];
  readonly budgets: {
    readonly peakInputRateHz: number; readonly stateRateHz: number; readonly maxFrameBytes: number;
    readonly historyBytes: number; readonly rollbackWindowTicks: number; readonly maxStepCpuMs: number;
    readonly maxMemoryBytes: number; readonly maxQueuedBytes: number; readonly maxBulkBytes: number;
    readonly maxConcurrentBulk: number;
  };
  readonly recovery: { readonly checkpoints: boolean; readonly commandLog: boolean; readonly inputHistory: boolean; readonly spectating: boolean; readonly midMatchJoin: boolean };
  readonly requiredAssets: readonly string[];
}
export interface ArtifactDescriptor {
  readonly path: string;
  readonly scope: ArtifactScope;
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
}
export interface ReleaseIdentity extends GamePackageDefinition { readonly artifacts: readonly ArtifactDescriptor[] }
export interface GameReleaseManifest {
  readonly identity: ReleaseIdentity;
  readonly gameBuildId: string;
  readonly buildHostLabel: string;
  readonly frameOrigin: string;
  readonly entryUrl: string;
}
export interface BrowserReleaseManifest {
  readonly gameId: string;
  readonly gameBuildId: string;
  readonly buildHostLabel: string;
  readonly frameOrigin: string;
  readonly entryUrl: string;
  readonly sdk: VersionRange;
  readonly protocol: VersionRange;
  readonly profile: GamePackageDefinition["profile"];
  readonly browserCapabilities: readonly string[];
  readonly budgets: GamePackageDefinition["budgets"];
  readonly recovery: GamePackageDefinition["recovery"];
  readonly assets: readonly (ArtifactDescriptor & { readonly url: string })[];
  readonly requiredAssets: readonly string[];
}
export interface ReleaseFile { readonly descriptor: ArtifactDescriptor; readonly content: Uint8Array }
export interface PreparedRelease {
  readonly sourceDirectory: string;
  readonly manifest: GameReleaseManifest;
  readonly browserManifest: BrowserReleaseManifest;
  readonly files: readonly ReleaseFile[];
}
export interface ReleaseOrigins { readonly gameDomain: string; readonly assetOrigin: string }

const SCOPES: readonly ArtifactScope[] = ["client", "public-simulation", "server-private", "assets"];
const PROFILES = ["server-turn", "server-snapshot", "deterministic-lockstep", "duel-rollback", "peer-host-snapshot"];
const CAPABILITIES = ["wasm", "threads", "audio", "fullscreen", "gamepad", "pointer-lock"];
const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".pck": "application/octet-stream", ".bin": "application/octet-stream", ".glb": "model/gltf-binary",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
};
const SHA = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");
function reject(code: string, detail: string): never { throw new ReleaseError(code, detail); }
function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("MANIFEST_SCHEMA", field);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) reject("MANIFEST_SCHEMA", `${field} fields`);
  return result;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 1024) reject("MANIFEST_SCHEMA", field);
  return value;
}
function numeric(value: unknown, minimum: number, maximum: number, field: string, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) reject("MANIFEST_SCHEMA", field);
  return value;
}
function range(value: unknown, field: string): void {
  const r = record(value, ["min", "max"], field);
  const min = numeric(r["min"], 1, 65535, `${field}.min`), max = numeric(r["max"], 1, 65535, `${field}.max`);
  if (min > max) reject("MANIFEST_SCHEMA", `${field} reversed range`);
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 4096 || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) reject("MANIFEST_SCHEMA", field);
  return value as string[];
}

/** Paths are already decoded portable package paths, never URLs or platform-native paths. */
export function normalizeArtifactPath(value: string): string {
  if (!value || value.length > 2048 || value !== value.normalize("NFC") || /[\\%?#:\x00-\x20\x7f]/.test(value) || value.startsWith("/") || value.endsWith("/")) reject("ARTIFACT_PATH", "noncanonical artifact path");
  const segments = value.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" "))) reject("ARTIFACT_PATH", "unsafe path segment");
  if (!SCOPES.includes(segments[0] as ArtifactScope) || segments.length < 2) reject("ARTIFACT_PATH", "artifact outside declared scopes");
  return value;
}
function scopeOf(name: string): ArtifactScope { return normalizeArtifactPath(name).split("/")[0] as ArtifactScope; }
function codec(value: unknown, field: string, input = false): void {
  if (value === null) return;
  const obj = record(value, input ? ["id", "version", "bytes"] : ["id", "version"], field);
  text(obj["id"], `${field}.id`); numeric(obj["version"], 1, 65535, `${field}.version`);
  if (input) numeric(obj["bytes"], 1, 65535, `${field}.bytes`);
}
export function validateDefinition(value: unknown): GamePackageDefinition {
  // JCS also rejects non-JSON values, getters, exotic prototypes and invalid Unicode.
  canonicalize(value);
  const def = record(value, ["formatVersion", "gameId", "sdk", "protocol", "profile", "rules", "schemas", "codecs", "entries", "browserCapabilities", "budgets", "recovery", "requiredAssets"], "package");
  if (def["formatVersion"] !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(text(def["gameId"], "gameId"))) reject("MANIFEST_SCHEMA", "formatVersion or gameId");
  range(def["sdk"], "sdk"); range(def["protocol"], "protocol");
  const protocol = def["protocol"] as VersionRange;
  if (protocol.min !== 1 || protocol.max !== 1) reject("PROTOCOL_VERSION", "only protocol 1 is implemented");
  const profile = record(def["profile"], ["id", "version"], "profile");
  if (!PROFILES.includes(text(profile["id"], "profile.id"))) reject("MANIFEST_SCHEMA", "unknown profile");
  numeric(profile["version"], 1, 65535, "profile.version");
  const rules = record(def["rules"], ["id", "version"], "rules"); text(rules["id"], "rules.id"); numeric(rules["version"], 1, 65535, "rules.version");
  const schemas = record(def["schemas"], ["command", "input", "publicState", "privateState"], "schemas");
  for (const key of Object.keys(schemas)) if (key === "publicState" || schemas[key] !== null) text(schemas[key], `schemas.${key}`);
  const codecs = record(def["codecs"], ["command", "input", "state"], "codecs");
  codec(codecs["command"], "codecs.command"); codec(codecs["input"], "codecs.input", true); codec(codecs["state"], "codecs.state");
  if (codecs["state"] === null || (schemas["command"] === null) !== (codecs["command"] === null) || (schemas["input"] === null) !== (codecs["input"] === null)) reject("MANIFEST_SCHEMA", "codec/schema mismatch");
  const entries = record(def["entries"], ["client", "publicSimulation", "serverPrivate"], "entries");
  for (const [key, scope] of [["client", "client"], ["publicSimulation", "public-simulation"], ["serverPrivate", "server-private"]] as const) {
    if (key !== "client" && entries[key] === null) continue;
    const entry = normalizeArtifactPath(text(entries[key], `entries.${key}`));
    if (scopeOf(entry) !== scope) reject("MANIFEST_SCHEMA", `entries.${key} scope`);
    if ((key === "client" && path.posix.extname(entry) !== ".html") || (key !== "client" && ![".js", ".mjs"].includes(path.posix.extname(entry)))) reject("MANIFEST_SCHEMA", `entries.${key} type`);
  }
  const caps = strings(def["browserCapabilities"], "browserCapabilities");
  if (caps.some(cap => !CAPABILITIES.includes(cap)) || (caps.includes("threads") && !caps.includes("wasm"))) reject("MANIFEST_SCHEMA", "unsupported browser capability declaration");
  const budgets = record(def["budgets"], ["peakInputRateHz", "stateRateHz", "maxFrameBytes", "historyBytes", "rollbackWindowTicks", "maxStepCpuMs", "maxMemoryBytes", "maxQueuedBytes", "maxBulkBytes", "maxConcurrentBulk"], "budgets");
  for (const key of ["peakInputRateHz", "stateRateHz", "historyBytes", "rollbackWindowTicks", "maxBulkBytes", "maxConcurrentBulk"]) numeric(budgets[key], 0, Number.MAX_SAFE_INTEGER, `budgets.${key}`);
  numeric(budgets["maxFrameBytes"], 32, 16384, "budgets.maxFrameBytes");
  numeric(budgets["maxStepCpuMs"], Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, "budgets.maxStepCpuMs", false);
  for (const key of ["maxMemoryBytes", "maxQueuedBytes"]) numeric(budgets[key], 1, Number.MAX_SAFE_INTEGER, `budgets.${key}`);
  const recovery = record(def["recovery"], ["checkpoints", "commandLog", "inputHistory", "spectating", "midMatchJoin"], "recovery");
  if (Object.values(recovery).some(flag => typeof flag !== "boolean")) reject("MANIFEST_SCHEMA", "recovery declarations must be booleans");
  for (const asset of strings(def["requiredAssets"], "requiredAssets")) {
    normalizeArtifactPath(asset);
    if (scopeOf(asset) === "server-private") reject("PRIVATE_DEPENDENCY", "private required client asset");
  }
  // Fixed data snapshot: later configuration edits cannot change a prepared release identity.
  return JSON.parse(canonicalize(value)) as GamePackageDefinition;
}

export function digestToBase32(hexDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(hexDigest)) reject("BUILD_DIGEST", "full lowercase SHA-256 required");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let pending = 0, bitCount = 0, output = "";
  for (const byte of Buffer.from(hexDigest, "hex")) {
    pending = (pending << 8) | byte; bitCount += 8;
    while (bitCount >= 5) { bitCount -= 5; output += alphabet[(pending >>> bitCount) & 31]; }
    pending &= (1 << bitCount) - 1;
  }
  if (bitCount) output += alphabet[(pending << (5 - bitCount)) & 31];
  return output;
}
function origins(options: ReleaseOrigins): ReleaseOrigins {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.gameDomain)) reject("RELEASE_ORIGIN", "gameDomain must be a lowercase DNS suffix");
  let asset: URL;
  try { asset = new URL(options.assetOrigin); } catch { return reject("RELEASE_ORIGIN", "invalid asset origin"); }
  if (asset.protocol !== "https:" || asset.origin !== options.assetOrigin || asset.username || asset.password) reject("RELEASE_ORIGIN", "exact HTTPS asset origin required");
  return options;
}
function isWithin(root: string, candidate: string): boolean { const rel = path.relative(root, candidate); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }

async function collect(directory: string, relative = ""): Promise<ReleaseFile[]> {
  const files: ReleaseFile[] = [];
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (name === "game-package.json") continue;
    const absolute = path.join(directory, name), stat = await lstat(absolute);
    if (stat.isSymbolicLink()) reject("SYMLINK_ARTIFACT", "symbolic links are not publication inputs");
    if (!(isWithin(directory, await realpath(absolute)))) reject("ARTIFACT_PATH", "file escapes source directory");
    if (stat.isDirectory()) {
      const first = name.split("/")[0];
      if (!SCOPES.includes(first as ArtifactScope)) reject("ARTIFACT_PATH", "unknown top-level source directory");
      files.push(...await collect(directory, name));
      continue;
    }
    if (!stat.isFile()) reject("ARTIFACT_PATH", "only regular files are supported");
    normalizeArtifactPath(name);
    const mime = MIME[path.posix.extname(name).toLowerCase()];
    if (!mime) reject("ARTIFACT_MIME", "undeclared file type");
    const content = new Uint8Array(await readFile(absolute));
    const descriptor: ArtifactDescriptor = { path: name, scope: scopeOf(name), sha256: SHA(content), bytes: content.byteLength, mime };
    files.push({ descriptor, content });
  }
  return files;
}

function utf8(file: ReleaseFile): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.content); }
  catch { return reject("ARTIFACT_ENCODING", "text asset is not UTF-8"); }
}
function dependency(from: string, specifier: string, available: ReadonlySet<string>): string | undefined {
  // Fragment-only document links do not load code or another resource.
  if (specifier.startsWith("#")) return undefined;
  if (!specifier || /[\\%?#:\x00-\x20\x7f]/.test(specifier) || specifier.startsWith("/") || (!specifier.startsWith("./") && !specifier.startsWith("../"))) reject("EXTERNAL_DEPENDENCY", "only explicit relative registered dependencies are supported");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  normalizeArtifactPath(resolved);
  if (scopeOf(resolved) === "server-private" && scopeOf(from) !== "server-private") reject("PRIVATE_DEPENDENCY", "public code references server-private");
  if (!available.has(resolved)) reject("MISSING_DEPENDENCY", "dependency is not registered in the package");
  return resolved;
}
function auditJs(file: ReleaseFile, available: ReadonlySet<string>): void {
  const source = utf8(file), parsed = ts.createSourceFile(file.descriptor.path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics?.length) reject("ARTIFACT_SYNTAX", "invalid emitted JavaScript");
  function literal(node: ts.Expression | undefined): string | undefined {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  }
  function check(specifier: string): void { dependency(file.descriptor.path, specifier, available); }
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) reject("DYNAMIC_DEPENDENCY", "nonliteral module specifier");
      check(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && ["require", "importScripts"].includes(node.expression.text)))) {
      if (node.arguments.length < 1) reject("DYNAMIC_DEPENDENCY", "missing module dependency");
      for (const argument of node.arguments) {
        const specifier = literal(argument);
        if (specifier === undefined) reject("DYNAMIC_DEPENDENCY", "module dependencies must be statically registered");
        check(specifier);
      }
    }
    // A literal new URL is commonly used by emitted Worker/WASM loaders.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const specifier = literal(node.arguments?.[0]);
      if (specifier !== undefined) check(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  for (const match of source.matchAll(/(?:sourceMappingURL|sourceURL)\s*=\s*(\S+)/g)) if (match[1]) dependency(file.descriptor.path, match[1], available);
}
function auditHtml(file: ReleaseFile, available: ReadonlySet<string>): void {
  const source = utf8(file);
  if (/<\s*(?:base|iframe|object|embed|form)\b/i.test(source) || /<\s*style\b/i.test(source) || /\b(?:on[a-z]+|style)\s*=/i.test(source) || /<\s*meta\b[^>]*http-equiv\s*=/i.test(source)) reject("CSP_INCOMPATIBLE", "HTML requires the platform external-script/style template");
  if (/\b(?:src|href|poster)\s*=\s*[^\s"'<>]/i.test(source)) reject("CSP_INCOMPATIBLE", "resource references must use quoted canonical paths");
  let scripts = 0;
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    scripts++;
    const attrs = match[1] ?? "", body = match[2] ?? "";
    const src = /\bsrc\s*=\s*(?:"([^"&<>]+)"|'([^'&<>]+)')/i.exec(attrs);
    if (!src || body.trim() || /\bsrc\s*=/gi[Symbol.match](attrs)?.length !== 1) reject("CSP_INCOMPATIBLE", "scripts must use one quoted external src and no inline body");
    dependency(file.descriptor.path, src[1] ?? src[2] ?? "", available);
  }
  if ((source.match(/<script\b/gi)?.length ?? 0) !== scripts) reject("CSP_INCOMPATIBLE", "noncanonical script markup");
  for (const match of source.matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gi)) {
    const reference = match[1] ?? match[2] ?? "";
    if (reference.includes("&")) reject("ARTIFACT_PATH", "encoded HTML resource references are not canonical");
    dependency(file.descriptor.path, reference, available);
  }
}
function auditCss(file: ReleaseFile, available: ReadonlySet<string>): void {
  const source = utf8(file);
  if (/\\|@import\s+[^"'u\s]/i.test(source)) reject("CSP_INCOMPATIBLE", "CSS escapes and ambiguous imports are not supported");
  for (const match of source.matchAll(/url\(\s*(?:"([^"()]*)"|'([^'()]*)'|([^\s()"']+))\s*\)|@import\s+(?:"([^"']+)"|'([^"']+)')/gi)) {
    dependency(file.descriptor.path, match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "", available);
  }
}
function auditSourceMap(file: ReleaseFile): void {
  const map = parseJson(utf8(file));
  if (typeof map !== "object" || map === null || Array.isArray(map)) reject("SOURCE_MAP", "invalid source map");
  const data = map as Record<string, unknown>;
  if (data["sourcesContent"] !== undefined && data["sourcesContent"] !== null && (!Array.isArray(data["sourcesContent"]) || data["sourcesContent"].some(content => content !== null))) reject("PRIVATE_SOURCE_MAP", "public source maps may not embed source content");
  if (!Array.isArray(data["sources"]) || data["sources"].some(source => typeof source !== "string" || /(?:^|[\/\\])server-private(?:[\/\\]|$)/.test(source) || /^(?:https?:|data:|\/|[A-Za-z]:)/.test(source))) reject("PRIVATE_SOURCE_MAP", "unsafe source map source paths");
  if (data["sourceRoot"] !== undefined && data["sourceRoot"] !== "") reject("PRIVATE_SOURCE_MAP", "sourceRoot must not redirect source locations");
}

/** Static publication checks complement CSP/runtime isolation; they are not a malicious-code proof. */
export function auditArtifacts(files: readonly ReleaseFile[], definition: GamePackageDefinition): void {
  const available = new Set(files.map(file => file.descriptor.path));
  if (available.size !== files.length) reject("ARTIFACT_PATH", "duplicate artifact path");
  for (const entry of Object.values(definition.entries)) if (entry !== null && !available.has(entry)) reject("MISSING_ENTRY", "declared entry is absent");
  for (const asset of definition.requiredAssets) if (!available.has(asset)) reject("MISSING_DEPENDENCY", "required asset is absent");
  for (const file of files) {
    if (file.descriptor.scope === "server-private") continue;
    const extension = path.posix.extname(file.descriptor.path).toLowerCase();
    if ([".js", ".mjs"].includes(extension)) auditJs(file, available);
    if (extension === ".html") auditHtml(file, available);
    if (extension === ".css") auditCss(file, available);
    if (extension === ".map") auditSourceMap(file);
    // SVG is active markup; the first release pipeline permits raster images instead.
    if (extension === ".svg") reject("CSP_INCOMPATIBLE", "active SVG assets require a separately validated export profile");
  }
}

export async function createRelease(sourceDirectory: string, selectedOrigins: ReleaseOrigins): Promise<PreparedRelease> {
  const options = origins(selectedOrigins), source = await realpath(sourceDirectory), sourceStat = await lstat(sourceDirectory);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) reject("SYMLINK_ARTIFACT", "source root must be a real directory");
  const definitionPath = path.join(source, "game-package.json"), definitionStat = await lstat(definitionPath);
  if (!definitionStat.isFile() || definitionStat.isSymbolicLink() || definitionStat.size > 65536) reject("MANIFEST_SCHEMA", "invalid package definition file");
  const definition = validateDefinition(parseJson(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(definitionPath))));
  const files = (await collect(source)).sort((left, right) => left.descriptor.path < right.descriptor.path ? -1 : left.descriptor.path > right.descriptor.path ? 1 : 0);
  if (files.length === 0 || files.length > 4096) reject("ARTIFACT_BUDGET", "package must contain 1..4096 artifacts");
  auditArtifacts(files, definition);
  const identity: ReleaseIdentity = { ...definition, artifacts: files.map(file => file.descriptor) };
  const gameBuildId = SHA(canonicalize(identity)), buildHostLabel = `b-${digestToBase32(gameBuildId)}`;
  if (`${buildHostLabel}.${options.gameDomain}`.length > 253) reject("RELEASE_ORIGIN", "derived hostname is too long");
  const frameOrigin = `https://${buildHostLabel}.${options.gameDomain}`, entryUrl = `${frameOrigin}/${definition.entries.client}`;
  const manifest: GameReleaseManifest = { identity, gameBuildId, buildHostLabel, frameOrigin, entryUrl };
  const browserManifest: BrowserReleaseManifest = {
    gameId: definition.gameId, gameBuildId, buildHostLabel, frameOrigin, entryUrl,
    sdk: definition.sdk, protocol: definition.protocol, profile: definition.profile,
    browserCapabilities: definition.browserCapabilities, budgets: definition.budgets, recovery: definition.recovery,
    requiredAssets: definition.requiredAssets,
    assets: files.filter(file => file.descriptor.scope !== "server-private").map(file => ({ ...file.descriptor,
      url: file.descriptor.scope === "assets" ? `${options.assetOrigin}/${definition.gameId}/${gameBuildId}/${file.descriptor.path}` : `${frameOrigin}/${file.descriptor.path}`,
    })),
  };
  return { sourceDirectory: source, manifest, browserManifest, files };
}

async function canonicalOutputDirectory(directory: string): Promise<string> {
  const requested = path.resolve(directory);
  try { if ((await lstat(requested)).isSymbolicLink()) reject("OUTPUT_PATH", "output root may not be a symbolic link"); }
  catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  let ancestor = requested;
  const missing: string[] = [];
  while (true) {
    try { return path.join(await realpath(ancestor), ...missing); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}

export async function writeRelease(release: PreparedRelease, outputDirectory: string): Promise<{ readonly directory: string; readonly reused: boolean }> {
  const output = await canonicalOutputDirectory(outputDirectory), source = await realpath(release.sourceDirectory);
  if (isWithin(source, output) || isWithin(output, source)) reject("OUTPUT_PATH", "output must be separate from source");
  if (SHA(canonicalize(release.manifest.identity)) !== release.manifest.gameBuildId) reject("BUILD_DIGEST", "prepared identity was changed");
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) reject("OUTPUT_PATH", "output root may not be a symbolic link");
  const finalDirectory = path.join(output, release.manifest.gameBuildId), manifestBytes = canonicalize(release.manifest), browserBytes = canonicalize(release.browserManifest);
  try {
    const current = await readFile(path.join(finalDirectory, "manifest.json"), "utf8");
    if (current !== manifestBytes) reject("IMMUTABLE_RELEASE", "existing build has a different deployment manifest");
    for (const file of release.files) {
      const tree = file.descriptor.scope === "server-private" ? "private" : "public";
      const saved = await readFile(path.join(finalDirectory, tree, file.descriptor.path));
      if (SHA(saved) !== file.descriptor.sha256) reject("IMMUTABLE_RELEASE", "existing artifact does not match registered hash");
    }
    if ((await readFile(path.join(finalDirectory, "public/browser-manifest.json"), "utf8")) !== browserBytes) reject("IMMUTABLE_RELEASE", "existing browser manifest differs");
    return { directory: finalDirectory, reused: true };
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    // A partially populated existing build must never be overwritten or repaired in place.
    try { await lstat(finalDirectory); reject("IMMUTABLE_RELEASE", "existing build directory is incomplete"); }
    catch (existing: unknown) { if (!(existing instanceof Error && "code" in existing && existing.code === "ENOENT")) throw existing; }
  }
  const staging = path.join(output, `.staging-${release.manifest.gameBuildId}-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of release.files) {
      if (file.content.byteLength !== file.descriptor.bytes || SHA(file.content) !== file.descriptor.sha256) reject("BUILD_DIGEST", "prepared artifact content was changed");
      normalizeArtifactPath(file.descriptor.path);
      const tree = file.descriptor.scope === "server-private" ? "private" : "public";
      const target = path.join(staging, tree, file.descriptor.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
    }
    await mkdir(path.join(staging, "public"), { recursive: true });
    await writeFile(path.join(staging, "manifest.json"), manifestBytes, { flag: "wx" });
    await writeFile(path.join(staging, "public/browser-manifest.json"), browserBytes, { flag: "wx" });
    await rename(staging, finalDirectory);
    return { directory: finalDirectory, reused: false };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
