import assert from "node:assert/strict";
import test from "node:test";
import {
  PolicyError, requirePolicy, resolvePolicy,
  type PolicySchema,
} from "../../protocol/src/policy.js";
import {
  ClockError, ClockEstimator,
  type ClockContext, type ClockEstimatorOptions,
} from "../../protocol/src/clock.js";

// These choices exist solely to exercise validation; there is no production policy here.
type FixtureQueuePolicy = { expiresAfterMs: number | null; guestAllowed: boolean };
const schema: PolicySchema<FixtureQueuePolicy> = {
  policyId: "fixture.queue",
  version: 2,
  fields: {
    expiresAfterMs: (value) => {
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalid");
      return value;
    },
    guestAllowed: (value) => {
      if (typeof value !== "boolean") throw new Error("invalid");
      return value;
    },
  },
};

function policyCode(code: PolicyError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof PolicyError && error.code === code;
}

test("P01 missing policy remains UNSPECIFIED and the behavior entry reports POLICY_REQUIRED", () => {
  const absent = resolvePolicy(undefined, schema);
  assert.equal(absent.status, "UNSPECIFIED");
  if (absent.status !== "UNSPECIFIED") assert.fail("missing binding was resolved");
  assert.deepEqual(absent.requiredKeys, ["expiresAfterMs", "guestAllowed"]);
  assert.throws(() => requirePolicy(absent), (error: unknown) => {
    assert.ok(error instanceof PolicyError);
    assert.equal(error.code, "POLICY_REQUIRED");
    assert.deepEqual(error.requiredKeys, ["expiresAfterMs", "guestAllowed"]);
    return true;
  });
  const partial = resolvePolicy({ policyId: "fixture.queue", version: 2, values: { guestAllowed: false } }, schema);
  assert.equal(partial.status, "UNSPECIFIED");
  if (partial.status !== "UNSPECIFIED") assert.fail("missing timeout was defaulted");
  assert.deepEqual(partial.requiredKeys, ["expiresAfterMs"]);
  assert.throws(() => requirePolicy(partial), policyCode("POLICY_REQUIRED"));
});

test("P01 explicit false and null remain explicit choices, while missing values never adopt them", () => {
  const resolved = requirePolicy(resolvePolicy({
    policyId: "fixture.queue", version: 2,
    values: { expiresAfterMs: null, guestAllowed: false },
  }, schema));
  assert.equal(resolved.value.expiresAfterMs, null);
  assert.equal(resolved.value.guestAllowed, false);
  assert.equal(resolved.binding.version, 2);
  assert.throws(() => resolvePolicy(null, schema), policyCode("POLICY_INVALID"));
  assert.throws(() => resolvePolicy({
    policyId: "fixture.queue", version: 2, values: { guestAllowed: false, expiresAfterMs: undefined },
  }, schema), policyCode("POLICY_INVALID"));
});

test("policy schema validates fields, ID, range, version and closed binding shape", () => {
  const valid = { policyId: "fixture.queue", version: 2, values: { expiresAfterMs: 60_000, guestAllowed: true } };
  const cases: Array<[unknown, PolicyError["code"]]> = [
    [{ ...valid, policyId: "other.queue" }, "POLICY_INVALID"],
    [{ ...valid, version: 3 }, "POLICY_VERSION_UNSUPPORTED"],
    [{ ...valid, version: "2" }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: -1, guestAllowed: true } }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: 0, guestAllowed: true } }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: 0.5, guestAllowed: true } }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: NaN, guestAllowed: true } }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: Infinity, guestAllowed: true } }, "POLICY_INVALID"],
    [{ ...valid, values: { expiresAfterMs: 60_000, guestAllowed: "true" } }, "POLICY_INVALID"],
    [{ ...valid, values: { ...valid.values, unspecifiedFutureFeature: true } }, "POLICY_INVALID"],
    [{ ...valid, futureFeature: true }, "POLICY_INVALID"],
    [{ ...valid, values: { ...valid.values, function: () => true } }, "POLICY_INVALID"],
  ];
  for (const [candidate, code] of cases) assert.throws(() => resolvePolicy(candidate, schema), policyCode(code));
  assert.equal(requirePolicy(resolvePolicy(valid, schema)).value.expiresAfterMs, 60_000);
});

test("policy bindings and decoder outputs are fixed snapshots with no mutable source aliases", () => {
  const input = {
    policyId: "fixture.nested", version: 1,
    values: { rule: { permissions: ["play"], timeout: 50 } },
  };
  const nestedSchema: PolicySchema<{ rule: { permissions: string[]; timeout: number } }> = {
    policyId: "fixture.nested", version: 1,
    fields: {
      rule: (value) => {
        assert.ok(value !== null && typeof value === "object");
        return value as { permissions: string[]; timeout: number };
      },
    },
  };
  const bound = requirePolicy(resolvePolicy(input, nestedSchema));
  input.values.rule.permissions.push("spectate");
  input.values.rule.timeout = 999;
  input.version = 8;
  assert.deepEqual(bound.value.rule.permissions, ["play"]);
  assert.equal(bound.value.rule.timeout, 50);
  assert.equal(bound.binding.version, 1);
  assert.ok(Object.isFrozen(bound.binding.values));
  assert.ok(Object.isFrozen(bound.value.rule));
  assert.ok(Object.isFrozen(bound.value.rule.permissions));
  assert.throws(() => bound.value.rule.permissions.push("tampered"), TypeError);
  assert.throws(() => { (bound.binding as { version: number }).version = 9; }, TypeError);
});

test("policy parsing rejects executable getters and cyclic or exotic values", () => {
  let getterCalls = 0;
  const values = Object.defineProperty({}, "guestAllowed", { enumerable: true, get: () => { getterCalls += 1; return true; } });
  assert.throws(() => resolvePolicy({ policyId: "fixture.queue", version: 2, values }, schema), policyCode("POLICY_INVALID"));
  assert.equal(getterCalls, 0);
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  assert.throws(() => resolvePolicy({ policyId: "fixture.queue", version: 2, values: cycle }, schema), policyCode("POLICY_INVALID"));
  assert.throws(() => resolvePolicy({ policyId: "fixture.queue", version: 2, values: new Date() }, schema), policyCode("POLICY_INVALID"));
});

const context: ClockContext = {
  contextTag: "0123456789abcdef", localClockDomainId: "fixture-browser-A", remoteClockDomainId: "fixture-browser-B",
};
const clockOptions: ClockEstimatorOptions = {
  maxOutstandingProbes: 2, maxProbeAgeMs: 1000, maxSamples: 3, lowRttSlackMs: 5,
  offsetSmoothingFactor: 0.25, maxOffsetCorrectionMs: 2, jitterSmoothingFactor: 0.5,
};

function clockCode(code: ClockError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ClockError && error.code === code;
}

function calibrate(): ClockEstimator {
  const estimator = new ClockEstimator(context, clockOptions);
  estimator.startProbe(1, 1000);
  estimator.acceptPong({ probeId: 1, t1: 1000, t2: 1050, t3: 1052 }, 1032, context);
  return estimator;
}

test("four timestamp example gives RTT 30ms and remote-minus-local offset 35ms", () => {
  const estimator = calibrate();
  assert.deepEqual(estimator.estimate, {
    rttMs: 30, offsetRemoteMinusLocalMs: 35, jitterMs: 0,
    sampleCount: 1, filteredSampleCount: 1, observedAtMs: 1032,
  });
  assert.equal(estimator.outstandingProbeCount, 0);
  assert.ok(Object.isFrozen(estimator.estimate));
});

test("N99-14 old clock domains, wrong contexts, unknown and repeated probes do not change calibration", () => {
  const estimator = calibrate();
  const before = estimator.estimate;
  estimator.startProbe(2, 2000);
  const pong = { probeId: 2, t1: 2000, t2: 2050, t3: 2052 };
  assert.throws(() => estimator.acceptPong(pong, 2032, { ...context, localClockDomainId: "old-local" }), clockCode("CLOCK_DOMAIN_MISMATCH"));
  assert.throws(() => estimator.acceptPong(pong, 2032, { ...context, remoteClockDomainId: "old-remote" }), clockCode("CLOCK_DOMAIN_MISMATCH"));
  assert.throws(() => estimator.acceptPong(pong, 2032, { ...context, contextTag: "ffffffffffffffff" }), clockCode("CLOCK_CONTEXT_MISMATCH"));
  assert.throws(() => estimator.acceptPong({ ...pong, probeId: 99 }, 2032, context), clockCode("CLOCK_UNKNOWN_PROBE"));
  assert.throws(() => estimator.acceptPong({ probeId: 1, t1: 1000, t2: 1050, t3: 1052 }, 2032, context), clockCode("CLOCK_UNKNOWN_PROBE"));
  assert.throws(() => estimator.acceptPong({ ...pong, t1: 2001 }, 2032, context), clockCode("CLOCK_PROBE_MISMATCH"));
  assert.strictEqual(estimator.estimate, before);
  assert.equal(estimator.outstandingProbeCount, 1);
  estimator.acceptPong(pong, 2032, context);
  assert.equal(estimator.outstandingProbeCount, 0);
});

test("N99-14 nonfinite values, reversed clocks and negative RTT reject without replacing a valid estimate", () => {
  for (const key of ["t1", "t2", "t3", "t4"] as const) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const estimator = calibrate();
      estimator.startProbe(2, 2000);
      const before = estimator.estimate;
      const times = { t1: 2000, t2: 2050, t3: 2052, t4: 2032, [key]: invalid };
      assert.throws(() => estimator.acceptPong({ probeId: 2, t1: times.t1, t2: times.t2, t3: times.t3 }, times.t4, context), clockCode("CLOCK_INVALID_TIME"));
      assert.strictEqual(estimator.estimate, before);
      assert.equal(estimator.outstandingProbeCount, 1);
    }
  }
  const cases = [
    { t2: 2050, t3: 2040, t4: 2032 }, // Remote send precedes remote receive.
    { t2: 2050, t3: 2100, t4: 2032 }, // Remote processing exceeds local round trip.
    { t2: 2050, t3: 2052, t4: 1999 }, // Local receive precedes local send.
  ];
  for (const times of cases) {
    const estimator = calibrate();
    estimator.startProbe(2, 2000);
    const before = estimator.estimate;
    assert.throws(() => estimator.acceptPong({ probeId: 2, t1: 2000, t2: times.t2, t3: times.t3 }, times.t4, context), ClockError);
    assert.strictEqual(estimator.estimate, before);
  }
});

test("N99-14 expired probes cannot supply samples, and changing clock domains discards old calibration", () => {
  const estimator = calibrate();
  const before = estimator.estimate;
  estimator.startProbe(2, 2000);
  assert.throws(() => estimator.acceptPong({ probeId: 2, t1: 2000, t2: 2050, t3: 2052 }, 3001, context), clockCode("CLOCK_PROBE_EXPIRED"));
  assert.strictEqual(estimator.estimate, before);
  assert.equal(estimator.outstandingProbeCount, 0);
  estimator.startProbe(3, 4000);
  const newContext = { ...context, localClockDomainId: "fixture-A-recreated" };
  estimator.resetDomains(newContext);
  assert.equal(estimator.estimate, undefined);
  assert.equal(estimator.outstandingProbeCount, 0);
  assert.throws(() => estimator.acceptPong({ probeId: 3, t1: 4000, t2: 4050, t3: 4052 }, 4032, context), clockCode("CLOCK_DOMAIN_MISMATCH"));
  estimator.startProbe(4, 10);
  assert.equal(estimator.acceptPong({ probeId: 4, t1: 10, t2: 65, t3: 65 }, 20, newContext).offsetRemoteMinusLocalMs, 50);
});

test("clock filtering prefers low RTT, bounds sample memory, smooths drift and measures jitter", () => {
  const estimator = calibrate();
  estimator.startProbe(2, 2000);
  const noisy = estimator.acceptPong({ probeId: 2, t1: 2000, t2: 2500, t3: 2502 }, 2302, context);
  assert.equal(noisy.rttMs, 30);
  assert.equal(noisy.filteredSampleCount, 1);
  assert.equal(noisy.offsetRemoteMinusLocalMs, 35);
  assert.equal(noisy.jitterMs, 135); // 0 + 0.5 * abs(300 - 30).
  estimator.startProbe(3, 3000);
  const drifting = estimator.acceptPong({ probeId: 3, t1: 3000, t2: 3200, t3: 3202 }, 3032, context);
  assert.equal(drifting.offsetRemoteMinusLocalMs, 37); // Rate-limited correction toward the filtered target.
  assert.equal(drifting.filteredSampleCount, 2);
  estimator.startProbe(4, 4000);
  const bounded = estimator.acceptPong({ probeId: 4, t1: 4000, t2: 4200, t3: 4202 }, 4032, context);
  assert.equal(bounded.sampleCount, 3);
  assert.equal(bounded.filteredSampleCount, 2);
  assert.equal(bounded.offsetRemoteMinusLocalMs, 39);
});

test("clock outstanding probes are bounded, expired slots reclaimed and discontinuities explicit", () => {
  const estimator = new ClockEstimator(context, clockOptions);
  estimator.startProbe(1, 0);
  estimator.startProbe(2, 1);
  assert.throws(() => estimator.startProbe(3, 2), clockCode("CLOCK_BACKPRESSURE"));
  assert.equal(estimator.outstandingProbeCount, 2);
  assert.throws(() => estimator.startProbe(2, 2), clockCode("CLOCK_PROBE_MISMATCH"));
  assert.throws(() => estimator.startProbe(4, -1), clockCode("CLOCK_DISCONTINUITY"));
  estimator.startProbe(3, 1002);
  assert.equal(estimator.outstandingProbeCount, 1);
  assert.throws(() => estimator.startProbe(5, NaN), clockCode("CLOCK_INVALID_TIME"));
  assert.throws(() => estimator.startProbe(0x1_0000_0000, 1003), clockCode("CLOCK_INVALID_PROBE"));
});

test("clock budgets and domains must be explicit and valid", () => {
  assert.throws(() => new ClockEstimator({ ...context, contextTag: "bad" }, clockOptions), clockCode("CLOCK_INVALID_CONFIG"));
  assert.throws(() => new ClockEstimator(context, { ...clockOptions, maxSamples: 0 }), clockCode("CLOCK_INVALID_CONFIG"));
  assert.throws(() => new ClockEstimator(context, { ...clockOptions, maxProbeAgeMs: Infinity }), clockCode("CLOCK_INVALID_CONFIG"));
  assert.throws(() => new ClockEstimator(context, { ...clockOptions, offsetSmoothingFactor: 1.1 }), clockCode("CLOCK_INVALID_CONFIG"));
});
