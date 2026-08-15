"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopCodesSet = stopCodesSet;
exports.toIrctcApiCode = toIrctcApiCode;
exports.toIrctcApiCodeConservative = toIrctcApiCodeConservative;
exports.isAuthoritativeOrigin = isAuthoritativeOrigin;
exports.getPhysicalOriginWithConfidence = getPhysicalOriginWithConfidence;
exports.normalizeStopSN = normalizeStopSN;
exports.deriveOriginFromStops = deriveOriginFromStops;
exports.resolvePhysicalOrigin = resolvePhysicalOrigin;
exports.decideOriginCorrection = decideOriginCorrection;
exports.isLiveScheduleRequired = isLiveScheduleRequired;
exports.decideScheduleContext = decideScheduleContext;
exports.findStopOnSchedule = findStopOnSchedule;
exports.mapProviderErrorToReason = mapProviderErrorToReason;
/**
 * PHASE_4C862 — Pure station resolution helpers (no I/O — safe for unit tests).
 */
const stationAliases_1 = require("./stationAliases");
function stopCodesSet(stops) {
    return new Set(stops.map(s => s.Station_Code.toUpperCase().trim()));
}
function toIrctcApiCode(scheduleStopCode, stops) {
    const code = scheduleStopCode.toUpperCase().trim();
    if (!code)
        return code;
    const canonical = stationAliases_1.IRCTC_CANONICAL[code];
    if (canonical) {
        const codes = stopCodesSet(stops);
        if (codes.has(canonical) || !codes.has(code)) {
            return canonical;
        }
    }
    const codes = stopCodesSet(stops);
    if (codes.has('CSMT')) {
        if (code === 'DR' || code === 'DDR')
            return 'CSMT';
    }
    return code;
}
function toIrctcApiCodeConservative(code) {
    const clean = code.toUpperCase().trim();
    if (stationAliases_1.IRCTC_CANONICAL[clean])
        return stationAliases_1.IRCTC_CANONICAL[clean];
    return clean;
}
// PHASE_5B081: Origin-only explicit registry for trains whose name-parse yields incorrect
// results (e.g. 19031 "YOGA Nagari Express" -> "YOGA", which is not a station code).
// ONLY origin is stored here. Destination MUST NOT be added — train terminal != segment toCode.
const EXPLICIT_TRAIN_ORIGINS = {
    '19031': 'SBIB', // Sabarmati BG — live verified
    '19032': 'LGH', // Lalgarh Jn
    '19407': 'SBIB', // Sabarmati BG — live verified
    '19408': 'LGH', // Lalgarh Jn
    '19411': 'GNC', // Gandhinagar Capital — live verified
    '19412': 'DLPC', // Dilhi Pani
    '12989': 'DDR', // Dadar — live verified
    '12990': 'AII', // Ajmer Jn
};
// Words that appear at the start of train names but are NOT station codes.
const KNOWN_NON_STATION_WORDS = new Set([
    'YOGA', 'GARIB', 'VANDE', 'RAJDHANI', 'SHATABDI', 'DURONTO', 'EXPRESS',
    'SUPERFAST', 'MEMU', 'DEMU', 'PASSENGER', 'SPECIAL', 'JANSHATABDI',
    'EXP', 'SF', 'PGR', 'PASS', 'NEW', 'JAN', 'LINK', 'FAST',
]);
let registryMap = null;
/**
 * PHASE_5B122 — the authoritative tier.
 *
 * A single place that answers "may this origin be used to reject/override a station?"
 * so callers cannot drift apart by open-coding their own confidence comparisons.
 */
const AUTHORITATIVE_ORIGIN_CONFIDENCE = new Set([
    'verified',
    'live',
    'db-validated',
]);
function isAuthoritativeOrigin(origin) {
    if (!origin || !origin.code)
        return false;
    return AUTHORITATIVE_ORIGIN_CONFIDENCE.has(origin.confidence);
}
/** Registry/table lookup key: trimmed, leading zeros stripped (09005 → 9005). */
function normalizeTrainKey(trainNo) {
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
function getPhysicalOriginWithConfidence(trainNo) {
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
                        if (firstWord.length >= 2 &&
                            firstWord.length <= 5 &&
                            !KNOWN_NON_STATION_WORDS.has(firstWord)) {
                            const cleanNum = String(item.trainNo).trim().replace(/^0+/, '');
                            registryMap[cleanNum] = firstWord;
                        }
                    }
                }
            }
        }
        catch { /* optional offline lookup */ }
    }
    const named = registryMap[num] || null;
    return named
        ? { code: named, confidence: 'inferred' }
        : { code: null, confidence: 'unknown' };
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
function normalizeStopSN(stop) {
    if (!stop || typeof stop !== 'object')
        return { status: 'missing', value: null };
    // PHASE_5B122 — provenance marker. Mappers that must keep emitting a positional SN
    // for legacy ordering comparisons stamp `_snProvided: false` so this helper — and
    // therefore the origin authority gate — still sees the truth: the provider sent
    // nothing. Without this, a fabricated `idx + 1` would be indistinguishable from a
    // real sequence at exactly the point where the distinction decides authority.
    if (stop._snProvided === false)
        return { status: 'missing', value: null };
    // Order matters. dayNum, sequence and array position are intentionally absent.
    const candidateKeys = ['serialNo', 'sn', 'SN'];
    let sawCandidate = false;
    for (const key of candidateKeys) {
        const raw = stop[key];
        if (raw === undefined || raw === null)
            continue;
        if (typeof raw === 'string' && raw.trim() === '')
            continue;
        if (typeof raw === 'boolean')
            continue; // Number(true) === 1 — never a sequence
        sawCandidate = true;
        const n = Number(raw);
        if (!Number.isFinite(n))
            continue; // NaN, Infinity, -Infinity
        if (!Number.isInteger(n))
            continue; // 2.5 is not a stop sequence
        if (n < 0)
            continue; // negative sequences are meaningless
        return { status: 'valid', value: n };
    }
    return { status: sawCandidate ? 'invalid' : 'missing', value: null };
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
function isStructurallyValidStationCode(code) {
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
function deriveOriginFromStops(stops) {
    const reject = (reason) => ({ ok: false, code: null, reason });
    if (!Array.isArray(stops) || stops.length === 0)
        return reject('NO_STOPS');
    if (stops.length < 3)
        return reject('TOO_FEW_STOPS');
    // Rule 7 — stops[0] is the only candidate. If it is unusable, reject; never scan on.
    const originCode = String(stops[0]?.Station_Code ?? '').toUpperCase().trim();
    if (!isStructurallyValidStationCode(originCode))
        return reject('INVALID_ORIGIN_CODE');
    const seen = new Set();
    let prevSN = -1;
    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        // Rule 2 / rule 10 — code shape only. Repeated codes are legal (loop lines,
        // reversals), and an alias of the origin later on the route is a DIFFERENT
        // station, not a duplicate of it.
        const code = String(stop?.Station_Code ?? '').toUpperCase().trim();
        if (!isStructurallyValidStationCode(code))
            return reject('INVALID_STATION_CODE');
        // Rule 3 — canonical normalisation, no positional fabrication.
        const sn = normalizeStopSN(stop);
        if (sn.status === 'missing')
            return reject('MISSING_SN');
        if (sn.status !== 'valid' || sn.value === null)
            return reject('INVALID_SN');
        // Rule 4
        if (seen.has(sn.value))
            return reject('DUPLICATE_SN');
        seen.add(sn.value);
        // Rule 5 — strictly increasing in ARRAY order, which also enforces rule 6:
        // if the minimum sat anywhere but position 0, some later stop would have to
        // decrease to reach it.
        if (i > 0 && sn.value <= prevSN)
            return reject('NON_INCREASING_SN');
        if (i === 0) {
            // Explicit rule 6 assertion, and the truncation guard.
            if (sn.value > 1)
                return reject('SN_DOES_NOT_START_AT_ORIGIN');
        }
        prevSN = sn.value;
    }
    // Belt and braces on rule 6: nothing above can produce a smaller SN later, but
    // state this invariant where a future edit would trip over it.
    const minSN = Math.min(...Array.from(seen));
    const firstSN = normalizeStopSN(stops[0]).value;
    if (firstSN === null || minSN !== firstSN)
        return reject('MIN_SN_NOT_AT_POSITION_0');
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
function resolvePhysicalOrigin(trainNo, stops, stopsSource) {
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
function decideOriginCorrection(rows, trainNo) {
    const stops = Array.isArray(rows) ? rows.slice() : [];
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
    const mismatch = dbOrigin !== registryOrigin && (0, stationAliases_1.areStationsCompatible)(dbOrigin, registryOrigin);
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
/**
 * PHASE_5B129 — the live-fallback trigger, extracted verbatim.
 *
 * `originCorrected` remains a disjunct here. This is the link that carries
 * suspicion from decideOriginCorrection() to the authoritative live re-fetch;
 * removing it would leave a detected-corrupt DB schedule to be served as `db` and
 * cached, which is strictly worse than the pre-fix behaviour and completely silent.
 */
function isLiveScheduleRequired(input) {
    return input.dbStopCount <= 2 || !input.hasFrom || !input.hasTo || input.originCorrected;
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
function decideScheduleContext(input) {
    const dbStops = Array.isArray(input.dbStops) ? input.dbStops.slice() : [];
    const liveStops = Array.isArray(input.liveStops) ? input.liveStops.slice() : [];
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
function findStopOnSchedule(stops, userCode) {
    const c = userCode.toUpperCase().trim();
    if (!c)
        return null;
    // Prefer exact schedule code first. Alias match (e.g. CSMT↔DR) must not steal an
    // earlier intermediate stop when the true terminal exists later on the train.
    const exact = stops.find(s => s.Station_Code.toUpperCase().trim() === c);
    if (exact)
        return exact;
    return stops.find(s => (0, stationAliases_1.areStationsCompatible)(s.Station_Code, c)) || null;
}
function mapProviderErrorToReason(errorMsg, isDateNonRunning) {
    const msg = (errorMsg || '').toLowerCase();
    if (isDateNonRunning)
        return 'TRAIN_NOT_RUNNING';
    if (msg.includes('intermediate station'))
        return 'SEGMENT_NOT_BOOKABLE';
    if (msg.includes('does not run') || msg.includes('not available for booking') || msg.includes('train not running'))
        return 'TRAIN_NOT_RUNNING';
    if (msg.includes('class does not exist') || msg.includes('not available') || msg.includes('invalid train')) {
        return 'CLASS_NOT_AVAILABLE';
    }
    if (msg.includes('unable to process your request') || msg.includes('bad request') || msg.includes('400')) {
        return isDateNonRunning ? 'TRAIN_NOT_RUNNING' : 'PROVIDER_REQUEST_REJECTED';
    }
    // Infra/auth/rate-limit errors must not become CLASS_NOT_AVAILABLE (hard "Route Unavailable" overlay).
    return 'PROVIDER_UNAVAILABLE';
}
