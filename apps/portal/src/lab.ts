import {
  PresentationHost, parseAssetReference, assertOrigin, isBuild, isId,
  type AssetReference, type PresentationGrant, type SdkCapability,
} from "../../../packages/sdk/src/index.js";

interface Session { readonly id: string; readonly playerId: string; readonly expiresAt: number }
interface LoaderRelease {
  readonly gameBuildId: string;
  readonly frameOrigin: string;
  readonly entryUrl: string;
  readonly assets: ReadonlyMap<string, AssetReference>;
}
interface ActiveLab {
  readonly session: Session;
  readonly release: LoaderRelease;
  readonly request: AbortController;
  host?: PresentationHost;
  iframe?: HTMLIFrameElement;
  revoked: boolean;
  revision: number;
}
type LabState = "idle" | "starting" | "loading" | "connected" | "ready" | "revoked" | "error";
const preloadCapabilities: readonly SdkCapability[] = ["ready", "state.subscribe", "assets.resolve"];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readJson(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: {
    Accept: "application/json", ...(options.method === "POST" ? { "Content-Type": "application/json", "X-PWA-Request": "1" } : {}),
  } });
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = object(body) && object(body["error"]) && typeof body["error"]["code"] === "string" ? body["error"]["code"] : `HTTP_${response.status}`;
    throw new Error(code);
  }
  return body;
}
function sessionValue(value: unknown): Session {
  if (!object(value) || !object(value["session"])) throw new Error("SESSION_SCHEMA");
  const session = value["session"];
  if (!isId(session["id"]) || !isId(session["playerId"]) || typeof session["expiresAt"] !== "number" || !Number.isFinite(session["expiresAt"]) || session["expiresAt"] <= Date.now()) throw new Error("SESSION_SCHEMA");
  return { id: session["id"], playerId: session["playerId"], expiresAt: session["expiresAt"] };
}
function releaseValue(value: unknown): LoaderRelease {
  if (!object(value) || !object(value["release"])) throw new Error("RELEASE_SCHEMA");
  const release = value["release"];
  if (!isBuild(release["gameBuildId"]) || typeof release["frameOrigin"] !== "string" || typeof release["entryUrl"] !== "string" || !Array.isArray(release["assets"]) || release["assets"].length > 4096) throw new Error("RELEASE_SCHEMA");
  assertOrigin(release["frameOrigin"]);
  const entry = new URL(release["entryUrl"]);
  if (entry.origin !== release["frameOrigin"] || entry.origin === location.origin || entry.search || entry.hash || entry.username || entry.password) throw new Error("RELEASE_ORIGIN");
  const assets = new Map<string, AssetReference>();
  for (const item of release["assets"]) {
    if (!object(item) || item["scope"] === "server-private") throw new Error("RELEASE_SCHEMA");
    const asset = parseAssetReference({ path: item["path"], url: item["url"], sha256: item["sha256"], bytes: item["bytes"], mime: item["mime"] });
    if (assets.has(asset.path)) throw new Error("RELEASE_SCHEMA");
    assets.set(asset.path, asset);
  }
  if (![...assets.values()].some(asset => asset.url === entry.href) || !assets.has("assets/sample.json")) throw new Error("RELEASE_SCHEMA");
  return { gameBuildId: release["gameBuildId"], frameOrigin: release["frameOrigin"], entryUrl: entry.href, assets };
}
function grantValue(value: unknown, session: Session): PresentationGrant {
  if (!object(value) || value["sessionId"] !== session.id || !isId(value["bindingId"]) || typeof value["expiresAt"] !== "number" || !Number.isFinite(value["expiresAt"]) || value["expiresAt"] <= Date.now() || value["expiresAt"] > session.expiresAt || !Array.isArray(value["capabilityIds"]) || value["capabilityIds"].length > preloadCapabilities.length || value["matchScope"] !== undefined) throw new Error("PRESENTATION_SCHEMA");
  const capabilities = value["capabilityIds"];
  if (new Set(capabilities).size !== capabilities.length || capabilities.some(capability => !preloadCapabilities.includes(capability as SdkCapability))) throw new Error("PRESENTATION_CAPABILITY");
  return { bindingId: value["bindingId"], sessionId: session.id, expiresAt: value["expiresAt"], capabilityIds: capabilities as SdkCapability[] };
}

/** Internal acceptance page only; no fixture is added to the formal game catalog. */
export function startLab(root: HTMLElement): () => void {
  const status = root.querySelector<HTMLElement>("#lab-status");
  const stage = root.querySelector<HTMLElement>("#lab-stage");
  if (!status || !stage) throw new Error("LAB_ROOT");
  stage.innerHTML = `<div class="lab-actions"><button class="button button-primary" id="lab-start" type="button">启动加载测试</button><button class="button button-outline" id="lab-reload" type="button" disabled>重载游戏页面</button><button class="button button-outline" id="lab-publish" type="button" disabled>发送公开状态</button><button class="button button-outline" id="lab-revoke" type="button" disabled>撤销会话</button></div><dl class="lab-details"><div><dt>固定构建</dt><dd id="lab-build">尚未加载</dd></div><div><dt>游戏来源</dt><dd id="lab-origin">尚未加载</dd></div></dl><div id="lab-frame-container"></div><ol class="lab-events" id="lab-events" aria-label="接入事件"></ol>`;
  const start = stage.querySelector<HTMLButtonElement>("#lab-start")!;
  const reload = stage.querySelector<HTMLButtonElement>("#lab-reload")!;
  const publish = stage.querySelector<HTMLButtonElement>("#lab-publish")!;
  const revoke = stage.querySelector<HTMLButtonElement>("#lab-revoke")!;
  const frameContainer = stage.querySelector<HTMLElement>("#lab-frame-container")!;
  const events = stage.querySelector<HTMLOListElement>("#lab-events")!;
  let active: ActiveLab | undefined;
  let pending: AbortController | undefined;
  let disposed = false;
  let revoking = false;

  function note(message: string): void {
    const item = document.createElement("li"); item.textContent = message; events.append(item);
    while (events.children.length > 8) events.firstElementChild?.remove();
  }
  function setState(state: LabState, message: string): void {
    root.dataset.labState = state;
    status!.textContent = message;
    start.disabled = revoking || state === "starting" || state === "loading";
    reload.disabled = revoking || !active || active.revoked;
    revoke.disabled = !active || active.revoked;
    publish.disabled = state !== "ready";
  }
  function closeActive(reason: string): void {
    pending?.abort(); pending = undefined;
    if (active) { active.revoked = true; active.request.abort(); active.host?.revoke(reason); active.host?.dispose(); }
    active = undefined;
    frameContainer.replaceChildren();
  }
  function reportError(error: unknown): void {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    setState("error", `加载验证没有完成：${code}。可以重试；此结果不代表游戏已经可用。`);
    note(`失败：${code}`);
  }
  function attachFrame(current: ActiveLab): void {
    const iframe = document.createElement("iframe");
    iframe.id = "lab-frame"; iframe.title = "平台 SDK 加载测试";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.setAttribute("allow", "cross-origin-isolated 'src'");
    iframe.referrerPolicy = "no-referrer";
    iframe.src = current.release.entryUrl;
    const host = new PresentationHost({
      iframe, frameOrigin: current.release.frameOrigin, gameBuildId: current.release.gameBuildId,
      assets: current.release.assets,
      authorize: async request => {
        if (active !== current || current.revoked) throw new Error("AUTH_REVOKED");
        return grantValue(await readJson("/api/presentations", { method: "POST", signal: request.signal, body: JSON.stringify({
          gameBuildId: request.gameBuildId, frameOrigin: request.frameOrigin, presentationInstanceId: request.presentationInstanceId,
        }) }), current.session);
      },
      isBindingCurrent: binding => active === current && !current.revoked && !disposed && binding.sessionId === current.session.id && binding.gameBuildId === current.release.gameBuildId && binding.frameOrigin === current.release.frameOrigin && current.session.expiresAt > Date.now(),
      handlers: { ready: () => {
        if (active !== current || current.revoked) throw new Error("AUTH_REVOKED");
        setState("ready", "SDK READY：跨来源握手、公开资源完整性校验与加载就绪已完成。该测试没有房间或游戏输入权限。");
        note("SDK READY：客户端已完成所需资源加载。");
      } },
      onStatus: (state, reason) => {
        if (active !== current || disposed) return;
        if (state === "CHALLENGING") { setState("loading", "游戏页面已加载，正在核对来源、构建与本次握手。"); note("已向当前游戏页面发出新的 SDK 挑战。"); }
        if (state === "CONNECTED") { setState("connected", "受限 SDK 端口已连接，等待客户端验证公开资源并报告就绪。"); note("端口确认完成；等待资源加载。"); }
        if (state === "REVOKED") { current.revoked = true; setState("revoked", `本次 SDK 绑定已撤销：${reason ?? "PRESENTATION_REVOKED"}。旧端口不能继续调用平台。`); note(`绑定已撤销：${reason ?? "PRESENTATION_REVOKED"}`); }
      },
    });
    current.host = host; current.iframe = iframe;
    frameContainer.replaceChildren(iframe);
  }
  async function begin(): Promise<void> {
    if (disposed || revoking) return;
    closeActive("RESTARTED");
    const request = new AbortController(); pending = request;
    setState("starting", "正在建立主站会话并读取已登记的测试构建…");
    try {
      const session = sessionValue(await readJson("/api/session", { method: "POST", body: "{}", signal: request.signal }));
      const release = releaseValue(await readJson("/api/fixtures/loader", { signal: request.signal }));
      if (request.signal.aborted || disposed || pending !== request) return;
      const current: ActiveLab = { session, release, request, revoked: false, revision: 0 };
      active = current; pending = undefined;
      stage!.querySelector<HTMLElement>("#lab-build")!.textContent = release.gameBuildId;
      stage!.querySelector<HTMLElement>("#lab-origin")!.textContent = release.frameOrigin;
      note("已从当前主站会话取得测试构建。会话凭据保留在主站。");
      setState("loading", "正在加载独立来源中的测试页面…");
      attachFrame(current);
    } catch (error) { if (!request.signal.aborted && !disposed) reportError(error); }
    finally { if (pending === request) pending = undefined; }
  }
  start.addEventListener("click", () => { void begin(); });
  reload.addEventListener("click", () => {
    if (!active || active.revoked || !active.iframe) return;
    note("重载页面，等待新的实例与绑定。");
    // Dispose the old port before navigation starts, rather than waiting for load.
    // The existing host-only session is reused by the API; the presentation is new.
    void begin();
  });
  publish.addEventListener("click", () => {
    if (!active || active.revoked || root.dataset.labState !== "ready") return;
    active.revision += 1;
    if (active.host?.publishState({ fixture: "shell-state-v1", message: "主站公开状态已到达", sequence: active.revision }, active.revision)) note(`已通过当前受限端口发送公开状态 #${active.revision}。`);
  });
  revoke.addEventListener("click", () => {
    const current = active;
    if (!current || current.revoked) return;
    revoking = true;
    current.host?.revoke("SESSION_REVOKED"); current.host?.dispose(); current.revoked = true;
    setState("revoked", "本页 SDK 权限已撤销，正在请求服务器撤销会话…");
    void readJson("/api/session/revoke", { method: "POST", body: "{}" }).then(() => {
      revoking = false;
      if (active === current && !disposed) { setState("revoked", "服务器会话与本页 SDK 绑定均已撤销。旧凭据和旧端口不能继续使用。"); note("服务器会话撤销已确认。"); }
    }).catch(error => { revoking = false; if (active === current && !disposed) reportError(error); });
  });
  const dispose = (): void => { if (disposed) return; disposed = true; closeActive("PAGE_UNLOADED"); };
  window.addEventListener("pagehide", dispose, { once: true });
  setState("idle", "点击启动，检查当前部署的会话、跨来源 SDK 和公开资源链路。这里不会创建房间或匹配玩家。");
  return dispose;
}
