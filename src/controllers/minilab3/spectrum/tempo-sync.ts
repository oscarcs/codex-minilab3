export type OnsetRole = "low" | "mid" | "high";
export type TempoSyncMode = "acquiring" | "tracking";

export interface TempoSyncStatus {
  readonly mode: TempoSyncMode;
  readonly bpm: number | undefined;
  readonly challengerBpm: number | undefined;
  readonly confidence: number;
  readonly acceptedOnsets: number;
}

interface TempoOnset {
  readonly atMs: number;
  readonly strength: number;
  readonly role: OnsetRole;
}

const MIN_BPM = 70;
const MAX_BPM = 200;
const BPM_STEP = 1;
const CANDIDATE_COUNT = (MAX_BPM - MIN_BPM) / BPM_STEP + 1;
const CANDIDATE_PERIODS = Float64Array.from(
  { length: CANDIDATE_COUNT },
  (_, index) => 60_000 / (MIN_BPM + index * BPM_STEP),
);
const HISTORY_WINDOW_MS = 10_000;
const MAX_ONSETS = 48;
const SCORE_DECAY_MS = 4_200;
const MIN_PERIOD_MS = 60_000 / MAX_BPM;
const MAX_PERIOD_MS = 60_000 / MIN_BPM;
const SILENCE_REACQUIRE_MS = 3_000;
const LOCKED_TEMPO_NEIGHBORHOOD = 0.02;
const MIN_DRIFT_CONFIDENCE = 0.12;
const MAX_DRIFT_BPM_PER_SECOND = 0.25;
const MIN_CHALLENGER_CONFIDENCE = 0.18;
const CHALLENGER_SCORE_ADVANTAGE = 1.18;
const CHALLENGER_MATCH_TOLERANCE = 0.025;
const CHALLENGER_GRACE_MS = 1_200;
const CHALLENGER_HOLD_MS = 3_000;
const MIN_CHALLENGER_SUPPORT = 5;

export class AdaptiveTempoSync {
  #onsets: TempoOnset[] = [];
  #scores = new Float64Array(CANDIDATE_COUNT);
  #lastScoreAt: number | undefined;
  #periodMs: number | undefined;
  #anchorAt: number | undefined;
  #confidence = 0;
  #mode: TempoSyncMode = "acquiring";
  #acquisitionPeriods: number[] = [];
  #acceptedOnsets = 0;
  #lowConfidenceSince: number | undefined;
  #lastTempoUpdateAt: number | undefined;
  #challengerPeriodMs: number | undefined;
  #challengerSince: number | undefined;
  #challengerLastSupportedAt: number | undefined;
  #challengerSupport = 0;

  get periodMs(): number | undefined {
    return this.#periodMs;
  }

  get confidence(): number {
    return this.#confidence;
  }

  get status(): TempoSyncStatus {
    return {
      mode: this.#mode,
      bpm: this.#periodMs === undefined ? undefined : 60_000 / this.#periodMs,
      challengerBpm: this.#challengerPeriodMs === undefined
        ? undefined
        : 60_000 / this.#challengerPeriodMs,
      confidence: this.#confidence,
      acceptedOnsets: this.#acceptedOnsets,
    };
  }

  reset(): void {
    this.#onsets = [];
    this.#scores.fill(0);
    this.#lastScoreAt = undefined;
    this.#periodMs = undefined;
    this.#anchorAt = undefined;
    this.#confidence = 0;
    this.#mode = "acquiring";
    this.#acquisitionPeriods = [];
    this.#acceptedOnsets = 0;
    this.#lowConfidenceSince = undefined;
    this.#lastTempoUpdateAt = undefined;
    this.#clearChallenger();
  }

  observeOnset(atMs: number, strength: number, role: OnsetRole): void {
    const lastAcceptedAt = this.#onsets.at(-1)?.atMs;
    if (lastAcceptedAt !== undefined && atMs - lastAcceptedAt >= SILENCE_REACQUIRE_MS) {
      this.reset();
    }
    this.#pruneHistory(atMs);
    this.#decayScores(atMs);

    const onset: TempoOnset = {
      atMs,
      strength: clamp(strength, 0.25, 2),
      role,
    };
    const previousOnset = this.#onsets.at(-1);
    for (let candidateIndex = 0; candidateIndex < CANDIDATE_COUNT; candidateIndex += 1) {
      const periodMs = CANDIDATE_PERIODS[candidateIndex]!;
      let evidence = 0;
      for (const previous of this.#onsets) {
        const elapsedMs = atMs - previous.atMs;
        if (elapsedMs < 120) continue;
        const cycles = elapsedMs / periodMs;
        const recency = Math.exp(-elapsedMs / 7_000);
        const strengthWeight = Math.sqrt(onset.strength * previous.strength);
        const roleWeight = Math.sqrt(roleReliability(onset.role) * roleReliability(previous.role));
        evidence += recency * strengthWeight * roleWeight
          * intervalEvidence(cycles, onset.role, previous.role);
      }
      this.#scores[candidateIndex] = this.#scores[candidateIndex]! + evidence;
    }

    this.#onsets.push(onset);
    this.#acceptedOnsets += 1;
    if (this.#onsets.length > MAX_ONSETS) this.#onsets.shift();
    if (previousOnset !== undefined) {
      this.#recordAcquisitionInterval(atMs - previousOnset.atMs);
    }
    this.#tryFastAcquisition();
    this.#selectTempo(onset);
  }

  beatsElapsed(nowMs: number): number | undefined {
    if (this.#periodMs === undefined || this.#anchorAt === undefined) return undefined;
    return Math.max(0, (nowMs - this.#anchorAt) / this.#periodMs);
  }

  #pruneHistory(nowMs: number): void {
    while (this.#onsets.length > 0 && nowMs - this.#onsets[0]!.atMs > HISTORY_WINDOW_MS) {
      this.#onsets.shift();
    }
  }

  #decayScores(nowMs: number): void {
    if (this.#lastScoreAt !== undefined) {
      const decay = Math.exp(-(nowMs - this.#lastScoreAt) / SCORE_DECAY_MS);
      for (let index = 0; index < this.#scores.length; index += 1) {
        this.#scores[index] = this.#scores[index]! * decay;
      }
    }
    this.#lastScoreAt = nowMs;
  }

  #recordAcquisitionInterval(rawIntervalMs: number): void {
    if (rawIntervalMs < 120 || rawIntervalMs > 1_800) {
      this.#acquisitionPeriods = [];
      return;
    }
    let periodMs = rawIntervalMs;
    while (periodMs < MIN_PERIOD_MS) periodMs *= 2;
    while (periodMs > MAX_PERIOD_MS) periodMs /= 2;
    this.#acquisitionPeriods.push(periodMs);
    if (this.#acquisitionPeriods.length > 4) this.#acquisitionPeriods.shift();
  }

  #tryFastAcquisition(): void {
    if (this.#mode !== "acquiring" || this.#acquisitionPeriods.length < 3) return;
    const recent = this.#acquisitionPeriods.slice(-3);
    const candidate = median(recent);
    const maximumDeviation = Math.max(
      ...recent.map((periodMs) => Math.abs(periodMs - candidate) / candidate),
    );
    if (maximumDeviation > 0.04) return;

    this.#periodMs = candidate;
    this.#anchorAt = this.#bestAnchor(candidate);
    this.#confidence = Math.max(this.#confidence, 0.72 + (0.04 - maximumDeviation) * 7);
    this.#mode = "tracking";
    this.#acquisitionPeriods = [];
    this.#lowConfidenceSince = undefined;
  }

  #selectTempo(latest: TempoOnset): void {
    if (this.#onsets.length < 3) return;

    const selectionScores = new Float64Array(CANDIDATE_COUNT);
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < this.#scores.length; index += 1) {
      const coverage = this.#gridCoverage(CANDIDATE_PERIODS[index]!);
      selectionScores[index] = this.#scores[index]! * (0.28 + 0.72 * coverage * coverage);
      const continuity = this.#periodMs === undefined
        ? 1
        : 1 + 0.08 * Math.exp(-Math.abs(Math.log(CANDIDATE_PERIODS[index]! / this.#periodMs)) * 24);
      const adjustedScore = selectionScores[index]! * continuity;
      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }

    let runnerUp = 0;
    for (let index = 0; index < this.#scores.length; index += 1) {
      if (Math.abs(index - bestIndex) <= 4) continue;
      runnerUp = Math.max(runnerUp, selectionScores[index]!);
    }
    const bestRawScore = selectionScores[bestIndex]!;
    const instantConfidence = clamp(
      (bestRawScore - runnerUp) / Math.max(0.001, bestRawScore) * 2.4,
      0,
      1,
    );
    const confidenceBlend = instantConfidence >= this.#confidence ? 0.28 : 0.12;
    this.#confidence += (instantConfidence - this.#confidence) * confidenceBlend;

    const targetPeriod = CANDIDATE_PERIODS[bestIndex]!;
    if (this.#periodMs === undefined) {
      this.#periodMs = targetPeriod;
      this.#anchorAt = this.#bestAnchor(targetPeriod);
    } else if (this.#mode === "acquiring") {
      const relativeChange = Math.abs(targetPeriod - this.#periodMs) / this.#periodMs;
      const blend = relativeChange <= 0.08 ? 0.18 : 0.34;
      this.#periodMs += (targetPeriod - this.#periodMs) * blend;
    } else {
      this.#updateLockedTempo(
        latest.atMs,
        targetPeriod,
        bestRawScore,
        selectionScores[bpmToCandidateIndex(60_000 / this.#periodMs)]!,
        instantConfidence,
      );
    }

    this.#correctPhase(latest);
    this.#updateMode(latest.atMs, instantConfidence);
  }

  #updateLockedTempo(
    nowMs: number,
    targetPeriod: number,
    targetScore: number,
    currentScore: number,
    instantConfidence: number,
  ): void {
    const currentPeriod = this.#periodMs!;
    const relativeChange = Math.abs(targetPeriod - currentPeriod) / currentPeriod;
    const elapsedSeconds = this.#lastTempoUpdateAt === undefined
      ? 0
      : Math.max(0, nowMs - this.#lastTempoUpdateAt) / 1_000;
    this.#lastTempoUpdateAt = nowMs;

    if (relativeChange <= LOCKED_TEMPO_NEIGHBORHOOD) {
      if (this.#challengerPeriodMs !== undefined) {
        if (this.#challengerIsStale(nowMs)) this.#clearChallenger();
        else return;
      }
      if (instantConfidence < MIN_DRIFT_CONFIDENCE || elapsedSeconds <= 0) return;
      const currentBpm = 60_000 / currentPeriod;
      const targetBpm = 60_000 / targetPeriod;
      const maximumChange = MAX_DRIFT_BPM_PER_SECOND * elapsedSeconds;
      const nextBpm = currentBpm + clamp(targetBpm - currentBpm, -maximumChange, maximumChange);
      this.#periodMs = 60_000 / nextBpm;
      return;
    }

    const qualifies = instantConfidence >= MIN_CHALLENGER_CONFIDENCE
      && targetScore >= Math.max(0.001, currentScore) * CHALLENGER_SCORE_ADVANTAGE;
    if (!qualifies) {
      if (this.#challengerIsStale(nowMs)) this.#clearChallenger();
      return;
    }

    const matchesChallenger = this.#challengerPeriodMs !== undefined
      && Math.abs(targetPeriod - this.#challengerPeriodMs) / this.#challengerPeriodMs
        <= CHALLENGER_MATCH_TOLERANCE;
    if (!matchesChallenger) {
      this.#challengerPeriodMs = targetPeriod;
      this.#challengerSince = nowMs;
      this.#challengerSupport = 1;
    } else {
      this.#challengerPeriodMs! += (targetPeriod - this.#challengerPeriodMs!) * 0.15;
      this.#challengerSupport += 1;
    }
    this.#challengerLastSupportedAt = nowMs;

    if (
      this.#challengerSince !== undefined
      && nowMs - this.#challengerSince >= CHALLENGER_HOLD_MS
      && this.#challengerSupport >= MIN_CHALLENGER_SUPPORT
    ) {
      this.#periodMs = this.#challengerPeriodMs;
      this.#anchorAt = this.#bestAnchor(this.#periodMs!);
      this.#lastTempoUpdateAt = nowMs;
      this.#clearChallenger();
    }
  }

  #clearChallenger(): void {
    this.#challengerPeriodMs = undefined;
    this.#challengerSince = undefined;
    this.#challengerLastSupportedAt = undefined;
    this.#challengerSupport = 0;
  }

  #challengerIsStale(nowMs: number): boolean {
    return this.#challengerLastSupportedAt !== undefined
      && nowMs - this.#challengerLastSupportedAt > CHALLENGER_GRACE_MS;
  }

  #updateMode(nowMs: number, instantConfidence: number): void {
    if (this.#mode === "acquiring") {
      if (this.#onsets.length >= 6 && this.#confidence >= 0.15) {
        this.#mode = "tracking";
        this.#lowConfidenceSince = undefined;
        this.#lastTempoUpdateAt = nowMs;
      }
      return;
    }
    if (instantConfidence >= 0.12 || this.#challengerPeriodMs !== undefined) {
      this.#lowConfidenceSince = undefined;
      return;
    }
    this.#lowConfidenceSince ??= nowMs;
    if (nowMs - this.#lowConfidenceSince >= 4_000) {
      this.#mode = "acquiring";
      this.#acquisitionPeriods = [];
      this.#lowConfidenceSince = undefined;
      this.#lastTempoUpdateAt = undefined;
      this.#clearChallenger();
    }
  }

  #gridCoverage(periodMs: number): number {
    const firstAt = this.#onsets[0]!.atMs;
    const lastAt = this.#onsets.at(-1)!.atMs;
    if (lastAt - firstAt < periodMs * 1.5) return 0.5;

    let anchor = this.#onsets[0]!;
    let anchorWeight = 0;
    for (const onset of this.#onsets) {
      const weight = onset.strength * roleReliability(onset.role);
      if (weight > anchorWeight) {
        anchor = onset;
        anchorWeight = weight;
      }
    }

    const firstBeat = Math.ceil((firstAt - anchor.atMs) / periodMs);
    const lastBeat = Math.floor((lastAt - anchor.atMs) / periodMs);
    let supportTotal = 0;
    let beatCount = 0;
    for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
      const predictedAt = anchor.atMs + beat * periodMs;
      let strongestSupport = 0;
      for (const onset of this.#onsets) {
        const distance = Math.abs(onset.atMs - predictedAt) / periodMs;
        if (distance > 0.18) continue;
        const support = onset.strength * roleReliability(onset.role) * gaussian(distance / 0.09);
        strongestSupport = Math.max(strongestSupport, support);
      }
      supportTotal += Math.min(1, strongestSupport);
      beatCount += 1;
    }
    return beatCount === 0 ? 0 : supportTotal / beatCount;
  }

  #bestAnchor(periodMs: number): number {
    let bestAnchor = this.#onsets[0]!.atMs;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of this.#onsets) {
      let score = roleReliability(candidate.role) * candidate.strength;
      for (const onset of this.#onsets) {
        const cycles = Math.abs(onset.atMs - candidate.atMs) / periodMs;
        const distance = Math.abs(cycles - Math.round(cycles));
        score += roleReliability(onset.role) * onset.strength * gaussian(distance / 0.1);
      }
      if (score > bestScore) {
        bestScore = score;
        bestAnchor = candidate.atMs;
      }
    }
    return bestAnchor;
  }

  #correctPhase(onset: TempoOnset): void {
    if (this.#periodMs === undefined || this.#anchorAt === undefined) return;
    const nearestBeat = Math.round((onset.atMs - this.#anchorAt) / this.#periodMs);
    const predictedAt = this.#anchorAt + nearestBeat * this.#periodMs;
    const errorMs = onset.atMs - predictedAt;
    const tolerance = this.#mode === "acquiring" ? 0.25 : onset.role === "high" ? 0.08 : 0.18;
    if (Math.abs(errorMs) > this.#periodMs * tolerance) return;

    const roleCorrection = this.#mode === "acquiring"
      ? 0.55
      : onset.role === "low" ? 0.24 : onset.role === "mid" ? 0.13 : 0.025;
    const confidenceCorrection = 0.55 + this.#confidence * 0.45;
    this.#anchorAt += errorMs * roleCorrection * confidenceCorrection;
  }
}

function intervalEvidence(cycles: number, currentRole: OnsetRole, previousRole: OnsetRole): number {
  const nearestBeat = Math.round(cycles);
  const beatEvidence = nearestBeat >= 1
    ? gaussian(Math.abs(cycles - nearestBeat) / 0.085) / Math.sqrt(nearestBeat)
    : 0;

  const nearestHalf = Math.round(cycles - 0.5) + 0.5;
  const halfRoleWeight = currentRole === "high" || previousRole === "high" ? 0.38 : 0.2;
  const halfEvidence = nearestHalf >= 0.5
    ? gaussian(Math.abs(cycles - nearestHalf) / 0.07) * halfRoleWeight / Math.sqrt(Math.max(1, nearestHalf))
    : 0;

  const nearestQuarter = Math.round(cycles * 4) / 4;
  const isProperQuarter = Math.abs(nearestQuarter * 2 - Math.round(nearestQuarter * 2)) > 0.01;
  const quarterRoleWeight = currentRole === "high" || previousRole === "high" ? 0.13 : 0.045;
  const quarterEvidence = isProperQuarter
    ? gaussian(Math.abs(cycles - nearestQuarter) / 0.055) * quarterRoleWeight
    : 0;

  return Math.max(beatEvidence, halfEvidence, quarterEvidence);
}

function roleReliability(role: OnsetRole): number {
  if (role === "low") return 1;
  if (role === "mid") return 0.78;
  return 0.44;
}

function bpmToCandidateIndex(bpm: number): number {
  return Math.round(clamp((bpm - MIN_BPM) / BPM_STEP, 0, CANDIDATE_COUNT - 1));
}

function gaussian(value: number): number {
  return Math.exp(-0.5 * value * value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}
