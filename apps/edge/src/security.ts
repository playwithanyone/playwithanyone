import type { Env } from "./env.js";

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly scope = "platform", readonly retryable = false) { super(code); }
}
export function exactOrigin(value: string, fixture: boolean): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ApiError("CONFIG_REQUIRED", 503); }
  if (parsed.origin !== value || (parsed.protocol !== "https:" && !(fixture && parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)))) throw new ApiError("CONFIG_INVALID", 503);
  return parsed.origin;
}
function listOrigins(value: string, fixture: boolean): string[] {
  if (typeof value !== "string") throw new ApiError("CONFIG_REQUIRED", 503);
  return value === "" ? [] : value.split(",").map(origin => exactOrigin(origin, fixture));
}
export function deployment(env: Env): { shell: string; games: string[]; assets: string[] } {
  if (!["shell", "game", "assets"].includes(env.WORKER_ROLE) || !["fixture", "preview", "production"].includes(env.APP_ENV)) throw new ApiError("CONFIG_REQUIRED", 503);
  const fixture = env.APP_ENV === "fixture";
  const shell = exactOrigin(env.SHELL_ORIGIN, fixture);
  const games = listOrigins(env.GAME_ORIGINS, fixture), assets = listOrigins(env.ASSET_ORIGINS, fixture);
  if (games.includes(shell) || assets.includes(shell)) throw new ApiError("CONFIG_INVALID", 503);
  return { shell, games, assets };
}
export function responseHeaders(env: Env, role: "shell" | "game" | "assets" = env.WORKER_ROLE): Headers {
  const origins = deployment(env);
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
    "Origin-Agent-Cluster": "?1", "Cache-Control": "no-store",
    "Permissions-Policy": `cross-origin-isolated=(self ${origins.games.map(origin => `"${origin}"`).join(" ")}), fullscreen=(self ${origins.games.map(origin => `"${origin}"`).join(" ")}), camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), midi=(), clipboard-read=(), clipboard-write=${role === "shell" ? "(self)" : "()"}`,
  });
  const source = role === "shell" ? `'self'` : `'self' 'wasm-unsafe-eval'`;
  let roomOrigins: string[] = [];
  if (env.ROOM_ROUTING_JSON) {
    try { const routing = JSON.parse(env.ROOM_ROUTING_JSON) as { allowedWebSocketOrigins?: unknown };
      if (!Array.isArray(routing.allowedWebSocketOrigins) || routing.allowedWebSocketOrigins.some(value => typeof value !== "string" || !/^wss?:\/\//.test(value) || new URL(value).origin !== value)) throw new Error("Invalid origins");
      roomOrigins = routing.allowedWebSocketOrigins as string[];
    } catch { throw new ApiError("ROOM_ROUTING_INVALID", 503); }
  }
  const websocket = [...new Set([origins.shell.replace(/^http/, "ws"), ...roomOrigins])].join(" ");
  const connect = role === "shell" ? `'self' ${websocket} ${origins.assets.join(" ")}` : `'self' ${origins.assets.join(" ")}`;
  headers.set("Content-Security-Policy", [
    "default-src 'none'", `script-src ${source}`, "script-src-attr 'none'", "style-src 'self'", "style-src-attr 'none'",
    `connect-src ${connect.trim()}`, `img-src 'self' ${origins.assets.join(" ")} data: blob:`,
    `media-src 'self' ${origins.assets.join(" ")} blob:`, `font-src 'self' ${origins.assets.join(" ")}`,
    "worker-src 'self' blob:", `frame-src ${role === "shell" && origins.games.length ? origins.games.join(" ") : "'none'"}`,
    "object-src 'none'", "base-uri 'none'", `form-action ${role === "shell" ? "'self'" : "'none'"}`,
    `frame-ancestors ${role === "shell" ? "'none'" : origins.shell}`, "manifest-src 'self'",
    ...(env.APP_ENV === "fixture" ? [] : ["upgrade-insecure-requests"]),
  ].join("; "));
  if (role !== "shell") headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  if (env.APP_ENV !== "fixture") headers.set("Strict-Transport-Security", "max-age=31536000");
  if (role === "assets") {
    // This shared origin serves passive public files, never an application or Worker.
    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'none'; style-src-attr 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Expose-Headers", "Content-Length, ETag");
  }
  return headers;
}
export function enforceOrigin(request: Request, env: Env, mutating: boolean): void {
  const { shell } = deployment(env);
  if (new URL(request.url).origin !== shell) throw new ApiError("ORIGIN_REJECTED", 403, "auth");
  const origin = request.headers.get("Origin"), site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== shell) || (site !== null && site !== "same-origin" && site !== "none")) throw new ApiError("ORIGIN_REJECTED", 403, "auth");
  if (mutating && (origin !== shell || request.headers.get("X-PWA-Request") !== "1" || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json")) throw new ApiError("CSRF_REJECTED", 403, "auth");
}
export async function readObject(request: Request, maximumBytes = 4096): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("INVALID_REQUEST", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) { await reader.cancel(); throw new ApiError("REQUEST_TOO_LARGE", 413); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); } catch { throw new ApiError("INVALID_REQUEST", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", 400);
  return value as Record<string, unknown>;
}
export function jsonResponse(value: unknown, env: Env, status = 200): Response {
  const headers = responseHeaders(env); headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}
