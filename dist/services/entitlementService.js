"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.entitlementService = exports.EntitlementService = void 0;
exports.getTodayDateString = getTodayDateString;
exports.getLedgerPath = getLedgerPath;
exports.getBackupPath = getBackupPath;
exports.getLockDirPath = getLockDirPath;
exports.validateLedgerStructure = validateLedgerStructure;
exports.saveLedgerAtomic = saveLedgerAtomic;
exports.getLedgerSafe = getLedgerSafe;
const authService_1 = require("./authService");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function getTodayDateString() {
    // Use Indian Standard Time (UTC+5:30) for daily calendar reset alignment
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    return istDate.toISOString().split('T')[0];
}
function getLedgerPath() {
    if (process.env.FREE_QUOTA_LEDGER_PATH) {
        return process.env.FREE_QUOTA_LEDGER_PATH;
    }
    const cwd = process.cwd();
    if (fs_1.default.existsSync(path_1.default.join(cwd, 'data', 'free_quota_ledger.json'))) {
        return path_1.default.join(cwd, 'data', 'free_quota_ledger.json');
    }
    if (fs_1.default.existsSync(path_1.default.join(cwd, '..', 'data', 'free_quota_ledger.json'))) {
        return path_1.default.join(cwd, '..', 'data', 'free_quota_ledger.json');
    }
    return path_1.default.join(cwd, 'data', 'free_quota_ledger.json');
}
function getBackupPath(ledgerPath) {
    return `${ledgerPath}.bak`;
}
function getLockDirPath(ledgerPath) {
    return `${ledgerPath}.lock`;
}
function validateLedgerStructure(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }
    for (const [, value] of Object.entries(data)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        const val = value;
        if (val.rescueUsedOn !== undefined && (typeof val.rescueUsedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.rescueUsedOn))) {
            return false;
        }
        if (val.splitUsedOn !== undefined && (typeof val.splitUsedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.splitUsedOn))) {
            return false;
        }
        if (val.reservations !== undefined && (typeof val.reservations !== 'object' || Array.isArray(val.reservations))) {
            return false;
        }
    }
    return true;
}
function saveLedgerAtomic(ledger, ledgerPath = getLedgerPath()) {
    const dir = path_1.default.dirname(ledgerPath);
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    const tempPath = path_1.default.join(dir, `.tmp_ledger_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.tmp`);
    const backupPath = getBackupPath(ledgerPath);
    const payload = JSON.stringify(ledger, null, 2);
    // 1. Write full content to temporary file
    fs_1.default.writeFileSync(tempPath, payload, 'utf8');
    // 2. Read back from temp file and parse to guarantee file was written cleanly
    const readBack = fs_1.default.readFileSync(tempPath, 'utf8');
    const parsed = JSON.parse(readBack);
    if (!validateLedgerStructure(parsed)) {
        try {
            fs_1.default.unlinkSync(tempPath);
        }
        catch { }
        throw new Error('Ledger write failed validation check before atomic commit');
    }
    // 3. Update backup snapshot from current valid primary file before replacing
    try {
        if (fs_1.default.existsSync(ledgerPath)) {
            const currentPrimary = fs_1.default.readFileSync(ledgerPath, 'utf8');
            if (currentPrimary.trim().length > 0) {
                const curParsed = JSON.parse(currentPrimary);
                if (validateLedgerStructure(curParsed)) {
                    fs_1.default.copyFileSync(ledgerPath, backupPath);
                }
            }
        }
    }
    catch { }
    // 4. Atomic rename replaces destination file atomically
    fs_1.default.renameSync(tempPath, ledgerPath);
}
function getLedgerSafe(ledgerPath = getLedgerPath()) {
    const backupPath = getBackupPath(ledgerPath);
    // 1. Try reading primary ledger file
    if (fs_1.default.existsSync(ledgerPath)) {
        try {
            const content = fs_1.default.readFileSync(ledgerPath, 'utf8');
            if (content.trim().length > 0) {
                const parsed = JSON.parse(content);
                if (validateLedgerStructure(parsed)) {
                    return parsed;
                }
                console.warn('[ENTITLEMENT_DURABILITY] Primary ledger failed schema validation. Checking backup...');
            }
            else {
                console.warn('[ENTITLEMENT_DURABILITY] Primary ledger is 0 bytes (truncated). Checking backup...');
            }
        }
        catch (primaryErr) {
            console.warn(`[ENTITLEMENT_DURABILITY] Primary ledger parse error (${primaryErr.message}). Checking backup...`);
        }
    }
    // 2. Attempt recovery from backup snapshot
    if (fs_1.default.existsSync(backupPath)) {
        try {
            const backupContent = fs_1.default.readFileSync(backupPath, 'utf8');
            if (backupContent.trim().length > 0) {
                const recovered = JSON.parse(backupContent);
                if (validateLedgerStructure(recovered)) {
                    console.info('[ENTITLEMENT_DURABILITY] Successfully recovered valid ledger state from backup snapshot.');
                    saveLedgerAtomic(recovered, ledgerPath);
                    return recovered;
                }
            }
        }
        catch (backupErr) {
            console.error(`[ENTITLEMENT_DURABILITY] Backup ledger parse error (${backupErr.message}).`);
        }
    }
    // 3. Fallback to legacy single-entry ledger if this is first migration
    const legacyPath = path_1.default.join(path_1.default.dirname(ledgerPath), 'free_rescue_ledger.json');
    if (fs_1.default.existsSync(legacyPath)) {
        try {
            const legacy = JSON.parse(fs_1.default.readFileSync(legacyPath, 'utf8'));
            const upgraded = {};
            for (const [uid, val] of Object.entries(legacy)) {
                if (typeof val === 'string') {
                    upgraded[uid] = { rescueUsedOn: val.split('T')[0] };
                }
                else if (typeof val === 'object' && val !== null) {
                    upgraded[uid] = val;
                }
            }
            if (validateLedgerStructure(upgraded)) {
                saveLedgerAtomic(upgraded, ledgerPath);
                return upgraded;
            }
        }
        catch { }
    }
    // 4. If primary file existed with corrupt content and backup failed, preserve corrupt file for forensics
    if (fs_1.default.existsSync(ledgerPath)) {
        try {
            const corruptDest = `${ledgerPath}.corrupt.${Date.now()}`;
            fs_1.default.copyFileSync(ledgerPath, corruptDest);
            console.error(`[ENTITLEMENT_DURABILITY] Preserved unparseable primary ledger to ${corruptDest}`);
        }
        catch { }
    }
    return {};
}
class EntitlementService {
    constructor() {
        this.inProcessLock = Promise.resolve();
    }
    async acquireCrossProcessLock(fn) {
        const previous = this.inProcessLock;
        let releaseInProcess;
        this.inProcessLock = new Promise(resolve => { releaseInProcess = resolve; });
        await previous;
        const ledgerPath = getLedgerPath();
        const lockDir = getLockDirPath(ledgerPath);
        const timeoutMs = 8000;
        const retryDelayMs = 25;
        const staleLockThresholdMs = 10000;
        const start = Date.now();
        let dirLockAcquired = false;
        try {
            const parentDir = path_1.default.dirname(lockDir);
            if (!fs_1.default.existsSync(parentDir))
                fs_1.default.mkdirSync(parentDir, { recursive: true });
            while (!dirLockAcquired) {
                try {
                    fs_1.default.mkdirSync(lockDir);
                    dirLockAcquired = true;
                }
                catch (err) {
                    if (err.code !== 'EEXIST')
                        throw err;
                    try {
                        const stat = fs_1.default.statSync(lockDir);
                        if (Date.now() - stat.mtimeMs > staleLockThresholdMs) {
                            console.warn('[ENTITLEMENT_DURABILITY] Stale directory lock detected. Forcing lock removal.');
                            try {
                                fs_1.default.rmdirSync(lockDir);
                            }
                            catch { }
                        }
                    }
                    catch { }
                    if (Date.now() - start > timeoutMs) {
                        throw new Error(`Cross-process entitlement lock timeout after ${timeoutMs}ms`);
                    }
                    const jitter = Math.floor(Math.random() * 20);
                    await new Promise(r => setTimeout(r, retryDelayMs + jitter));
                }
            }
            return await fn();
        }
        finally {
            if (dirLockAcquired) {
                try {
                    if (fs_1.default.existsSync(lockDir)) {
                        fs_1.default.rmdirSync(lockDir);
                    }
                }
                catch { }
            }
            releaseInProcess();
        }
    }
    async checkRescueOrSplitEntitlement(userId, actionType) {
        if (!userId) {
            return {
                status: 'REQUIRE_LOGIN',
                hasSplitAccess: false,
                rescueCreditRemaining: true,
                splitCreditRemaining: true,
                freeCreditRemaining: true,
                planType: 'guest',
                splitMinutesLeft: 0
            };
        }
        const user = await authService_1.authService.getUserById(userId);
        if (!user || user.isBlocked) {
            return {
                status: 'REQUIRE_LOGIN',
                hasSplitAccess: false,
                rescueCreditRemaining: false,
                splitCreditRemaining: false,
                freeCreditRemaining: false,
                planType: 'none',
                splitMinutesLeft: 0
            };
        }
        // 1. Paid users (Pro, Blitz, 24h Pass, Yearly, Admin) are NEVER blocked
        const hasSplitAccess = await authService_1.authService.canUseSplit(userId);
        let splitMinutesLeft = 0;
        if (hasSplitAccess && user.splitAccessUntil) {
            splitMinutesLeft = Math.max(0, Math.floor((new Date(user.splitAccessUntil).getTime() - Date.now()) / 60000));
        }
        else if (hasSplitAccess) {
            splitMinutesLeft = 99999;
        }
        if (hasSplitAccess) {
            return {
                status: 'ALLOW_PAID',
                hasSplitAccess: true,
                rescueCreditRemaining: true,
                splitCreditRemaining: true,
                freeCreditRemaining: true,
                planType: user.planType || 'pro',
                splitMinutesLeft
            };
        }
        // 2. Separate Daily Free Quotas: 1 Rescue + 1 Split per calendar day
        const today = getTodayDateString();
        const ledger = getLedgerSafe();
        const userQuota = ledger[userId] || {};
        const rescueUsedToday = Boolean(userQuota.rescueUsedOn && userQuota.rescueUsedOn === today);
        const splitUsedToday = Boolean(userQuota.splitUsedOn && userQuota.splitUsedOn === today);
        // Also check active reservations
        const now = Date.now();
        const rescueReserved = Boolean(userQuota.reservations?.rescue && now < userQuota.reservations.rescue.expiresAt && !userQuota.reservations.rescue.committed);
        const splitReserved = Boolean(userQuota.reservations?.split && now < userQuota.reservations.split.expiresAt && !userQuota.reservations.split.committed);
        const rescueCreditRemaining = !rescueUsedToday && !rescueReserved;
        const splitCreditRemaining = !splitUsedToday && !splitReserved;
        let status;
        if (actionType === 'rescue') {
            status = rescueCreditRemaining ? 'ALLOW_FREE_RESCUE' : 'SHOW_PAYWALL_RESCUE';
        }
        else if (actionType === 'split') {
            status = splitCreditRemaining ? 'ALLOW_FREE_SPLIT' : 'SHOW_PAYWALL_SPLIT';
        }
        else {
            if (rescueCreditRemaining) {
                status = 'ALLOW_FREE_RESCUE';
            }
            else if (splitCreditRemaining) {
                status = 'ALLOW_FREE_SPLIT';
            }
            else {
                status = 'SHOW_PAYWALL_RESCUE';
            }
        }
        return {
            status,
            hasSplitAccess: false,
            rescueCreditRemaining,
            splitCreditRemaining,
            freeCreditRemaining: rescueCreditRemaining || splitCreditRemaining,
            planType: user.planType || 'free',
            splitMinutesLeft: 0
        };
    }
    async reserveFreeCredit(userId, actionType, leaseMs = 120000) {
        if (!userId) {
            return {
                allowed: false,
                status: 'REQUIRE_LOGIN',
                planType: 'guest',
                message: 'Authentication required'
            };
        }
        // Check account status
        const user = await authService_1.authService.getUserById(userId);
        if (!user || user.isBlocked) {
            return {
                allowed: false,
                status: 'REQUIRE_LOGIN',
                planType: 'none',
                message: 'Account not found or blocked'
            };
        }
        // Paid users do not consume free quota
        const hasPaidSplit = await authService_1.authService.canUseSplit(userId);
        if (hasPaidSplit) {
            return {
                allowed: true,
                status: 'ALLOW_PAID',
                planType: user.planType || 'pro',
                message: 'Paid plan entitlement active',
                isPaid: true
            };
        }
        return this.acquireCrossProcessLock(async () => {
            const ledgerPath = getLedgerPath();
            const ledger = getLedgerSafe(ledgerPath);
            const today = getTodayDateString();
            const userQuota = ledger[userId] || {};
            const now = Date.now();
            // Clean expired reservations for this user
            if (userQuota.reservations) {
                for (const act of ['split', 'rescue']) {
                    const r = userQuota.reservations[act];
                    if (r && now >= r.expiresAt && !r.committed) {
                        delete userQuota.reservations[act];
                    }
                }
            }
            // Check if already committed for today (IST)
            const alreadyCommitted = actionType === 'split'
                ? (userQuota.splitUsedOn === today)
                : (userQuota.rescueUsedOn === today);
            if (alreadyCommitted) {
                return {
                    allowed: false,
                    status: actionType === 'rescue' ? 'SHOW_PAYWALL_RESCUE' : 'SHOW_PAYWALL_SPLIT',
                    planType: user.planType || 'free',
                    message: `Daily free ${actionType === 'rescue' ? 'Same-Train Rescue' : 'Split Journey'} limit reached. Upgrade to Pro for unlimited access.`
                };
            }
            // Check for active non-expired reservation
            const existingRes = userQuota.reservations?.[actionType];
            if (existingRes && now < existingRes.expiresAt && !existingRes.committed && !existingRes.released) {
                return {
                    allowed: false,
                    status: actionType === 'rescue' ? 'SHOW_PAYWALL_RESCUE' : 'SHOW_PAYWALL_SPLIT',
                    planType: user.planType || 'free',
                    inProgress: true,
                    message: `A ${actionType === 'rescue' ? 'Same-Train Rescue' : 'Split Journey'} search is currently in progress. Please wait for it to complete.`
                };
            }
            // Create new reservation
            const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            if (!ledger[userId])
                ledger[userId] = {};
            if (!ledger[userId].reservations)
                ledger[userId].reservations = {};
            ledger[userId].reservations[actionType] = {
                reservationId,
                actionType,
                reservedAt: now,
                expiresAt: now + leaseMs
            };
            saveLedgerAtomic(ledger, ledgerPath);
            const safeId = userId.slice(0, 8);
            console.info(`[ENTITLEMENT] Reserved free ${actionType} credit for user ${safeId}... (id: ${reservationId}, lease: ${leaseMs}ms)`);
            return {
                allowed: true,
                status: actionType === 'rescue' ? 'ALLOW_FREE_RESCUE' : 'ALLOW_FREE_SPLIT',
                planType: user.planType || 'free',
                reservationId,
                message: `Free ${actionType} credit reserved successfully`
            };
        });
    }
    async commitFreeCredit(userId, actionType, reservationId) {
        if (!userId || !reservationId) {
            return { success: false, message: 'Invalid parameters for entitlement commit' };
        }
        return this.acquireCrossProcessLock(async () => {
            const ledgerPath = getLedgerPath();
            const ledger = getLedgerSafe(ledgerPath);
            const today = getTodayDateString();
            const userQuota = ledger[userId];
            // Idempotency: check if already committed today
            const alreadyCommitted = actionType === 'split'
                ? (userQuota?.splitUsedOn === today)
                : (userQuota?.rescueUsedOn === today);
            if (alreadyCommitted) {
                return { success: true, message: 'Already committed for today (idempotent)' };
            }
            const res = userQuota?.reservations?.[actionType];
            if (!res) {
                return { success: false, message: 'No active reservation found to commit' };
            }
            if (res.reservationId !== reservationId) {
                return { success: false, message: 'Reservation ID mismatch' };
            }
            if (res.released) {
                return { success: false, message: 'Reservation was already released' };
            }
            if (Date.now() > res.expiresAt) {
                const safeId = userId.slice(0, 8);
                console.warn(`[ENTITLEMENT] Commit attempted after lease expiration for user ${safeId}... (reservation: ${reservationId})`);
                delete userQuota.reservations[actionType];
                saveLedgerAtomic(ledger, ledgerPath);
                return { success: false, message: 'Reservation lease expired before engine finished' };
            }
            if (actionType === 'split') {
                userQuota.splitUsedOn = today;
            }
            else {
                userQuota.rescueUsedOn = today;
            }
            delete userQuota.reservations[actionType];
            saveLedgerAtomic(ledger, ledgerPath);
            const safeId = userId.slice(0, 8);
            console.info(`[ENTITLEMENT] Committed free ${actionType} credit for user ${safeId}... on ${today}`);
            return { success: true, message: `Free ${actionType} credit committed successfully` };
        });
    }
    async releaseFreeCredit(userId, actionType, reservationId) {
        if (!userId || !reservationId) {
            return { success: false, message: 'Invalid parameters for entitlement release' };
        }
        return this.acquireCrossProcessLock(async () => {
            const ledgerPath = getLedgerPath();
            const ledger = getLedgerSafe(ledgerPath);
            const today = getTodayDateString();
            const userQuota = ledger[userId];
            // If already committed for today, cannot release
            const alreadyCommitted = actionType === 'split'
                ? (userQuota?.splitUsedOn === today)
                : (userQuota?.rescueUsedOn === today);
            if (alreadyCommitted) {
                return { success: false, message: 'Cannot release already committed credit' };
            }
            const res = userQuota?.reservations?.[actionType];
            if (!res) {
                return { success: true, message: 'Reservation already released or not found (idempotent)' };
            }
            if (res.reservationId !== reservationId) {
                return { success: false, message: 'Reservation ID mismatch' };
            }
            if (res.committed) {
                return { success: false, message: 'Cannot release already committed credit' };
            }
            delete userQuota.reservations[actionType];
            saveLedgerAtomic(ledger, ledgerPath);
            const safeId = userId.slice(0, 8);
            console.info(`[ENTITLEMENT] Released free ${actionType} reservation ${reservationId} for user ${safeId}...`);
            return { success: true, message: `Free ${actionType} reservation released successfully` };
        });
    }
    async checkAndConsumeFreeCredit(userId, actionType) {
        const res = await this.reserveFreeCredit(userId, actionType);
        if (!res.allowed) {
            return res;
        }
        if (res.status === 'ALLOW_PAID' || res.isPaid) {
            return res;
        }
        if (res.reservationId) {
            await this.commitFreeCredit(userId, actionType, res.reservationId);
        }
        return res;
    }
    async consumeFreeCredit(userId, actionType = 'rescue') {
        const user = await authService_1.authService.getUserById(userId);
        if (!user) {
            return { success: false, message: 'User not found', actionType };
        }
        return this.acquireCrossProcessLock(async () => {
            const ledgerPath = getLedgerPath();
            const ledger = getLedgerSafe(ledgerPath);
            const today = getTodayDateString();
            if (!ledger[userId]) {
                ledger[userId] = {};
            }
            if (actionType === 'split') {
                ledger[userId].splitUsedOn = today;
            }
            else {
                ledger[userId].rescueUsedOn = today;
            }
            if (ledger[userId].reservations?.[actionType]) {
                delete ledger[userId].reservations[actionType];
            }
            saveLedgerAtomic(ledger, ledgerPath);
            return {
                success: true,
                message: `Free ${actionType} credit consumed successfully`,
                actionType
            };
        });
    }
    async consumeFreeRescueCredit(userId) {
        return this.consumeFreeCredit(userId, 'rescue');
    }
}
exports.EntitlementService = EntitlementService;
exports.entitlementService = new EntitlementService();
