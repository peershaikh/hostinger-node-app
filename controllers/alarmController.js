"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAlarm = exports.updateAlarm = exports.getAlarms = exports.createAlarm = exports.MEMORY_ALARMS = void 0;
const crypto_1 = __importDefault(require("crypto"));
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
// ─── UUID Validation ────────────────────────────────────────────────────────
// Prevents Supabase UUID cast errors (22P02) from triggering the memory
// fallback for the wrong reason. A malformed x-user-id is treated as null;
// the device_id header is used instead for guest-mode alarms.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(val) {
    return !!val && UUID_REGEX.test(val);
}
// In-memory fallback database for alarms when Supabase table is not yet created/accessible
exports.MEMORY_ALARMS = new Map();
/**
 * Helper to resolve user context (user_id and device_id).
 * x-user-id MUST be a valid UUID — non-UUID values are rejected and treated
 * as null so they never reach the Supabase query layer and cause cast errors.
 */
function resolveUserContext(req) {
    const rawUserId = req.headers['x-user-id'];
    const userId = isValidUUID(rawUserId) ? rawUserId : null;
    if (rawUserId && !userId) {
        logger_1.winstonLogger.debug(`[ALARM_CONTROLLER] Rejected non-UUID x-user-id header: "${rawUserId}" — using device_id only`);
    }
    const deviceId = req.headers['x-device-id'] || null;
    return { userId, deviceId };
}
/**
 * Helper to check ceiling of active alarms (limit = 3)
 */
async function checkAlarmCeiling(userId, deviceId) {
    // Check Supabase first
    try {
        let query = supabase_1.supabase
            .from('user_station_alarms')
            .select('id', { count: 'exact', head: true })
            .eq('enabled', true);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else if (deviceId) {
            query = query.eq('device_id', deviceId);
        }
        else {
            return false; // Neither user nor device provided
        }
        const { count, error } = await query;
        if (!error && count !== null) {
            return count >= 3;
        }
    }
    catch (e) {
        logger_1.winstonLogger.debug(`[ALARM_CEILING] Supabase query failed, falling back to memory: ${e.message}`);
    }
    // Fallback to in-memory ceiling check
    const activeMemoryAlarms = Array.from(exports.MEMORY_ALARMS.values()).filter(alarm => {
        if (!alarm.enabled)
            return false;
        if (userId && alarm.user_id === userId)
            return true;
        if (deviceId && alarm.device_id === deviceId)
            return true;
        return false;
    });
    return activeMemoryAlarms.length >= 3;
}
/**
 * POST /api/alarms
 * Create a new destination wake-up alarm
 */
const createAlarm = async (req, res) => {
    const { train_no, destination_station, radius_km = 20.0 } = req.body;
    const { userId, deviceId } = resolveUserContext(req);
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    if (!train_no || !/^\d{5}$/.test(train_no)) {
        return res.status(400).json({
            success: false,
            error: 'Valid 5-digit train_no is required.'
        });
    }
    if (!destination_station || typeof destination_station !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'destination_station (station code) is required.'
        });
    }
    const numericRadius = Number(radius_km);
    if (isNaN(numericRadius) || numericRadius <= 0) {
        return res.status(400).json({
            success: false,
            error: 'radius_km must be a positive number.'
        });
    }
    // Check 3 active alarms ceiling limit
    const limitReached = await checkAlarmCeiling(userId, deviceId);
    if (limitReached) {
        return res.status(400).json({
            success: false,
            error: 'Ceiling limit reached. You can only have a maximum of 3 active alarms.'
        });
    }
    const cleanStation = destination_station.trim().toUpperCase();
    const id = crypto_1.default.randomUUID();
    const now = new Date().toISOString();
    const alarmRecord = {
        id,
        user_id: userId,
        device_id: deviceId,
        train_no,
        destination_station: cleanStation,
        radius_km: numericRadius,
        enabled: true,
        created_at: now,
        updated_at: now
    };
    try {
        const { data, error } = await supabase_1.supabase
            .from('user_station_alarms')
            .insert({
            id,
            user_id: userId,
            device_id: deviceId,
            train_no,
            destination_station: cleanStation,
            radius_km: numericRadius,
            enabled: true
        })
            .select()
            .single();
        if (error)
            throw error;
        logger_1.winstonLogger.info(`[ALARM_CONTROLLER] Created alarm in Supabase: ${id} for train ${train_no} to ${cleanStation}`);
        return res.status(201).json({
            success: true,
            data: data
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.info(`[ALARM_CONTROLLER] DB save failed (table may be missing). Cascading to memory: ${dbError.message}`);
        // Store in memory
        exports.MEMORY_ALARMS.set(id, alarmRecord);
        return res.status(201).json({
            success: true,
            data: alarmRecord
        });
    }
};
exports.createAlarm = createAlarm;
/**
 * GET /api/alarms
 * Retrieve all alarms for current user/device
 */
const getAlarms = async (req, res) => {
    const { userId, deviceId } = resolveUserContext(req);
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    try {
        let query = supabase_1.supabase.from('user_station_alarms').select('*');
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { data, error } = await query.order('created_at', { ascending: false });
        if (error)
            throw error;
        return res.status(200).json({
            success: true,
            data: data || []
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.debug(`[ALARM_CONTROLLER] DB fetch failed. Fetching from memory: ${dbError.message}`);
        const filtered = Array.from(exports.MEMORY_ALARMS.values()).filter(alarm => {
            if (userId)
                return alarm.user_id === userId;
            return alarm.device_id === deviceId;
        }).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return res.status(200).json({
            success: true,
            data: filtered
        });
    }
};
exports.getAlarms = getAlarms;
/**
 * PATCH /api/alarms/:id
 * Update alarm configuration or toggle enabled state
 */
const updateAlarm = async (req, res) => {
    const { id } = req.params;
    const { enabled, radius_km } = req.body;
    const { userId, deviceId } = resolveUserContext(req);
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    const updates = {};
    if (enabled !== undefined)
        updates.enabled = !!enabled;
    if (radius_km !== undefined) {
        const numRadius = Number(radius_km);
        if (isNaN(numRadius) || numRadius <= 0) {
            return res.status(400).json({
                success: false,
                error: 'radius_km must be a positive number.'
            });
        }
        updates.radius_km = numRadius;
    }
    updates.updated_at = new Date().toISOString();
    // If enabling, verify we do not exceed the ceiling limit (excluding this alarm)
    if (enabled === true) {
        const activeAlarms = await checkAlarmCeiling(userId, deviceId);
        // Since we are enabling an existing one, if ceiling is already 3, it's blocked
        if (activeAlarms) {
            // Check if this alarm is already active (enabled)
            let isAlreadyEnabled = false;
            try {
                const { data } = await supabase_1.supabase.from('user_station_alarms').select('enabled').eq('id', id).maybeSingle();
                if (data?.enabled)
                    isAlreadyEnabled = true;
            }
            catch {
                const mem = exports.MEMORY_ALARMS.get(id);
                if (mem?.enabled)
                    isAlreadyEnabled = true;
            }
            if (!isAlreadyEnabled) {
                return res.status(400).json({
                    success: false,
                    error: 'Ceiling limit reached. You can only have a maximum of 3 active alarms.'
                });
            }
        }
    }
    try {
        let query = supabase_1.supabase
            .from('user_station_alarms')
            .update(updates)
            .eq('id', id);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { data, error } = await query.select().single();
        if (error)
            throw error;
        logger_1.winstonLogger.info(`[ALARM_CONTROLLER] Updated alarm in Supabase: ${id}`);
        return res.status(200).json({
            success: true,
            data: data
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.debug(`[ALARM_CONTROLLER] DB update failed. Updating in memory: ${dbError.message}`);
        const existing = exports.MEMORY_ALARMS.get(id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Alarm not found.'
            });
        }
        // Verify ownership
        if (userId && existing.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access Denied.' });
        }
        if (deviceId && existing.device_id !== deviceId) {
            return res.status(403).json({ success: false, error: 'Access Denied.' });
        }
        const updatedRecord = {
            ...existing,
            ...updates,
            updated_at: new Date().toISOString()
        };
        exports.MEMORY_ALARMS.set(id, updatedRecord);
        return res.status(200).json({
            success: true,
            data: updatedRecord
        });
    }
};
exports.updateAlarm = updateAlarm;
/**
 * DELETE /api/alarms/:id
 * Delete alarm permanently
 */
const deleteAlarm = async (req, res) => {
    const { id } = req.params;
    const { userId, deviceId } = resolveUserContext(req);
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    try {
        let query = supabase_1.supabase
            .from('user_station_alarms')
            .delete()
            .eq('id', id);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { error, status } = await query;
        if (error)
            throw error;
        logger_1.winstonLogger.info(`[ALARM_CONTROLLER] Deleted alarm in Supabase: ${id}`);
        return res.status(200).json({
            success: true,
            message: 'Alarm deleted successfully.'
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.debug(`[ALARM_CONTROLLER] DB delete failed. Deleting from memory: ${dbError.message}`);
        const existing = exports.MEMORY_ALARMS.get(id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Alarm not found.'
            });
        }
        // Verify ownership
        if (userId && existing.user_id !== userId) {
            return res.status(403).json({ success: false, error: 'Access Denied.' });
        }
        if (deviceId && existing.device_id !== deviceId) {
            return res.status(403).json({ success: false, error: 'Access Denied.' });
        }
        exports.MEMORY_ALARMS.delete(id);
        return res.status(200).json({
            success: true,
            message: 'Alarm deleted successfully.'
        });
    }
};
exports.deleteAlarm = deleteAlarm;
