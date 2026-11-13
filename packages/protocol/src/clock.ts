export interface ClockContext {
  readonly contextTag: string;
  readonly localClockDomainId: string;
  readonly remoteClockDomainId: string;
}

export interface ClockProbe {
  readonly probeId: number;
  readonly t1: number;
}

export interface ClockPong extends ClockProbe {
  readonly t2: number;
  readonly t3: number;
}

/** Technical budgets must be selected by a caller; they never decide a game's outcome. */
export interface ClockEstimatorOptions {
  readonly maxOutstandingProbes: number;
  readonly maxProbeAgeMs: number;
  readonly maxSamples: number;
  readonly lowRttSlackMs: number;
  readonly offsetSmoothingFactor: number;
  readonly maxOffsetCorrectionMs: number;
  readonly jitterSmoothingFactor: number;
}

export interface ClockEstimate {
  readonly rttMs: number;
  readonly offsetRemoteMinusLocalMs: number;
  readonly jitterMs: number;
  readonly sampleCount: number;
  readonly filteredSampleCount: number;
  readonly observedAtMs: number;
}

export type ClockErrorCode =
  | "CLOCK_INVALID_CONFIG" | "CLOCK_INVALID_TIME" | "CLOCK_INVALID_PROBE"
  | "CLOCK_UNKNOWN_PROBE" | "CLOCK_PROBE_MISMATCH" | "CLOCK_PROBE_EXPIRED"
  | "CLOCK_DOMAIN_MISMATCH" | "CLOCK_CONTEXT_MISMATCH" | "CLOCK_DISCONTINUITY"
  | "CLOCK_BACKPRESSURE";

export class ClockError extends Error {
  readonly scope = "clock";
  readonly retryable = false;

  constructor(readonly code: ClockErrorCode) {
    super(code);
    this.name = "ClockError";
  }
}

interface Sample {
  readonly rttMs: number;
  readonly offsetMs: number;
}

function assertContext(context: ClockContext): void {
  if (typeof context.contextTag !== "string" || !/^[0-9a-f]{16}$/.test(context.contextTag) ||
      typeof context.localClockDomainId !== "string" || context.localClockDomainId.length === 0 ||
      typeof context.remoteClockDomainId !== "string" || context.remoteClockDomainId.length === 0) {
    throw new ClockError("CLOCK_INVALID_CONFIG");
  }
}

function assertOptions(options: ClockEstimatorOptions): void {
  const positiveIntegers = [options.maxOutstandingProbes, options.maxSamples];
  const positiveFinite = [options.maxProbeAgeMs, options.maxOffsetCorrectionMs];
  if (positiveIntegers.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      positiveFinite.some((value) => !Number.isFinite(value) || value <= 0) ||
      !Number.isFinite(options.lowRttSlackMs) || options.lowRttSlackMs < 0 ||
      [options.offsetSmoothingFactor, options.jitterSmoothingFactor].some(
        (value) => !Number.isFinite(value) || value <= 0 || value > 1,
      )) throw new ClockError("CLOCK_INVALID_CONFIG");
}

function validProbeId(probeId: number): boolean {
  return Number.isInteger(probeId) && probeId >= 0 && probeId <= 0xffff_ffff;
}

/** An application-level estimate between two explicit monotonic clock domains. */
export class ClockEstimator {
  #context: ClockContext;
  readonly #options: ClockEstimatorOptions;
  readonly #pending = new Map<number, ClockProbe>();
  #samples: Sample[] = [];
  #estimate: ClockEstimate | undefined;
  #lastLocalTime: number | undefined;
  #lastRtt: number | undefined;

  constructor(context: ClockContext, options: ClockEstimatorOptions) {
    assertContext(context);
    assertOptions(options);
    this.#context = Object.freeze({ ...context });
    this.#options = Object.freeze({ ...options });
  }

  get context(): ClockContext { return this.#context; }
  get estimate(): ClockEstimate | undefined { return this.#estimate; }
  get outstandingProbeCount(): number { return this.#pending.size; }

  startProbe(probeId: number, t1: number): ClockProbe {
    if (!validProbeId(probeId)) throw new ClockError("CLOCK_INVALID_PROBE");
    this.#assertLocalTime(t1);
    if (this.#pending.has(probeId)) throw new ClockError("CLOCK_PROBE_MISMATCH");
    // Expired probes can be reclaimed without accepting them or changing an estimate.
    for (const [id, pending] of this.#pending) {
      if (t1 - pending.t1 > this.#options.maxProbeAgeMs) this.#pending.delete(id);
    }
    if (this.#pending.size >= this.#options.maxOutstandingProbes) throw new ClockError("CLOCK_BACKPRESSURE");
    const probe = Object.freeze({ probeId, t1 });
    this.#pending.set(probeId, probe);
    this.#lastLocalTime = t1;
    return probe;
  }

  acceptPong(pong: ClockPong, t4: number, context: ClockContext): ClockEstimate {
    if (context.contextTag !== this.#context.contextTag) throw new ClockError("CLOCK_CONTEXT_MISMATCH");
    if (context.localClockDomainId !== this.#context.localClockDomainId ||
        context.remoteClockDomainId !== this.#context.remoteClockDomainId) {
      throw new ClockError("CLOCK_DOMAIN_MISMATCH");
    }
    if (!validProbeId(pong.probeId)) throw new ClockError("CLOCK_INVALID_PROBE");
    const probe = this.#pending.get(pong.probeId);
    if (probe === undefined) throw new ClockError("CLOCK_UNKNOWN_PROBE");
    if (![pong.t1, pong.t2, pong.t3, t4].every(Number.isFinite)) throw new ClockError("CLOCK_INVALID_TIME");
    if (pong.t1 !== probe.t1) throw new ClockError("CLOCK_PROBE_MISMATCH");
    this.#assertLocalTime(t4);
    if (pong.t3 < pong.t2 || t4 < pong.t1) throw new ClockError("CLOCK_INVALID_TIME");
    if (t4 - probe.t1 > this.#options.maxProbeAgeMs) {
      this.#pending.delete(pong.probeId);
      throw new ClockError("CLOCK_PROBE_EXPIRED");
    }
    const rttMs = (t4 - pong.t1) - (pong.t3 - pong.t2);
    const offsetMs = ((pong.t2 - pong.t1) + (pong.t3 - t4)) / 2;
    if (!Number.isFinite(rttMs) || !Number.isFinite(offsetMs) || rttMs < 0) {
      throw new ClockError("CLOCK_INVALID_TIME");
    }
    const samples = [...this.#samples, { rttMs, offsetMs }].slice(-this.#options.maxSamples);
    const minimumRtt = samples.reduce((lowest, sample) => Math.min(lowest, sample.rttMs), Infinity);
    const filtered = samples.filter((sample) => sample.rttMs <= minimumRtt + this.#options.lowRttSlackMs);
    // Divide before summation to avoid overflowing when finite samples are very large.
    const targetOffset = filtered.reduce((total, sample) => total + sample.offsetMs / filtered.length, 0);
    const previousOffset = this.#estimate?.offsetRemoteMinusLocalMs;
    const delta = previousOffset === undefined ? 0 :
      Math.max(-this.#options.maxOffsetCorrectionMs,
        Math.min(this.#options.maxOffsetCorrectionMs, (targetOffset - previousOffset) * this.#options.offsetSmoothingFactor));
    const offset = previousOffset === undefined ? targetOffset : previousOffset + delta;
    const deviation = this.#lastRtt === undefined ? 0 : Math.abs(rttMs - this.#lastRtt);
    const jitter = this.#estimate === undefined ? 0 :
      this.#estimate.jitterMs + this.#options.jitterSmoothingFactor * (deviation - this.#estimate.jitterMs);
    if (![offset, jitter].every(Number.isFinite)) throw new ClockError("CLOCK_INVALID_TIME");
    const estimate = Object.freeze({
      rttMs: minimumRtt,
      offsetRemoteMinusLocalMs: offset,
      jitterMs: jitter,
      sampleCount: samples.length,
      filteredSampleCount: filtered.length,
      observedAtMs: t4,
    });
    // Validation is complete: only now consume the probe and replace valid calibration.
    this.#pending.delete(pong.probeId);
    this.#samples = samples;
    this.#estimate = estimate;
    this.#lastRtt = rttMs;
    this.#lastLocalTime = t4;
    return estimate;
  }

  /** Rebinding after a clock discontinuity starts a fresh calibration, never blends domains. */
  resetDomains(context: ClockContext): void {
    assertContext(context);
    if (context.contextTag === this.#context.contextTag &&
        context.localClockDomainId === this.#context.localClockDomainId &&
        context.remoteClockDomainId === this.#context.remoteClockDomainId) {
      throw new ClockError("CLOCK_INVALID_CONFIG");
    }
    this.#context = Object.freeze({ ...context });
    this.#pending.clear();
    this.#samples = [];
    this.#estimate = undefined;
    this.#lastRtt = undefined;
    this.#lastLocalTime = undefined;
  }

  #assertLocalTime(value: number): void {
    if (!Number.isFinite(value)) throw new ClockError("CLOCK_INVALID_TIME");
    if (this.#lastLocalTime !== undefined && value < this.#lastLocalTime) {
      throw new ClockError("CLOCK_DISCONTINUITY");
    }
  }
}
