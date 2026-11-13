import test from "node:test";
import assert from "node:assert/strict";
import { inspectPublicText, isPrivatePublicationPath } from "../../../scripts/publication-audit.mjs";

test("publication: operator files stay private while templates, source rules and notices stay public", () => {
  for (const file of ["private/docs/notes.md", "artifacts/report.json", "AGENTS.md", "原始点子/chat.md", "PUBLICATION.md", "docs/PlayWithAnyone_Implementation_and_Verification_Plan_v1.0.md", "docs/PlayWithAnyone_Cost_and_Safety_Addendum_v1.0.md", "configs/cloud/resources.json", "configs/safety.preview.json", ".env.production", "nested/.dev.vars", "secret.pem"]) assert.equal(isPrivatePublicationPath(file), true, file);
  for (const file of ["configs/cloud/resources.example.json", "configs/safety.preview.example.json", ".env.example", ".dev.vars.example", "games/connect-four/src/rules.ts", "games/connect-four/LICENSE", "scripts/check-public.mjs"]) assert.equal(isPrivatePublicationPath(file), false, file);
});
test("publication: credential findings report no secret value", () => {
  const token = "ghp_" + "x".repeat(36);
  const findings = inspectPublicText("accidental.txt", token);
  assert.deepEqual(findings, [{ file: "accidental.txt", code: "CREDENTIAL_LITERAL" }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});
test("publication: private key and known live resource markers fail", () => {
  assert.equal(inspectPublicText("bad.txt", "-----BEGIN PRIVATE" + " KEY-----")[0].code, "CREDENTIAL_LITERAL");
  const identifier = "live-resource-" + "a".repeat(24);
  assert.equal(inspectPublicText("bad.json", identifier, [identifier])[0].code, "PRIVATE_DEPLOYMENT_VALUE");
});
test("publication: personal home paths fail without rejecting relative build paths", () => {
  assert.equal(inspectPublicText("readme.md", ["", "Users", "local-only", "keys"].join("/"))[0].code, "PERSONAL_ABSOLUTE_PATH");
  assert.deepEqual(inspectPublicText("readme.md", ".generated/releases and configs/remote.local.json"), []);
});
test("publication: explicit fixture values and independent secret variable names are safe", () => {
  const content = 'SAFETY_STOP_TOKEN="test-only-independent-management-token"; const key = process.env.PWA_CF_METRICS_TOKEN;';
  assert.deepEqual(inspectPublicText("fixture.test.mjs", content), []);
  assert.equal(inspectPublicText("config.txt", 'SAFETY_STOP_TOKEN="' + "x".repeat(43) + '"')[0].code, "CREDENTIAL_LITERAL");
});
