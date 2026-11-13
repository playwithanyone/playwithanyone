import { connectGameClient } from "./sdk.js";

// Authored loading fixture only: no rooms, private networking or game input rights.
// Bootstrap fetch can outlive iframe load. Keep one genuine parent challenge until
// the SDK listener is installed, then replay that same envelope after exact checks.
let earlyChallenge;
const rememberChallenge = event => {
  if (event.source === window.parent && event.ports.length === 0 && event.data?.type === "BOOT_CHALLENGE") earlyChallenge = event;
};
window.addEventListener("message", rememberChallenge);
const status = document.querySelector("#status");
const heading = document.querySelector("h1");
const stateStatus = document.createElement("p");
stateStatus.id = "state-status";
stateStatus.textContent = "尚未收到主站公开状态。";
document.querySelector("main").append(stateStatus);
document.documentElement.dataset.sdkState = "connecting";
let client;
let revoked = false;

async function boot() {
  const response = await fetch("/bootstrap.json", { credentials: "omit", mode: "cors" });
  if (!response.ok) throw new Error("BOOTSTRAP_UNAVAILABLE");
  const bootstrap = await response.json();
  if (typeof bootstrap.shellOrigin !== "string" || typeof bootstrap.gameBuildId !== "string" || !/^[0-9a-f]{64}$/.test(bootstrap.gameBuildId)) throw new Error("BOOTSTRAP_SCHEMA");
  const connection = connectGameClient({ shellOrigin: bootstrap.shellOrigin, gameBuildId: bootstrap.gameBuildId });
  window.removeEventListener("message", rememberChallenge);
  if (earlyChallenge && earlyChallenge.origin === bootstrap.shellOrigin && earlyChallenge.source === window.parent && earlyChallenge.data.gameBuildId === bootstrap.gameBuildId) {
    window.dispatchEvent(new MessageEvent("message", { data: earlyChallenge.data, origin: earlyChallenge.origin, source: earlyChallenge.source }));
  }
  earlyChallenge = undefined;
  client = await connection;
  document.documentElement.dataset.sdkState = "connected";
  client.lifecycle.subscribe(event => {
    if (event.type !== "REVOKED") return;
    revoked = true;
    document.documentElement.dataset.sdkState = "revoked";
    heading.textContent = "SDK 授权已撤销";
    status.textContent = "当前页面不能继续请求平台能力。重新加载后需要新的授权与握手。";
  });
  client.state.subscribe(envelope => {
    const view = envelope.view;
    if (view?.fixture === "shell-state-v1" && typeof view.message === "string") {
      stateStatus.textContent = `${view.message}（revision ${envelope.revision}）`;
      document.documentElement.dataset.stateRevision = String(envelope.revision);
    }
  });
  const bytes = await client.assets.fetch("assets/sample.json");
  const sample = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (sample.fixture !== "public-loader-v1" || typeof sample.message !== "string") throw new Error("ASSET_SCHEMA");
  await client.ready();
  if (revoked) return;
  heading.textContent = "公开资源与 SDK 已就绪";
  status.textContent = sample.message;
  document.documentElement.dataset.loaderState = "loaded";
  document.documentElement.dataset.sdkState = "ready";
}
void boot().catch(() => {
  window.removeEventListener("message", rememberChallenge);
  if (revoked) return;
  document.documentElement.dataset.loaderState = "failed";
  document.documentElement.dataset.sdkState = "failed";
  heading.textContent = "SDK 或资源加载未完成";
  status.textContent = "请检查登记构建、SDK 授权、响应头和资源完整性。未完成时不会报告 READY。";
});
window.addEventListener("pagehide", () => client?.dispose(), { once: true });
