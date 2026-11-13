/** A product choice only takes effect through an explicit, versioned binding. */
export interface PolicyBinding {
  readonly policyId: string;
  readonly version: number;
  readonly values: Readonly<Record<string, unknown>>;
}

export type PolicyResolution<T> =
  | { readonly status: "BOUND"; readonly binding: PolicyBinding; readonly value: Readonly<T> }
  | { readonly status: "UNSPECIFIED"; readonly requiredKeys: readonly string[] };

/** All fields here belong to the behavior currently being entered, not future capabilities. */
export interface PolicySchema<T extends Record<string, unknown>> {
  readonly policyId: string;
  readonly version: number;
  readonly fields: { readonly [K in keyof T]: (value: unknown) => T[K] };
}

export class PolicyError extends Error {
  readonly scope = "policy";
  readonly retryable = false;

  constructor(
    readonly code: "POLICY_REQUIRED" | "POLICY_INVALID" | "POLICY_VERSION_UNSUPPORTED",
    readonly requiredKeys: readonly string[] = [],
  ) {
    super(code);
    this.name = "PolicyError";
    this.requiredKeys = Object.freeze([...requiredKeys]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Snapshot JSON-compatible policy data, rejecting executable or mutable exotic values. */
function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new PolicyError("POLICY_INVALID");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(value, index);
        if (property === undefined || !("value" in property)) throw new PolicyError("POLICY_INVALID");
        copy.push(snapshot(property.value, ancestors));
      }
      return Object.freeze(copy);
    }
    if (!isRecord(value)) throw new PolicyError("POLICY_INVALID");
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !("value" in property)) throw new PolicyError("POLICY_INVALID");
      copy[key] = snapshot(property.value, ancestors);
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function validateSchema<T extends Record<string, unknown>>(schema: PolicySchema<T>): string[] {
  if (typeof schema.policyId !== "string" || schema.policyId.length === 0 ||
      !Number.isSafeInteger(schema.version) || schema.version < 1 || !isRecord(schema.fields)) {
    throw new PolicyError("POLICY_INVALID");
  }
  const keys = Object.keys(schema.fields);
  if (keys.some((key) => typeof schema.fields[key] !== "function")) throw new PolicyError("POLICY_INVALID");
  return keys;
}

/** Missing fields remain missing. Invalid values never become defaults or a bound policy. */
export function resolvePolicy<T extends Record<string, unknown>>(
  candidate: unknown,
  schema: PolicySchema<T>,
): PolicyResolution<T> {
  const keys = validateSchema(schema);
  if (candidate === undefined) {
    return Object.freeze({ status: "UNSPECIFIED", requiredKeys: Object.freeze([...keys]) });
  }
  if (!isRecord(candidate) || Object.keys(candidate).some((key) => !["policyId", "version", "values"].includes(key))) {
    throw new PolicyError("POLICY_INVALID");
  }
  // Read from a defensive JSON snapshot before invoking any capability-specific decoder.
  const input = snapshot(candidate) as Record<string, unknown>;
  if (input["policyId"] !== schema.policyId || !Number.isSafeInteger(input["version"])) {
    throw new PolicyError("POLICY_INVALID");
  }
  if (input["version"] !== schema.version) throw new PolicyError("POLICY_VERSION_UNSUPPORTED");
  const values = input["values"];
  if (!isRecord(values) || Object.keys(values).some((key) => !Object.hasOwn(schema.fields, key))) {
    throw new PolicyError("POLICY_INVALID");
  }
  const missing = keys.filter((key) => !Object.hasOwn(values, key));
  if (missing.length > 0) {
    return Object.freeze({ status: "UNSPECIFIED", requiredKeys: Object.freeze(missing) });
  }
  const decoded: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const decode = schema.fields[key];
    if (decode === undefined) throw new PolicyError("POLICY_INVALID");
    try {
      decoded[key] = decode(values[key]);
    } catch {
      throw new PolicyError("POLICY_INVALID");
    }
  }
  const binding: PolicyBinding = Object.freeze({
    policyId: schema.policyId,
    version: schema.version,
    values: values,
  });
  return Object.freeze({ status: "BOUND", binding, value: snapshot(decoded) as Readonly<T> });
}

/** Call before creating a queue intent, room, or other behavior governed by this choice. */
export function requirePolicy<T>(resolution: PolicyResolution<T>): Extract<PolicyResolution<T>, { status: "BOUND" }> {
  if (resolution.status !== "BOUND") throw new PolicyError("POLICY_REQUIRED", resolution.requiredKeys);
  return resolution;
}
