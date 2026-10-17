"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearNotificationHistory = exports.deleteDeviceToken = exports.markAllNotificationsRead = exports.markNotificationsRead = exports.getNotifications = exports.updateNotificationPreferences = exports.registerDeviceToken = exports.MEMORY_NOTIFICATION_HISTORY = exports.MEMORY_PREFERENCES = exports.MEMORY_PUSH_TOKENS = void 0;
exports.encryptToken = encryptToken;
exports.decryptToken = decryptToken;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../middleware/logger");
const supabase_1 = require("../config/supabase");
// In-memory fallback buffers for database outage handling
exports.MEMORY_PUSH_TOKENS = new Map();
exports.MEMORY_PREFERENCES = new Map();
exports.MEMORY_NOTIFICATION_HISTORY = [];
// AES-256-GCM Application-Level Encryption Helpers
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
function getSecretKey() {
    const keyEnv = process.env.NOTIF_TOKEN_ENCRYPTION_KEY;
    if (keyEnv && keyEnv.length === 64) {
        try {
            return Buffer.from(keyEnv, 'hex');
        }
        catch (e) {
            // Ignore parse errors and fallback
        }
    }
    // Safe fallback derivation using SHA256 of the JWT secret to ensure key is always validly 32-bytes
    const secret = process.env.JWT_SECRET || 'default_trayago_encryption_secret_key';
    return crypto_1.default.createHash('sha256').update(secret).digest();
}
function encryptToken(token) {
    const key = getSecretKey();
    const iv = crypto_1.default.randomBytes(IV_BYTES);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    // Output formatted as: iv:ciphertext:tag
    return `${iv.toString('hex')}:${encrypted}:${tag}`;
}
function decryptToken(encryptedToken) {
    const parts = encryptedToken.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted token format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const tag = Buffer.from(parts[2], 'hex');
    const key = getSecretKey();
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
/**
 * Endpoint to safely register a device's push token.
 * Max 3 active tokens are allowed per user profile.
 */
const registerDeviceToken = async (req, res) => {
    // Feature Flag Check
    if (process.env.notifications_registration_enabled !== 'true') {
        logger_1.winstonLogger.warn('[NOTIFICATION_GATING] Registration attempt blocked: flag disabled.');
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Notification registrations are currently disabled.'
        });
    }
    const { device_id, fcm_token, device_type } = req.body;
    // Body Validation
    if (!device_id || !fcm_token || !device_type) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters: device_id, fcm_token, and device_type are required.'
        });
    }
    if (!['android', 'ios', 'web'].includes(device_type)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid device_type. Supported types are android, ios, or web.'
        });
    }
    // Resolve User Context (JWT session user or guest)
    const userId = req.headers['x-user-id'] || null;
    const encryptedToken = encryptToken(fcm_token);
    try {
        // Enforce 3-Device Token Ceiling limit
        let shouldEvict = false;
        let oldestTokenId = null;
        if (userId) {
            const { data: activeTokens, error: countError } = await supabase_1.supabase
                .from('user_push_tokens')
                .select('id, updated_at')
                .eq('user_id', userId)
                .order('updated_at', { ascending: true });
            if (countError)
                throw countError;
            if (activeTokens && activeTokens.length >= 3) {
                shouldEvict = true;
                oldestTokenId = activeTokens[0].id;
            }
        }
        else {
            const { data: activeTokens, error: countError } = await supabase_1.supabase
                .from('user_push_tokens')
                .select('id, updated_at')
                .eq('device_id', device_id)
                .order('updated_at', { ascending: true });
            if (countError)
                throw countError;
            if (activeTokens && activeTokens.length >= 3) {
                shouldEvict = true;
                oldestTokenId = activeTokens[0].id;
            }
        }
        // Perform oldest token eviction
        if (shouldEvict && oldestTokenId) {
            const { error: deleteError } = await supabase_1.supabase
                .from('user_push_tokens')
                .delete()
                .eq('id', oldestTokenId);
            if (deleteError)
                throw deleteError;
            logger_1.winstonLogger.info({
                message: 'Token ceiling reached. Evicted oldest token row.',
                component: 'NOTIFICATION_CONTROLLER',
                event: 'push_token_pruned'
            });
        }
        // Check if device_id registration already exists for UPSERT compatibility
        const { data: existing, error: findError } = await supabase_1.supabase
            .from('user_push_tokens')
            .select('id')
            .eq('device_id', device_id)
            .limit(1);
        if (findError)
            throw findError;
        if (existing && existing.length > 0) {
            // Update token
            const { error: updateError } = await supabase_1.supabase
                .from('user_push_tokens')
                .update({
                user_id: userId,
                fcm_token: encryptedToken,
                device_type,
                updated_at: new Date().toISOString()
            })
                .eq('id', existing[0].id);
            if (updateError)
                throw updateError;
        }
        else {
            // New Registration
            const { error: insertError } = await supabase_1.supabase
                .from('user_push_tokens')
                .insert({
                user_id: userId,
                device_id,
                fcm_token: encryptedToken,
                device_type,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
            if (insertError)
                throw insertError;
        }
        logger_1.winstonLogger.info({
            message: `Registered push token for device ${device_id}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_registered'
        });
        return res.status(200).json({ success: true });
    }
    catch (dbError) {
        // Graceful DB Fallback - Cascade registration to in-memory maps
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB connection failed. Cascading to in-memory push token registry: ${dbError.message}`);
        const filterKey = userId ? 'user_id' : 'device_id';
        const filterVal = userId || device_id;
        const userTokensInMem = Array.from(exports.MEMORY_PUSH_TOKENS.values())
            .filter((t) => t[filterKey] === filterVal)
            .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime());
        if (userTokensInMem.length >= 3) {
            // Evict oldest in-memory token
            const oldest = userTokensInMem[0];
            for (const [k, v] of exports.MEMORY_PUSH_TOKENS.entries()) {
                if (v === oldest) {
                    exports.MEMORY_PUSH_TOKENS.delete(k);
                    break;
                }
            }
            logger_1.winstonLogger.info({
                message: 'Token ceiling reached. Evicted oldest token row.',
                component: 'NOTIFICATION_CONTROLLER',
                event: 'push_token_pruned'
            });
        }
        // Store token in map
        exports.MEMORY_PUSH_TOKENS.set(device_id, {
            user_id: userId,
            device_id,
            fcm_token: encryptedToken,
            device_type,
            updated_at: new Date()
        });
        logger_1.winstonLogger.info({
            message: `Registered push token for device ${device_id} (fallback)`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'push_registered'
        });
        return res.status(200).json({ success: true });
    }
};
exports.registerDeviceToken = registerDeviceToken;
/**
 * Endpoint to safely update a user's notification/privacy preferences.
 * Preferences are isolated strictly per authenticated user profile.
 */
const updateNotificationPreferences = async (req, res) => {
    // Feature Flag Check
    if (process.env.notifications_registration_enabled !== 'true') {
        logger_1.winstonLogger.warn('[NOTIFICATION_GATING] Preferences attempt blocked: flag disabled.');
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Notification preferences are currently disabled.'
        });
    }
    // Resolve User Context (Must be authenticated to update settings)
    const userId = req.headers['x-user-id'] || null;
    if (!userId) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized. Authenticated session required to save preferences.'
        });
    }
    try {
        const { data: existing, error: findError } = await supabase_1.supabase
            .from('user_notification_preferences')
            .select('user_id')
            .eq('user_id', userId)
            .limit(1);
        if (findError)
            throw findError;
        const payload = {
            delay_alerts_enabled: req.body.delay_alerts_enabled !== undefined ? !!req.body.delay_alerts_enabled : true,
            waitlist_alerts_enabled: req.body.waitlist_alerts_enabled !== undefined ? !!req.body.waitlist_alerts_enabled : true,
            platform_alerts_enabled: req.body.platform_alerts_enabled !== undefined ? !!req.body.platform_alerts_enabled : true,
            marketing_alerts_enabled: req.body.marketing_alerts_enabled !== undefined ? !!req.body.marketing_alerts_enabled : false,
            updated_at: new Date().toISOString()
        };
        if (existing && existing.length > 0) {
            // Update
            const { error: updateError } = await supabase_1.supabase
                .from('user_notification_preferences')
                .update(payload)
                .eq('user_id', userId);
            if (updateError)
                throw updateError;
        }
        else {
            // Insert
            const { error: insertError } = await supabase_1.supabase
                .from('user_notification_preferences')
                .insert({
                user_id: userId,
                ...payload
            });
            if (insertError)
                throw insertError;
        }
        logger_1.winstonLogger.info({
            message: `Updated notification preferences for user ${userId}`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'opt_out_enforced'
        });
        return res.status(200).json({ success: true });
    }
    catch (dbError) {
        // Graceful DB Fallback - Cascade preferences to in-memory maps
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB connection failed. Cascading to in-memory preferences: ${dbError.message}`);
        const payload = {
            user_id: userId,
            delay_alerts_enabled: req.body.delay_alerts_enabled !== undefined ? !!req.body.delay_alerts_enabled : true,
            waitlist_alerts_enabled: req.body.waitlist_alerts_enabled !== undefined ? !!req.body.waitlist_alerts_enabled : true,
            platform_alerts_enabled: req.body.platform_alerts_enabled !== undefined ? !!req.body.platform_alerts_enabled : true,
            marketing_alerts_enabled: req.body.marketing_alerts_enabled !== undefined ? !!req.body.marketing_alerts_enabled : false,
            updated_at: new Date()
        };
        exports.MEMORY_PREFERENCES.set(userId, payload);
        logger_1.winstonLogger.info({
            message: `Updated notification preferences for user ${userId} (fallback)`,
            component: 'NOTIFICATION_CONTROLLER',
            event: 'opt_out_enforced'
        });
        return res.status(200).json({ success: true });
    }
};
exports.updateNotificationPreferences = updateNotificationPreferences;
/**
 * Endpoint to fetch notification history
 */
const getNotifications = async (req, res) => {
    const userId = req.headers['x-user-id'] || null;
    const deviceId = req.headers['x-device-id'] || null;
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = (page - 1) * limit;
    try {
        let query = supabase_1.supabase
            .from('user_notification_history')
            .select('*', { count: 'exact' });
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error)
            throw error;
        const total = count || 0;
        const totalPages = Math.ceil(total / limit);
        return res.status(200).json({
            success: true,
            data: data || [],
            pagination: {
                page,
                limit,
                total,
                totalPages
            }
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB history fetch failed. Cascading to in-memory: ${dbError.message}`);
        // Memory fallback implementation
        const filtered = exports.MEMORY_NOTIFICATION_HISTORY.filter(n => {
            if (userId)
                return n.user_id === userId;
            return n.device_id === deviceId;
        }).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        const paginated = filtered.slice(offset, offset + limit);
        const total = filtered.length;
        const totalPages = Math.ceil(total / limit);
        return res.status(200).json({
            success: true,
            data: paginated.map(n => ({
                ...n,
                created_at: n.created_at.toISOString(),
                updated_at: n.updated_at.toISOString()
            })),
            pagination: {
                page,
                limit,
                total,
                totalPages
            }
        });
    }
};
exports.getNotifications = getNotifications;
/**
 * Endpoint to mark specific notifications as read
 */
const markNotificationsRead = async (req, res) => {
    const userId = req.headers['x-user-id'] || null;
    const deviceId = req.headers['x-device-id'] || null;
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    const { notificationIds } = req.body;
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Missing required array parameter: notificationIds.'
        });
    }
    try {
        let query = supabase_1.supabase
            .from('user_notification_history')
            .update({ is_read: true, updated_at: new Date().toISOString() })
            .in('id', notificationIds);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { data, error } = await query.select('id');
        if (error)
            throw error;
        return res.status(200).json({
            success: true,
            updatedCount: data ? data.length : notificationIds.length
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB read update failed. Cascading to in-memory: ${dbError.message}`);
        let updatedCount = 0;
        exports.MEMORY_NOTIFICATION_HISTORY.forEach(n => {
            const matchesId = notificationIds.includes(n.id);
            const matchesUser = userId ? n.user_id === userId : n.device_id === deviceId;
            if (matchesId && matchesUser) {
                n.is_read = true;
                n.updated_at = new Date();
                updatedCount++;
            }
        });
        return res.status(200).json({
            success: true,
            updatedCount
        });
    }
};
exports.markNotificationsRead = markNotificationsRead;
/**
 * Endpoint to mark all user/device notifications as read
 */
const markAllNotificationsRead = async (req, res) => {
    const userId = req.headers['x-user-id'] || null;
    const deviceId = req.headers['x-device-id'] || null;
    if (!userId && !deviceId) {
        return res.status(400).json({
            success: false,
            error: 'Authentication credentials (x-user-id or x-device-id) are required.'
        });
    }
    try {
        let query = supabase_1.supabase
            .from('user_notification_history')
            .update({ is_read: true, updated_at: new Date().toISOString() })
            .eq('is_read', false);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { data, error } = await query.select('id');
        if (error)
            throw error;
        return res.status(200).json({
            success: true,
            updatedCount: data ? data.length : 0
        });
    }
    catch (dbError) {
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB read-all failed. Cascading to in-memory: ${dbError.message}`);
        let updatedCount = 0;
        exports.MEMORY_NOTIFICATION_HISTORY.forEach(n => {
            const matchesUser = userId ? n.user_id === userId : n.device_id === deviceId;
            if (matchesUser && !n.is_read) {
                n.is_read = true;
                n.updated_at = new Date();
                updatedCount++;
            }
        });
        return res.status(200).json({
            success: true,
            updatedCount
        });
    }
};
exports.markAllNotificationsRead = markAllNotificationsRead;
/**
 * Endpoint to safely delete a device's push token.
 */
const deleteDeviceToken = async (req, res) => {
    const userId = req.headers['x-user-id'] || null;
    const { device_id } = req.body;
    if (!device_id) {
        return res.status(400).json({ success: false, error: 'device_id required' });
    }
    try {
        let query = supabase_1.supabase.from('user_push_tokens').delete().eq('device_id', device_id);
        if (userId) {
            query = query.eq('user_id', userId);
        }
        const { error } = await query;
        if (error)
            throw error;
        exports.MEMORY_PUSH_TOKENS.delete(device_id);
        return res.status(200).json({ success: true });
    }
    catch (err) {
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB token delete failed. Cascading to memory: ${err.message}`);
        exports.MEMORY_PUSH_TOKENS.delete(device_id);
        return res.status(200).json({ success: true });
    }
};
exports.deleteDeviceToken = deleteDeviceToken;
/**
 * Endpoint to clear notification history for a user/device
 */
const clearNotificationHistory = async (req, res) => {
    const userId = req.headers['x-user-id'] || null;
    const deviceId = req.headers['x-device-id'] || null;
    if (!userId && !deviceId) {
        return res.status(400).json({ success: false, error: 'Authentication required' });
    }
    try {
        let query = supabase_1.supabase.from('user_notification_history').delete();
        if (userId) {
            query = query.eq('user_id', userId);
        }
        else {
            query = query.eq('device_id', deviceId);
        }
        const { error } = await query;
        if (error)
            throw error;
        return res.status(200).json({ success: true });
    }
    catch (err) {
        logger_1.winstonLogger.info(`[NOTIFICATION_CONTROLLER] DB history clear failed. Cascading to memory: ${err.message}`);
        // Remove from memory array
        for (let i = exports.MEMORY_NOTIFICATION_HISTORY.length - 1; i >= 0; i--) {
            const n = exports.MEMORY_NOTIFICATION_HISTORY[i];
            const matchesUser = userId ? n.user_id === userId : n.device_id === deviceId;
            if (matchesUser) {
                exports.MEMORY_NOTIFICATION_HISTORY.splice(i, 1);
            }
        }
        return res.status(200).json({ success: true });
    }
};
exports.clearNotificationHistory = clearNotificationHistory;
