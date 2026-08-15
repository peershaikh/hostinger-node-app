/**
 * PHASE_4C862 — Pure station resolution helpers (no I/O — safe for unit tests).
 */
import { areStationsCompatible, IRCTC_CANONICAL } from './stationAliases';

export interface ScheduleStopLike {
  Station_Code: string;
  SN: number;
}

export function stopCodesSet(stops: ScheduleStopLike[]): Set<string> {
  return new Set(stops.map(s => s.Station_Code.toUpperCase().trim()));
}

export function toIrctcApiCode(scheduleStopCode: string, stops: ScheduleStopLike[]): string {
  const code = scheduleStopCode.toUpperCase().trim();
  if (!code) return code;

  const canonical = IRCTC_CANONICAL[code];
  if (canonical) {
    const codes = stopCodesSet(stops);
    if (codes.has(canonical) || !codes.has(code)) {
      return canonical;
    }
  }

  const codes = stopCodesSet(stops);
  if (codes.has('CSMT')) {
    if (code === 'DR' || code === 'DDR') return 'CSMT';
  }

  return code;
}

export function toIrctcApiCodeConservative(code: string): string {
  const clean = code.toUpperCase().trim();
  if (IRCTC_CANONICAL[clean]) return IRCTC_CANONICAL[clean];
  return clean;
}

// PHASE_5B081: Origin-only explicit registry for trains whose name-parse yields incorrect
// results (e.g. 19031 "YOGA Nagari Express" -> "YOGA", which is not a station code).
// ONLY origin is stored here. Destination MUST NOT be added — train terminal != segment toCode.
const EXPLICIT_TRAIN_ORIGINS: Record<string, string> = {
  '19031': 'SBIB',   // Sabarmati BG — live verified
  '19032': 'LGH',    // Lalgarh Jn
  '19407': 'SBIB',   // Sabarmati BG — live verified
  '19408': 'LGH',    // Lalgarh Jn
  '19411': 'GNC',    // Gandhinagar Capital — live verified
  '19412': 'DLPC',   // Dilhi Pani
  '12989': 'DDR',    // Dadar — live verified
  '12990': 'AII',    // Ajmer Jn
};

// Words that appear at the start of train names but are NOT station codes.
const KNOWN_NON_STATION_WORDS = new Set([
  'YOGA', 'GARIB', 'VANDE', 'RAJDHANI', 'SHATABDI', 'DURONTO', 'EXPRESS',
  'SUPERFAST', 'MEMU', 'DEMU', 'PASSENGER', 'SPECIAL', 'JANSHATABDI',
  'EXP', 'SF', 'PGR', 'PASS', 'NEW', 'JAN', 'LINK', 'FAST',
]);

let registryMap: Record<string, string> | null = null;

/**
 * How much authority a resolved physical origin carries.
 *
 * `verified`     — hand-checked entry in EXPLICIT_TRAIN_ORIGINS (live verified against
 *                  the operator schedule). Safe to treat as the authoritative boarding
 *                  terminal and to reject cluster-alias substitutions against.
 * `live`         — PHASE_5B122. Derived from a structurally validated schedule that was
 *                  fetched from the live provider during this request. Authoritative.
 * `db-validated` — PHASE_5B122. Derived from a structurally validated `train_schedule`
 *                  row set. `train_schedule` is a shared multi-writer surface, so the
 *                  structural gate (see deriveOriginFromStops) is what confers authority
 *                  here — not the fact that the rows exist. Authoritative.
 * `inferred`     — derived by parsing the first word of the train NAME in
 *                  train_registry.json. Train names encode the route, not reliably the
 *                  boarding station, so this value is a heuristic hint only and MUST NOT
 *                  be used to override or reject an otherwise valid schedule stop.
 * `unknown`      — no reliable origin could be established.
 *
 * Only `verified`, `live` and `db-validated` are authoritative — see
 * isAuthoritativeOrigin(). `inferred` and `unknown` must NEVER authorise a substitution
 * guard, a schedule rewrite, or a candidate rejection.
 */
export type PhysicalOriginConfidence =
  | 'verified'
  | 'live'
  | 'db-validated'
  | 'inferred'
  | 'unknown';

export interface PhysicalOriginResult {
  code: string | null;
  confidence: PhysicalOriginConfidence;
}

/**
 * PHASE_5B122 — the authoritative tier.
 *
 * A single place that answers "may this origin be used to reject/override a station?"
 * so callers cannot drift apart by open-coding their own confidence comparisons.
 */
const AUTHORITATIVE_ORIGIN_CONFIDENCE: ReadonlySet<PhysicalOriginConfidence> = new Set<PhysicalOriginConfidence>([
  'verified',
  'live',
  'db-validated',
]);

export function isAuthoritativeOrigin(origin: PhysicalOriginResult | null | undefined): boolean {
  if (!origin || !origin.code) return false;
  return AUTHORITATIVE_ORIGIN_CONFIDENCE.has(origin.confidence);
}

/** Registry/table lookup key: trimmed, leading zeros stripped (09005 → 9005). */
function normalizeTrainKey(trainNo: string): string {
  return String(trainNo || '').trim().replace(/^0+/, '');
}

/**
 * PHASE_5B115 — confidence-typed physical origin lookup.
 *
 * Same resolution order as getPhysicalOriginFromRegistry(), but reports WHERE the
 * answer came from so callers can distinguish a hand-verified origin from a
 * name-parsed guess. Behaviourally identical in the `code` it returns.
 *
 * PHASE_5B122 — a miss now reports `unknown` instead of `inferred`. The `code` is
 * still null in exactly the same cases, so no existing caller changes behaviour, but
 * "we have no idea" is no longer indistinguishable from "we made a guess".
 */
export function getPhysicalOriginWithConfidence(trainNo: string): PhysicalOriginResult {
  const num = normalizeTrainKey(trainNo);

  // Fast-path: explicit table wins over generic name-parse (avoids false positives like YOGA)
  if (EXPLICIT_TRAIN_ORIGINS[num]) {
    return { code: EXPLICIT_TRAIN_ORIGINS[num], confidence: 'verified' };
  }

  if (!registryMap) {
    registryMap = {};
    try {
      const path = require('path');
      const fs = require('fs');
      const regPath = path.join(__dirname, '../data/train_registry.json');
      if (fs.existsSync(regPath)) {
        const list = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        const arr = Array.isArray(list) ? list : (list.trains || []);
        for (const item of arr) {
          if (item.trainNo && item.trainName) {
            const firstWord = item.trainName.split(' ')[0].toUpperCase().trim();
            if (
              firstWord.length >= 2 &&
              firstWord.length <= 5 &&
              !KNOWN_NON_STATION_WORDS.has(firstWord)
            ) {
              const cleanNum = String(item.trainNo).trim().replace(/^0+/, '');
              registryMap[cleanNum] = firstWord;
            }
          }
        }
      }
    } catch { /* optional offline lookup */ }
  }
  const named = registryMap[num] || null;
  return named
    ? { code: named, confidence: 'inferred' }
    : { code: null, confidence: 'unknown' };
}

/**
 * PHASE_5B129 — getPhysicalOriginFromRegistry() was REMOVED here.
 *
 * It returned `string | null`, discarding the confidence that
 * getPhysicalOriginWithConfidence() had just computed. Because it was the single
 * entry point used by every origin-sensitive call site, all of them received an
 * authority-free code and could not tell a hand-verified terminal from a
 * train-NAME first-word guess. That is what allowed an `inferred` origin to
 * rewrite a physical Station_Code.
 *
 * Callers now use getPhysicalOriginWithConfidence() and, where the answer
 * authorises a rewrite/rejection, gate on isAuthoritativeOrigin(). Detection may
 * still use `.code` at any confidence — see decideOriginCorrection() below for
 * why detection and mutation are deliberately separable.
 */

// ───────────────────────────────────────────────────────────────────────────
// PHASE_5B122 — CANONICAL STOP-SEQUENCE NORMALIZATION
// ───────────────────────────────────────────────────────────────────────────

/**
 * Outcome of normalizing one stop's sequence number.
 *
 * `valid`   — the provider supplied a usable integer sequence.
 * `missing` — the provider supplied no sequence field at all. NOT an error in
 *             itself, but callers must NOT invent one (see below).
 * `invalid` — a sequence field was present but unusable (NaN, Infinity,
 *             negative, non-integer).
 */
export type StopSequenceStatus = 'valid' | 'missing' | 'invalid';

export interface NormalizedStopSequence {
  status: StopSequenceStatus;
  /** Only populated when status === 'valid'. */
  value: number | null;
}

/**
 * PHASE_5B122 — the ONE canonical stop-sequence normalizer.
 *
 * Every schedule mapper in this repo previously open-coded its own SN expression,
 * and they disagreed in ways that mattered:
 *
 *   - `s.sn || s.SN || s.dayNum || idx + 1`      (trainStationResolver)
 *   - `s.sn || s.SN || s.sequence || (idx + 1)`  (splitJourneyEngine)
 *   - `Number(s.serialNo ?? s.sn ?? (idx + 1))`  (sync job)
 *
 * Three deliberate exclusions, each load-bearing:
 *
 *  1. `dayNum` is a JOURNEY-DAY index (1,2,3 for a multi-day train), not a stop
 *     sequence — the repo's own day arithmetic multiplies it by 1440 minutes.
 *     Using it as SN collapses an entire route onto 1-3 values and makes the
 *     duplicate/monotonic checks below fire (or, worse, silently pass on a
 *     two-stop day-1 slice). It MUST NEVER become a stop sequence.
 *  2. `sequence` is not proven anywhere in this codebase to carry stop-sequence
 *     semantics, so it is not trusted here. Adding it later requires evidence.
 *  3. `idx + 1` FABRICATES a sequence the provider never sent. That is exactly
 *     what masked NON_INCREASING_SN / DUPLICATE_SN corruption from every
 *     structural check: array position is always monotonic and always unique, so
 *     substituting it guarantees the check passes. Positional fallback is a
 *     legitimate *display* convenience; it is not evidence, and this helper — the
 *     one feeding the origin authority gate — will not produce it.
 *
 * Priority is serialNo → sn → SN. A present-but-garbage field falls through to the
 * next candidate rather than poisoning the result.
 *
 * A literal 0 is PRESERVED here (0 can be a legitimate 0-based provider index).
 * Whether 0 is structurally acceptable for a given schedule is decided later, by
 * deriveOriginFromStops() — normalization does not get to make that call.
 */
export function normalizeStopSN(stop: any): NormalizedStopSequence {
  if (!stop || typeof stop !== 'object') return { status: 'missing', value: null };

  // PHASE_5B122 — provenance marker. Mappers that must keep emitting a positional SN
  // for legacy ordering comparisons stamp `_snProvided: false` so this helper — and
  // therefore the origin authority gate — still sees the truth: the provider sent
  // nothing. Without this, a fabricated `idx + 1` would be indistinguishable from a
  // real sequence at exactly the point where the distinction decides authority.
  if (stop._snProvided === false) return { status: 'missing', value: null };

  // Order matters. dayNum, sequence and array position are intentionally absent.
  const candidateKeys = ['serialNo', 'sn', 'SN'];

  let sawCandidate = false;
  for (const key of candidateKeys) {
    const raw = stop[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    if (typeof raw === 'boolean') continue; // Number(true) === 1 — never a sequence
    sawCandidate = true;

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;   // NaN, Infinity, -Infinity
    if (!Number.isInteger(n)) continue;  // 2.5 is not a stop sequence
    if (n < 0) continue;                 // negative sequences are meaningless

    return { status: 'valid', value: n };
  }

  return { status: sawCandidate ? 'invalid' : 'missing', value: null };
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE_5B122 — SCHEDULE-BACKED PHYSICAL ORIGIN DERIVATION
// ───────────────────────────────────────────────────────────────────────────

/** Provenance of a stop array that is allowed to establish an authoritative origin. */
export type ScheduleStopsSource = 'irctc' | 'db';

/** What the caller may pass when no authoritative schedule was obtained. */
export type ScheduleStopsProvenance = ScheduleStopsSource | 'none';

export type OriginDerivationRejection =
  | 'NO_STOPS'
  | 'TOO_FEW_STOPS'
  | 'INVALID_ORIGIN_CODE'
  | 'INVALID_STATION_CODE'
  | 'MISSING_SN'
  | 'INVALID_SN'
  | 'DUPLICATE_SN'
  | 'NON_INCREASING_SN'
  | 'MIN_SN_NOT_AT_POSITION_0'
  | 'SN_DOES_NOT_START_AT_ORIGIN';

export interface OriginDerivation {
  ok: boolean;
  /** Literal station code from the schedule — never alias-canonicalised. */
  code: string | null;
  reason: OriginDerivationRejection | null;
}

/**
 * Structural shape of a station code. PHASE_5B122 note — this is deliberately NOT a
 * catalog membership test.
 *
 * PART C of the 5B122 brief asked to use "the existing station catalog mechanism if it
 * is already safely available to this pure helper", and to STOP and report the conflict
 * otherwise. It is not available: `stationService` imports the Supabase client at module
 * scope and fires a `station_registry` query from a module-load IIFE, so importing it
 * here would break this module's documented "no I/O — safe for unit tests" contract and
 * issue a network call on require. `OfflineStationProvider` and `utils/stationMapper` are
 * pure but carry only alias/city maps, not a station-code catalog.
 *
 * So validity is structural only. That is the fail-SAFE direction for this gate: a code
 * that is structurally fine but fictional yields at worst a derivation the guard then
 * treats as authoritative for a train that has no such stop — which blocks a
 * substitution rather than inventing one. Catalog-backed validation belongs in a phase
 * that is allowed to touch the I/O boundary.
 */
function isStructurallyValidStationCode(code: string): boolean {
  return /^[A-Z0-9]{2,8}$/.test(code);
}

/**
 * PHASE_5B122 — derive the physical origin from an authoritative stop array.
 *
 * Fail-closed by construction: every rejection below routes the caller back to the
 * name-parsed `inferred` tier (or `unknown`), which carries no authority. A wrong
 * `ok: false` costs us a guard activation; a wrong `ok: true` invents a boarding
 * station a passenger cannot use. The asymmetry is the whole design.
 *
 * Rules enforced (5B122 PART C):
 *   1. at least 3 stops — two-stop fragments are not routes
 *   2. every station code structurally valid
 *   3. every stop's SN normalised through normalizeStopSN()
 *   4. no duplicate SN
 *   5. SN strictly increasing across array order
 *   6. the minimum SN must sit at array position 0
 *   7. no forward scan when stops[0] is missing/invalid — reject instead
 *   8. no alias canonicalisation during derivation
 *   9. the literal schedule code is preserved
 *  10. cluster compatibility is not identity — duplicate station codes are allowed
 *
 * Plus one strictness rule 5B122 did not enumerate but the origin tier requires: the
 * sequence must START at 0 or 1. A stop list beginning at SN 5 is a TRUNCATED route
 * (a partially synced train), and its stops[0] is emphatically not the origin. Rules
 * 5-6 alone cannot see that, because a truncated list is still ordered and still has
 * its minimum first.
 */
export function deriveOriginFromStops(stops: ReadonlyArray<any> | null | undefined): OriginDerivation {
  const reject = (reason: OriginDerivationRejection): OriginDerivation => ({ ok: false, code: null, reason });

  if (!Array.isArray(stops) || stops.length === 0) return reject('NO_STOPS');
  if (stops.length < 3) return reject('TOO_FEW_STOPS');

  // Rule 7 — stops[0] is the only candidate. If it is unusable, reject; never scan on.
  const originCode = String(stops[0]?.Station_Code ?? '').toUpperCase().trim();
  if (!isStructurallyValidStationCode(originCode)) return reject('INVALID_ORIGIN_CODE');

  const seen = new Set<number>();
  let prevSN = -1;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];

    // Rule 2 / rule 10 — code shape only. Repeated codes are legal (loop lines,
    // reversals), and an alias of the origin later on the route is a DIFFERENT
    // station, not a duplicate of it.
    const code = String(stop?.Station_Code ?? '').toUpperCase().trim();
    if (!isStructurallyValidStationCode(code)) return reject('INVALID_STATION_CODE');

    // Rule 3 — canonical normalisation, no positional fabrication.
    const sn = normalizeStopSN(stop);
    if (sn.status === 'missing') return reject('MISSING_SN');
    if (sn.status !== 'valid' || sn.value === null) return reject('INVALID_SN');

    // Rule 4
    if (seen.has(sn.value)) return reject('DUPLICATE_SN');
    seen.add(sn.value);

    // Rule 5 — strictly increasing in ARRAY order, which also enforces rule 6:
    // if the minimum sat anywhere but position 0, some later stop would have to
    // decrease to reach it.
    if (i > 0 && sn.value <= prevSN) return reject('NON_INCREASING_SN');

    if (i === 0) {
      // Explicit rule 6 assertion, and the truncation guard.
      if (sn.value > 1) return reject('SN_DOES_NOT_START_AT_ORIGIN');
    }

    prevSN = sn.value;
  }

  // Belt and braces on rule 6: nothing above can produce a smaller SN later, but
  // state this invariant where a future edit would trip over it.
  const minSN = Math.min(...Array.from(seen));
  const firstSN = normalizeStopSN(stops[0]).value;
  if (firstSN === null || minSN !== firstSN) return reject('MIN_SN_NOT_AT_POSITION_0');

  // Rule 8 / rule 9 — the literal code, exactly as the authoritative schedule spelled it.
  return { ok: true, code: originCode, reason: null };
}

/**
 * PHASE_5B122 — schedule-aware physical origin resolution.
 *
 * Priority, highest first:
 *   1. EXPLICIT_TRAIN_ORIGINS               → 'verified'      (a schedule may NEVER override this)
 *   2. structurally validated live schedule → 'live'
 *   3. structurally validated DB schedule   → 'db-validated'
 *   4. train-name parse                     → 'inferred'      (never authoritative)
 *   5. nothing                              → 'unknown'
 *
 * `stopsSource` is the caller's declared provenance and is the ONLY thing that decides
 * between 'live' and 'db-validated'. Provenance is never sniffed from the contents of
 * the array — a DB row set and a live payload are shape-identical by the time they get
 * here, which is precisely how the two got conflated in the first place.
 */
export function resolvePhysicalOrigin(
  trainNo: string,
  stops: ReadonlyArray<any> | null | undefined,
  stopsSource: ScheduleStopsProvenance | null | undefined
): PhysicalOriginResult {
  const num = normalizeTrainKey(trainNo);

  // 1. Hand-verified table always wins. A schedule cannot demote it.
  if (EXPLICIT_TRAIN_ORIGINS[num]) {
    return { code: EXPLICIT_TRAIN_ORIGINS[num], confidence: 'verified' };
  }

  // 2/3. Schedule-derived, but only from a declared authoritative source.
  if (stopsSource === 'irctc' || stopsSource === 'db') {
    const derived = deriveOriginFromStops(stops);
    if (derived.ok && derived.code) {
      return {
        code: derived.code,
        confidence: stopsSource === 'irctc' ? 'live' : 'db-validated',
      };
    }
  }

  // 4/5. Name parse, or nothing. Neither carries authority.
  return getPhysicalOriginWithConfidence(trainNo);
}

// ───────────────────────────────────────────────────────────────────────────
// PHASE_5B129 — PURE ORIGIN-CORRECTION AND SCHEDULE-CONTAINMENT DECISIONS
// ───────────────────────────────────────────────────────────────────────────
//
// These two functions hold the decisions that were previously inlined inside
// trainStationResolver's Supabase/IRCTC/cache orchestration, where they could not
// be executed offline. Supabase, IRCTC and the cache stay in that file; only the
// decisions move here, which is the module already declared "no I/O — safe for
// unit tests" at the top of this file. Nothing below performs I/O.

/**
 * Minimal shape a schedule row must have to take part in the origin decision.
 *
 * Deliberately narrower than ScheduleStopLike: the origin decision only ever reads
 * stops[0].Station_Code, so demanding an SN here would force callers to launder rows
 * the decision never looks at.
 */
export interface OriginDecisionStop {
  Station_Code: string;
}

export interface OriginCorrectionDecision<T extends OriginDecisionStop> {
  /**
   * The row set the caller should use. Always a NEW array — this helper never
   * mutates the caller's input, so a suppressed rewrite provably cannot leave a
   * half-modified array behind.
   */
  stops: T[];
  /**
   * PHASE_5B081 contract, preserved exactly: true when the DB origin disagreed
   * with a known physical origin in a cluster-compatible way.
   *
   * PHASE_5B129 — this is set on DETECTION and is deliberately INDEPENDENT of
   * whether the rewrite was permitted. It is the sole trigger for authoritative
   * live re-validation downstream (a compatible origin mismatch is evidence that
   * OTHER stops in the same DB row set may also be corrupt — e.g. AII at SN:8 for
   * 19407, which is not on the real SBIB→LGH route). Suppressing the rewrite while
   * clearing this flag would silently disable that re-validation and serve the
   * corrupt schedule as if it were trustworthy.
   */
  originCorrected: boolean;
  /** True only when stops[0].Station_Code was actually replaced. */
  rewriteApplied: boolean;
  /** The registry origin considered, at ANY confidence. Null when none is known. */
  registryOrigin: string | null;
  registryConfidence: PhysicalOriginConfidence;
  /** The DB origin as read (upper/trimmed), or null when there were no rows. */
  dbOrigin: string | null;
}

/**
 * PHASE_5B129 — decide whether a DB schedule's origin row should be rewritten.
 *
 * Two outputs that used to be one:
 *
 *   originCorrected — "the DB origin looks synthetic" (DETECTION). Set whenever a
 *                     non-null registry origin differs from stops[0] but is
 *                     cluster-compatible with it, at any confidence.
 *   rewriteApplied  — "stops[0].Station_Code was replaced" (MUTATION). Requires
 *                     isAuthoritativeOrigin(), i.e. verified/live/db-validated.
 *
 * Splitting them is the whole point of this phase. An `inferred` origin is the first
 * word of the train NAME in train_registry.json; train names encode the route, not
 * reliably the boarding terminal. Letting that guess overwrite a physical
 * Station_Code fabricates a boarding station a passenger cannot actually use, and the
 * rewritten code then flows into the IRCTC availability call, the response, both
 * caches and the learned station-mapping table. So the guess may still RAISE
 * SUSPICION (cheap, reversible, triggers a live re-check) but may never CHANGE
 * STATION IDENTITY.
 *
 * ── Do NOT "upgrade" the lookup below to resolvePhysicalOrigin(trainNo, rows, 'db') ──
 * That looks like a strictly better call, and it is a silent trap: with
 * stopsSource='db' that function derives the origin from rows[0].Station_Code — the
 * very value being checked. The comparison would become `x !== x`, the mismatch could
 * never fire, and the entire 5B081 corruption detector would go dark with every test
 * still green. The registry lookup here must stay independent of the rows.
 */
export function decideOriginCorrection<T extends OriginDecisionStop>(
  rows: ReadonlyArray<T> | null | undefined,
  trainNo: string
): OriginCorrectionDecision<T> {
  const stops: T[] = Array.isArray(rows) ? rows.slice() : [];
  const origin = getPhysicalOriginWithConfidence(trainNo);
  const registryOrigin = origin.code;

  if (!registryOrigin || stops.length === 0) {
    return {
      stops,
      originCorrected: false,
      rewriteApplied: false,
      registryOrigin,
      registryConfidence: origin.confidence,
      dbOrigin: stops.length > 0 ? String(stops[0].Station_Code || '').toUpperCase().trim() : null,
    };
  }

  const dbOrigin = String(stops[0].Station_Code || '').toUpperCase().trim();

  // Cluster-compatible mismatch only. An unrelated station at stops[0] is a
  // different route, not a synthetic overwrite, and is left entirely alone.
  const mismatch = dbOrigin !== registryOrigin && areStationsCompatible(dbOrigin, registryOrigin);
  if (!mismatch) {
    return {
      stops,
      originCorrected: false,
      rewriteApplied: false,
      registryOrigin,
      registryConfidence: origin.confidence,
      dbOrigin,
    };
  }

  let rewriteApplied = false;
  if (isAuthoritativeOrigin(origin)) {
    stops[0] = { ...stops[0], Station_Code: registryOrigin };
    rewriteApplied = true;
  }

  return {
    stops,
    // Set for BOTH branches — see the field docs above.
    originCorrected: true,
    rewriteApplied,
    registryOrigin,
    registryConfidence: origin.confidence,
    dbOrigin,
  };
}

export interface LiveScheduleRequirementInput {
  dbStopCount: number;
  originCorrected: boolean;
  hasFrom: boolean;
  hasTo: boolean;
}

/**
 * PHASE_5B129 — the live-fallback trigger, extracted verbatim.
 *
 * `originCorrected` remains a disjunct here. This is the link that carries
 * suspicion from decideOriginCorrection() to the authoritative live re-fetch;
 * removing it would leave a detected-corrupt DB schedule to be served as `db` and
 * cached, which is strictly worse than the pre-fix behaviour and completely silent.
 */
export function isLiveScheduleRequired(input: LiveScheduleRequirementInput): boolean {
  return input.dbStopCount <= 2 || !input.hasFrom || !input.hasTo || input.originCorrected;
}

export interface ScheduleContextDecisionInput<T extends OriginDecisionStop> {
  dbStops: ReadonlyArray<T> | null | undefined;
  originCorrected: boolean;
  /** Live rows, or null/empty when no fetch was made, it threw, or it returned nothing. */
  liveStops: ReadonlyArray<T> | null | undefined;
  hasFrom: boolean;
  hasTo: boolean;
}

export interface ScheduleContextDecision<T extends OriginDecisionStop> {
  stops: T[];
  source: ScheduleStopsProvenance;
  /** Whether a live fetch was warranted — recomputed here so callers cannot drift. */
  liveRequired: boolean;
  /** Whether live rows actually replaced the DB rows. */
  liveApplied: boolean;
}

/**
 * PHASE_5B129 — decide the final stop list and its provenance.
 *
 * The containment rule that matters: when live rows are unavailable, the ORIGINAL DB
 * rows pass through untouched and keep `source: 'db'`. Combined with the suppressed
 * rewrite above, that means a live-fetch failure can no longer leave an inferred
 * station code in the served context. Previously the rewrite had already been applied
 * in place, so a failed fetch silently published the fabricated origin — this file's
 * path had no equivalent of splitJourneyEngine's fail-closed leg rejection.
 */
export function decideScheduleContext<T extends OriginDecisionStop>(
  input: ScheduleContextDecisionInput<T>
): ScheduleContextDecision<T> {
  const dbStops: T[] = Array.isArray(input.dbStops) ? input.dbStops.slice() : [];
  const liveStops: T[] = Array.isArray(input.liveStops) ? input.liveStops.slice() : [];

  const liveRequired = isLiveScheduleRequired({
    dbStopCount: dbStops.length,
    originCorrected: input.originCorrected,
    hasFrom: input.hasFrom,
    hasTo: input.hasTo,
  });

  if (liveStops.length > 0) {
    return { stops: liveStops, source: 'irctc', liveRequired, liveApplied: true };
  }

  return {
    stops: dbStops,
    source: dbStops.length > 0 ? 'db' : 'none',
    liveRequired,
    liveApplied: false,
  };
}

export function findStopOnSchedule(stops: ScheduleStopLike[], userCode: string): ScheduleStopLike | null {
  const c = userCode.toUpperCase().trim();
  if (!c) return null;
  // Prefer exact schedule code first. Alias match (e.g. CSMT↔DR) must not steal an
  // earlier intermediate stop when the true terminal exists later on the train.
  const exact = stops.find(s => s.Station_Code.toUpperCase().trim() === c);
  if (exact) return exact;
  return stops.find(s => areStationsCompatible(s.Station_Code, c)) || null;
}

export function mapProviderErrorToReason(errorMsg: string, isDateNonRunning?: boolean): string {
  const msg = (errorMsg || '').toLowerCase();
  if (isDateNonRunning) return 'TRAIN_NOT_RUNNING';
  if (msg.includes('intermediate station')) return 'SEGMENT_NOT_BOOKABLE';
  if (msg.includes('does not run') || msg.includes('not available for booking') || msg.includes('train not running')) return 'TRAIN_NOT_RUNNING';
  if (msg.includes('class does not exist') || msg.includes('not available') || msg.includes('invalid train')) {
    return 'CLASS_NOT_AVAILABLE';
  }
  if (msg.includes('unable to process your request') || msg.includes('bad request') || msg.includes('400')) {
    return isDateNonRunning ? 'TRAIN_NOT_RUNNING' : 'PROVIDER_REQUEST_REJECTED';
  }
  // Infra/auth/rate-limit errors must not become CLASS_NOT_AVAILABLE (hard "Route Unavailable" overlay).
  return 'PROVIDER_UNAVAILABLE';
}