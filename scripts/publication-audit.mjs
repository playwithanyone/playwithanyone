// This module reports only categories and paths, never a matched credential value.
const privateNames = new Set([
  "AGENTS.md", "configs/cloud/resources.json", "configs/remote.local.json",
  "configs/budget.authorized.json", "configs/safety.preview.json",
  "configs/safety.entries.json", "configs/safety.watchdog.preview.json",
  "configs/room-routing.preview.json", "configs/resource-profiles/connect-four.json",
  "docs/PlayWithAnyone_Cost_Operations.md", "docs/Resource_Profile_Measurement.md",
]);
const privateRoots = /^(?:private|artifacts|node_modules|dist|\.generated|\.build|\.wrangler|原始点子)(?:\/|$)/;
export function isPrivatePublicationPath(file) {
  if (privateNames.has(file) || privateRoots.test(file) || /(?:^|\/)(?:node_modules|dist|\.DS_Store)(?:\/|$)/.test(file)) return true;
  const base = file.split("/").at(-1);
  if (/^\.(?:env|dev\.vars)(?:\.|$)/.test(base) && !base.endsWith(".example")) return true;
  return /\.(?:pem|key|p12|pfx|sqlite3?|db|log|env)$/.test(file);
}

export function inspectPublicText(file, content, protectedValues = []) {
  const codes = new Set();
  if (isPrivatePublicationPath(file)) codes.add("PRIVATE_PATH");
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(content) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(content) ||
      /\bAKIA[A-Z0-9]{16}\b/.test(content)) codes.add("CREDENTIAL_LITERAL");
  const assignments = /(?:api[_-]?(?:key|token)|client[_-]?secret|(?:PWA_|SAFETY_|ROOM_)[A-Z0-9_]*(?:TOKEN|SECRET|KEY))\s*[=:]\s*["'`]([A-Za-z0-9_.:/+~-]{24,})["'`]/gi;
  for (const match of content.matchAll(assignments)) if (!/^(?:test|fixture|example|placeholder|replace|dummy|not-a-real|your[-_])/i.test(match[1])) codes.add("CREDENTIAL_LITERAL");
  if (/(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+\//.test(content)) codes.add("PERSONAL_ABSOLUTE_PATH");
  if (protectedValues.some(value => typeof value === "string" && value.length >= 16 && content.includes(value))) codes.add("PRIVATE_DEPLOYMENT_VALUE");
  return [...codes].map(code => ({ file, code }));
}
