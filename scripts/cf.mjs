// Project-scoped Wrangler authentication. The token stays outside the repository
// and is inherited only by this child process, never by the global shell.
import { chmod, lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/cf.mjs <wrangler arguments>");
  process.exitCode = 2;
} else {
  let token;
  try {
    const tokenFile = process.env.PWA_CF_TOKEN_FILE || path.join(homedir(), "cftk.ks");
    const metadata = await lstat(tokenFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
    await chmod(tokenFile, 0o600);
    token = (await readFile(tokenFile, "utf8")).trim().replace(/^(['"])(.*)\1$/s, "$2");
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error();
  } catch {
    token = undefined;
    console.error("CLOUDFLARE_TOKEN_FILE_UNAVAILABLE_OR_INVALID");
    process.exitCode = 1;
  }
  if (token) {
    const config = JSON.parse(await readFile(new URL("../configs/cloud/resources.json", import.meta.url), "utf8"));
    const result = spawnSync(process.env.PWA_WRANGLER_BIN || "wrangler", args, {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: config.accountId },
      encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
    const redact = value => (value || "").replaceAll(token, "[REDACTED]");
    process.stdout.write(redact(result.stdout));
    process.stderr.write(redact(result.stderr));
    if (result.error) console.error("WRANGLER_PROCESS_FAILED_OR_TIMED_OUT");
    process.exitCode = result.status ?? 1;
  }
}
