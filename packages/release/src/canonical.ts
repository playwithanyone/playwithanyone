/** RFC 8785 JCS: ECMAScript primitive serialization and recursive UTF-16 key order. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class ReleaseError extends Error {
  readonly scope = "release";
  readonly retryable = false;
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReleaseError";
  }
}

/** Unpaired UTF-16 surrogates cannot represent I-JSON Unicode data. */
export function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ReleaseError("INVALID_JSON", "unpaired high surrogate");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ReleaseError("INVALID_JSON", "unpaired low surrogate");
    }
  }
}

export function canonicalize(input: unknown): string {
  const ancestors = new Set<object>();
  function serialize(value: unknown): string {
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new ReleaseError("INVALID_JSON", "non-finite number");
      return JSON.stringify(value);
    }
    if (typeof value === "string") {
      assertUnicode(value);
      return JSON.stringify(value);
    }
    if (typeof value !== "object" || value === null || ancestors.has(value)) throw new ReleaseError("INVALID_JSON", "unsupported value or cycle");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).some(key => typeof key === "symbol" || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) throw new ReleaseError("INVALID_JSON", "non-JSON array property");
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, i);
          if (!descriptor || !("value" in descriptor)) throw new ReleaseError("INVALID_JSON", "sparse or accessor array");
          items.push(serialize(descriptor.value));
        }
        return `[${items.join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ReleaseError("INVALID_JSON", "non-JSON object prototype");
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== "string")) throw new ReleaseError("INVALID_JSON", "symbol key");
      // Default sort compares UTF-16 code units, as required by JCS; localeCompare does not.
      const properties = (keys as string[]).sort().map(key => {
        assertUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ReleaseError("INVALID_JSON", "non-JSON property");
        return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
      });
      return `{${properties.join(",")}}`;
    } finally { ancestors.delete(value); }
  }
  return serialize(input);
}

/** JSON text parser which rejects duplicate member names before ordinary JSON.parse loses them. */
export function parseJson(input: string): JsonValue {
  let cursor = 0;
  function whitespace(): void { while (/\s/.test(input[cursor] ?? "") && cursor < input.length) cursor++; }
  function invalid(): never { throw new ReleaseError("INVALID_JSON", "malformed JSON or duplicate key"); }
  function string(): string {
    const start = cursor++;
    while (cursor < input.length) {
      const char = input[cursor++];
      if (char === "\\") { cursor++; continue; }
      if (char === '"') {
        let value: unknown;
        try { value = JSON.parse(input.slice(start, cursor)); } catch { return invalid(); }
        if (typeof value !== "string") return invalid();
        assertUnicode(value);
        return value;
      }
    }
    return invalid();
  }
  function value(): void {
    whitespace();
    const char = input[cursor];
    if (char === '"') { string(); return; }
    if (char === "{") {
      cursor++; whitespace();
      const names = new Set<string>();
      if (input[cursor] === "}") { cursor++; return; }
      while (cursor < input.length) {
        whitespace();
        if (input[cursor] !== '"') return invalid();
        const name = string();
        if (names.has(name)) return invalid();
        names.add(name); whitespace();
        if (input[cursor++] !== ":") return invalid();
        value(); whitespace();
        const end = input[cursor++];
        if (end === "}") return;
        if (end !== ",") return invalid();
      }
      return invalid();
    }
    if (char === "[") {
      cursor++; whitespace();
      if (input[cursor] === "]") { cursor++; return; }
      while (cursor < input.length) {
        value(); whitespace();
        const end = input[cursor++];
        if (end === "]") return;
        if (end !== ",") return invalid();
      }
      return invalid();
    }
    const remaining = input.slice(cursor), token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(remaining)?.[0];
    if (!token) return invalid();
    cursor += token.length;
  }
  value(); whitespace();
  if (cursor !== input.length) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return invalid(); }
  canonicalize(parsed);
  return parsed as JsonValue;
}
