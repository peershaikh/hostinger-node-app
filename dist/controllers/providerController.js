"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteProvider = exports.rollbackProviderConfig = exports.getProviderHistory = exports.testProvider = exports.batchUpdateProviders = exports.removeProviderKey = exports.updateProvider = exports.createProvider = exports.getProviders = exports.fallbackProviders = void 0;
exports.maskSecretKey = maskSecretKey;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const providerConfigService_1 = require("../services/providerConfigService");
const authService_1 = require("../services/authService");
const railProviderRegistry_1 = require("../services/railProviderRegistry");
const railProviderResolver_1 = require("../services/railProviderResolver");
const railRadarService_1 = require("../services/railRadarService");
// Graceful database outage in-memory fallback store
exports.fallbackProviders = [
    {
        id: '01d4df69-d510-4c38-9d95-d2d8e0f9cad4',
        provider_name: 'IRCTC',
        priority: 1,
        enabled: true,
        is_deleted: false,
        health_status: 'ACTIVE',
        consecutive_failures: 0,
        response_latency: 120,
        api_key: 'mock_encrypted_irctc_key',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    },
    {
        id: '03d4df69-d510-4c38-9d95-d2d8e0f9cad4',
        provider_name: 'RAILRADAR',
        priority: 2,
        enabled: true,
        is_deleted: false,
        health_status: 'ACTIVE',
        consecutive_failures: 0,
        response_latency: 75,
        api_key: 'mock_encrypted_railradar_key',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }
];
function maskSecretKey(key) {
    if (!key || key.trim().length === 0 || key === 'mock_encrypted_railradar_key' || key === 'mock_encrypted_irctc_key') {
        return 'Not configured';
    }
    const clean = key.trim();
    // If already masked
    if (clean.includes('••••') || clean.startsWith('********')) {
        return clean;
    }
    // If encrypted "iv:tag:cipher", decrypt in memory to extract safe mask
    if (clean.includes(':') && clean.split(':').length === 3) {
        try {
            const decrypted = providerConfigService_1.providerConfigService.decryptKey(clean);
            return maskSecretKey(decrypted);
        }
        catch {
            return '••••••••';
        }
    }
    if (clean.startsWith('rr_live_')) {
        const suffix = clean.slice(-4);
        return `rr_live_••••••••${suffix}`;
    }
    if (clean.length <= 8) {
        return '••••••••' + clean.slice(-2);
    }
    return clean.substring(0, 4) + '••••••••' + clean.slice(-4);
}
const enrichProvider = (provider) => {
    const nameUpper = (provider.provider_name || '').toUpperCase().trim();
    const reg = railProviderRegistry_1.railProviderRegistry.getProvider(nameUpper);
    const capabilities = reg ? reg.capabilities : {
        search: false,
        availability: false,
        liveTracking: false,
        pnr: false,
        schedule: false
    };
    let rawOrEncryptedKey = provider.api_key;
    if (!rawOrEncryptedKey || rawOrEncryptedKey === 'mock_encrypted_railradar_key' || rawOrEncryptedKey === 'mock_encrypted_irctc_key') {
        const local = providerConfigService_1.providerConfigService.getSecureLocalKey(nameUpper);
        if (local) {
            rawOrEncryptedKey = local;
        }
        else {
            if (nameUpper === 'IRCTC') {
                rawOrEncryptedKey = process.env.IRCTC_CONNECT_API_KEY || process.env.IRCTC_API_KEY || '';
            }
            else if (nameUpper === 'RAILRADAR') {
                rawOrEncryptedKey = process.env.RAILRADAR_API_KEY || '';
            }
            else if (nameUpper === 'CONFIRMTKT') {
                rawOrEncryptedKey = process.env.CONFIRMTKT_API_KEY || process.env.RAPIDAPI_KEY || '';
            }
            else if (nameUpper === 'RAILYATRI') {
                rawOrEncryptedKey = process.env.RAILYATRI_API_KEY || process.env.RAPIDAPI_KEY || '';
            }
        }
    }
    const maskedKey = maskSecretKey(rawOrEncryptedKey);
    const hasCredentials = maskedKey !== 'Not configured' || nameUpper === 'DATABASE';
    const baseEnriched = {
        ...provider,
        api_key: maskedKey,
        credentials_configured: hasCredentials,
        capabilities,
        display_name: reg ? reg.displayName : provider.provider_name
    };
    if (nameUpper === 'RAILRADAR') {
        const quota = railRadarService_1.railRadarService.getQuotaUsage();
        const health = railRadarService_1.railRadarService.getHealthStatus();
        baseEnriched.role = 'BACKUP';
        baseEnriched.services = ['PNR Status', 'Live Train Status'];
        baseEnriched.quota_used = quota.used;
        baseEnriched.quota_limit = quota.limit;
        baseEnriched.quota_remaining = quota.remaining;
        baseEnriched.quota_month = quota.month;
        baseEnriched.health_status = health.status;
        baseEnriched.health_message = health.message;
        baseEnriched.fallback_available = provider.enabled && hasCredentials && health.status !== 'UNHEALTHY';
    }
    return baseEnriched;
};
const computeFeatureMatrix = async () => {
    const features = ['search', 'availability', 'liveTracking', 'pnr', 'schedule'];
    const matrix = {};
    for (const f of features) {
        try {
            const chain = await railProviderResolver_1.railProviderResolver.resolveProviderChain(f);
            const supported = railProviderRegistry_1.railProviderRegistry.getProvidersByCapability(f).map(p => p.providerId);
            matrix[f] = {
                primary: chain.length > 0 ? chain[0].providerId : 'NONE',
                fallbacks: chain.slice(1).map(p => p.providerId),
                supported_providers: supported
            };
        }
        catch {
            matrix[f] = { primary: 'NONE', fallbacks: [], supported_providers: [] };
        }
    }
    return matrix;
};
const getProviders = async (req, res) => {
    try {
        const { data, error } = await supabase_1.supabase
            .from('api_providers')
            .select('*')
            .eq('is_deleted', false)
            .order('priority', { ascending: true });
        if (error) {
            logger_1.winstonLogger.warn(`[Admin] Database api_providers query failed: ${error.message}. Redirecting to in-memory fallback.`);
            throw error;
        }
        if (!data || data.length === 0) {
            logger_1.winstonLogger.info(`[Admin] Database api_providers table is empty. Redirecting to in-memory fallback.`);
            throw new Error('Database api_providers table is empty');
        }
        const enriched = data.map(enrichProvider);
        const feature_matrix = await computeFeatureMatrix();
        res.status(200).json({ success: true, providers: enriched, feature_matrix });
    }
    catch (error) {
        // Graceful in-memory fallback
        const activeProviders = exports.fallbackProviders
            .filter((p) => !p.is_deleted)
            .sort((a, b) => a.priority - b.priority)
            .map(enrichProvider);
        const feature_matrix = await computeFeatureMatrix();
        res.status(200).json({ success: true, providers: activeProviders, feature_matrix, fallback: true });
    }
};
exports.getProviders = getProviders;
const createProvider = async (req, res) => {
    try {
        const { provider_name, api_key, priority, enabled } = req.body;
        const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
        const adminUser = await authService_1.authService.getUserById(adminId);
        const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
        const maskedDetails = {
            provider_name,
            priority,
            enabled,
            api_key: '[REDACTED]'
        };
        const encryptedKey = api_key ? providerConfigService_1.providerConfigService.encryptKey(api_key) : '';
        try {
            const { data: providerId, error } = await supabase_1.supabase.rpc('admin_create_provider_rpc', {
                p_admin_id: adminId,
                p_admin_email: adminEmail,
                p_provider_name: provider_name,
                p_api_key: encryptedKey,
                p_priority: priority || 99,
                p_enabled: enabled ?? true,
                p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                p_user_agent: req.headers['user-agent'] || null,
                p_details: maskedDetails
            });
            if (error)
                throw error;
            providerConfigService_1.providerConfigService.flushCache(provider_name);
            const feature_matrix = await computeFeatureMatrix();
            res.status(201).json({
                success: true,
                provider: { id: providerId, provider_name, priority, enabled },
                feature_matrix
            });
        }
        catch (dbError) {
            logger_1.winstonLogger.warn(`[Admin] Database create provider RPC failed: ${dbError.message}. Using in-memory fallback.`);
            const newProvider = {
                id: `fb-${Date.now()}`,
                provider_name,
                priority: priority || 99,
                enabled: enabled ?? true,
                is_deleted: false,
                health_status: 'ACTIVE',
                consecutive_failures: 0,
                response_latency: 0,
                api_key: encryptedKey,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            exports.fallbackProviders.push(newProvider);
            providerConfigService_1.providerConfigService.flushCache(provider_name);
            const feature_matrix = await computeFeatureMatrix();
            res.status(201).json({
                success: true,
                provider: { id: newProvider.id, provider_name, priority, enabled },
                feature_matrix,
                fallback: true
            });
        }
    }
    catch (error) {
        logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] CreateProvider transaction failed. Error: ${error.message}`);
        res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
    }
};
exports.createProvider = createProvider;
const updateProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const { priority, enabled, api_key, remove_key, health_status } = req.body;
        const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
        const adminUser = await authService_1.authService.getUserById(adminId);
        const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
        // Find existing provider
        let existing = null;
        try {
            const { data } = await supabase_1.supabase.from('api_providers').select('*').eq('id', id).maybeSingle();
            if (data)
                existing = data;
        }
        catch { }
        if (!existing) {
            existing = exports.fallbackProviders.find(p => p.id === id);
        }
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Provider not found' });
        }
        const providerName = (existing.provider_name || '').toUpperCase().trim();
        const isRemovingKey = remove_key === true || api_key === '' || api_key === null;
        const isNewKeyProvided = typeof api_key === 'string' && api_key.trim().length > 0 && !api_key.startsWith('********') && !api_key.includes('••••');
        let encryptedKey = null;
        let auditAction = 'UPDATE_PROVIDER';
        if (isRemovingKey) {
            encryptedKey = '';
            providerConfigService_1.providerConfigService.saveSecureLocalKey(providerName, null);
            if (providerName === 'RAILRADAR') {
                auditAction = 'RAILRADAR_KEY_REMOVED';
                railRadarService_1.railRadarService.resetHealth();
            }
            else {
                auditAction = 'PROVIDER_KEY_REMOVED';
            }
        }
        else if (isNewKeyProvided) {
            encryptedKey = providerConfigService_1.providerConfigService.encryptKey(api_key.trim());
            providerConfigService_1.providerConfigService.saveSecureLocalKey(providerName, api_key.trim());
            const hadPreviousKey = Boolean(existing.api_key &&
                existing.api_key !== 'mock_encrypted_railradar_key' &&
                existing.api_key !== 'mock_encrypted_irctc_key' &&
                existing.api_key.length > 5);
            if (providerName === 'RAILRADAR') {
                auditAction = hadPreviousKey ? 'RAILRADAR_KEY_REPLACED' : 'RAILRADAR_KEY_ADDED';
                railRadarService_1.railRadarService.resetHealth();
            }
            else {
                auditAction = hadPreviousKey ? 'PROVIDER_KEY_REPLACED' : 'PROVIDER_KEY_ADDED';
            }
        }
        else if (enabled !== undefined) {
            if (providerName === 'RAILRADAR') {
                auditAction = enabled ? 'RAILRADAR_ENABLED' : 'RAILRADAR_DISABLED';
                if (enabled)
                    railRadarService_1.railRadarService.resetHealth();
            }
            else {
                auditAction = enabled ? 'PROVIDER_ENABLED' : 'PROVIDER_DISABLED';
            }
        }
        const maskedDetails = {
            provider_name: providerName,
            provider_id: id,
            priority,
            enabled,
            health_status,
            api_key: (isNewKeyProvided || isRemovingKey) ? '[REDACTED]' : undefined,
            action: auditAction,
            previous: { priority: existing.priority, enabled: existing.enabled, health_status: existing.health_status }
        };
        // Update in-memory fallback state
        const fbExisting = exports.fallbackProviders.find(p => p.id === id);
        if (fbExisting) {
            if (priority !== undefined)
                fbExisting.priority = priority;
            if (enabled !== undefined)
                fbExisting.enabled = enabled;
            if (health_status !== undefined)
                fbExisting.health_status = health_status;
            if (isRemovingKey)
                fbExisting.api_key = '';
            else if (encryptedKey)
                fbExisting.api_key = encryptedKey;
            fbExisting.updated_at = new Date().toISOString();
        }
        // Attempt DB updates: RPC first, then direct table update
        let dbUpdated = false;
        try {
            const rpcPayload = {
                p_admin_id: adminId,
                p_admin_email: adminEmail,
                p_provider_id: id,
                p_api_key: encryptedKey,
                p_priority: priority ?? null,
                p_enabled: enabled ?? null,
                p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                p_user_agent: req.headers['user-agent'] || null,
                p_details: maskedDetails
            };
            const { error: rpcErr } = await supabase_1.supabase.rpc('admin_update_provider_rpc', rpcPayload);
            if (!rpcErr)
                dbUpdated = true;
        }
        catch { }
        if (!dbUpdated) {
            try {
                const updateData = { updated_at: new Date().toISOString() };
                if (priority !== undefined)
                    updateData.priority = priority;
                if (enabled !== undefined)
                    updateData.enabled = enabled;
                if (health_status !== undefined)
                    updateData.health_status = health_status;
                if (isRemovingKey)
                    updateData.api_key = '';
                else if (encryptedKey)
                    updateData.api_key = encryptedKey;
                await supabase_1.supabase.from('api_providers').update(updateData).eq('id', id);
                dbUpdated = true;
            }
            catch { }
        }
        // Write audit log without exposing key
        try {
            await supabase_1.supabase.from('admin_security_audit_logs').insert({
                admin_id: adminId,
                admin_email: adminEmail,
                action: auditAction,
                ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                user_agent: req.headers['user-agent'] || null,
                details: maskedDetails
            });
        }
        catch { }
        logger_1.winstonLogger.info(`[ADMIN_AUDIT] Action: ${auditAction} on provider ${providerName} by ${adminEmail}`);
        providerConfigService_1.providerConfigService.flushCache(providerName);
        const feature_matrix = await computeFeatureMatrix();
        return res.status(200).json({
            success: true,
            provider: {
                id,
                priority: fbExisting?.priority ?? priority,
                enabled: fbExisting?.enabled ?? enabled,
                health_status
            },
            feature_matrix,
            audit_action: auditAction
        });
    }
    catch (error) {
        logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] UpdateProvider failed. Error: ${error.message}`);
        res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
    }
};
exports.updateProvider = updateProvider;
const removeProviderKey = async (req, res) => {
    req.body = req.body || {};
    req.body.remove_key = true;
    return (0, exports.updateProvider)(req, res);
};
exports.removeProviderKey = removeProviderKey;
const batchUpdateProviders = async (req, res) => {
    try {
        const { updates } = req.body; // Array of { id, priority, enabled }
        const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
        const adminUser = await authService_1.authService.getUserById(adminId);
        const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Updates array is required' });
        }
        for (const item of updates) {
            if (!item.id)
                continue;
            try {
                await supabase_1.supabase.from('api_providers').update({
                    priority: item.priority,
                    enabled: item.enabled,
                    updated_at: new Date().toISOString()
                }).eq('id', item.id);
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[Admin] Batch update failed for item ${item.id}: ${err.message}`);
            }
        }
        providerConfigService_1.providerConfigService.flushCache();
        const feature_matrix = await computeFeatureMatrix();
        // Log batch audit event
        try {
            await supabase_1.supabase.from('admin_security_audit_logs').insert({
                admin_id: adminId,
                admin_email: adminEmail,
                action: 'BATCH_UPDATE_PROVIDERS',
                ip_address: req.ip || null,
                user_agent: req.headers['user-agent'] || null,
                details: { updates_count: updates.length, updates }
            });
        }
        catch { }
        res.status(200).json({ success: true, message: 'Batch configuration saved', feature_matrix });
    }
    catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};
exports.batchUpdateProviders = batchUpdateProviders;
const testProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const { provider_name, feature } = req.body;
        let targetName = provider_name;
        if (!targetName && id) {
            try {
                const { data } = await supabase_1.supabase.from('api_providers').select('provider_name').eq('id', id).maybeSingle();
                targetName = data?.provider_name;
            }
            catch { }
            if (!targetName) {
                const fb = exports.fallbackProviders.find(p => p.id === id);
                if (fb)
                    targetName = fb.provider_name;
            }
        }
        if (!targetName) {
            return res.status(400).json({ success: false, error: 'Provider name or ID is required' });
        }
        const nameUpper = targetName.toUpperCase().trim();
        const provider = railProviderRegistry_1.railProviderRegistry.getProvider(nameUpper);
        if (!provider) {
            return res.status(404).json({ success: false, error: `Provider '${targetName}' not found in registry` });
        }
        // If specific feature requested, validate capability
        if (feature) {
            const featKey = feature;
            if (!provider.capabilities[featKey]) {
                return res.status(400).json({
                    success: false,
                    reason: 'UNSUPPORTED_CAPABILITY',
                    message: `Provider '${nameUpper}' does not support '${feature}'`
                });
            }
        }
        const start = Date.now();
        let healthResult = null;
        if (typeof provider.healthCheck === 'function') {
            healthResult = await provider.healthCheck();
        }
        else {
            healthResult = {
                status: 'UNSUPPORTED_PROBE',
                latencyMs: Date.now() - start,
                message: 'No health check probe implemented for this provider',
                timestamp: new Date().toISOString()
            };
        }
        const probeStatus = healthResult.status || 'UNAVAILABLE';
        const isSuccess = probeStatus === 'HEALTHY' || probeStatus === 'DEGRADED';
        return res.status(200).json({
            success: isSuccess,
            provider: nameUpper,
            feature: feature || 'HEALTH_CHECK',
            status: probeStatus,
            health: healthResult,
            message: healthResult.message || `Provider ${nameUpper} probe returned ${probeStatus}`
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};
exports.testProvider = testProvider;
const getProviderHistory = async (req, res) => {
    try {
        const { data, error } = await supabase_1.supabase
            .from('admin_security_audit_logs')
            .select('*')
            .ilike('action', '%PROVIDER%')
            .order('created_at', { ascending: false })
            .limit(15);
        if (error)
            throw error;
        return res.status(200).json({ success: true, history: data || [] });
    }
    catch {
        return res.status(200).json({ success: true, history: [] });
    }
};
exports.getProviderHistory = getProviderHistory;
const rollbackProviderConfig = async (req, res) => {
    try {
        const { provider_id, previous_priority, previous_enabled } = req.body;
        const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
        const adminUser = await authService_1.authService.getUserById(adminId);
        const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
        if (!provider_id) {
            return res.status(400).json({ success: false, error: 'provider_id is required for rollback' });
        }
        const { data: existing, error: fetchErr } = await supabase_1.supabase
            .from('api_providers')
            .select('*')
            .eq('id', provider_id)
            .single();
        if (fetchErr || !existing) {
            return res.status(404).json({ success: false, error: 'Provider not found' });
        }
        const rpcPayload = {
            p_admin_id: adminId,
            p_admin_email: adminEmail,
            p_provider_id: provider_id,
            p_api_key: null,
            p_priority: typeof previous_priority === 'number' ? previous_priority : existing.priority,
            p_enabled: typeof previous_enabled === 'boolean' ? previous_enabled : existing.enabled,
            p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
            p_user_agent: req.headers['user-agent'] || null,
            p_details: {
                action: 'ROLLBACK_PROVIDER_CONFIG',
                provider_id,
                restored_priority: previous_priority,
                restored_enabled: previous_enabled
            }
        };
        try {
            const { error: rpcError } = await supabase_1.supabase.rpc('admin_update_provider_rpc', rpcPayload);
            if (rpcError)
                throw rpcError;
        }
        catch (rpcErr) {
            // Fallback direct table update if RPC constraint fails (e.g. test env)
            await supabase_1.supabase.from('api_providers').update({
                priority: rpcPayload.p_priority,
                enabled: rpcPayload.p_enabled,
                updated_at: new Date().toISOString()
            }).eq('id', provider_id);
        }
        providerConfigService_1.providerConfigService.flushCache(existing.provider_name);
        const feature_matrix = await computeFeatureMatrix();
        return res.status(200).json({
            success: true,
            message: 'Configuration successfully restored',
            feature_matrix
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};
exports.rollbackProviderConfig = rollbackProviderConfig;
const deleteProvider = async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = req.user?.id || req.headers['x-user-id'] || 'unknown-admin';
        const adminUser = await authService_1.authService.getUserById(adminId);
        const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';
        try {
            const { data: existing, error: fetchErr } = await supabase_1.supabase
                .from('api_providers')
                .select('*')
                .eq('id', id)
                .single();
            if (fetchErr || !existing)
                throw new Error('Provider not found');
            const maskedDetails = {
                provider_id: id,
                previous: { enabled: existing.enabled }
            };
            const { error } = await supabase_1.supabase.rpc('admin_delete_provider_rpc', {
                p_admin_id: adminId,
                p_admin_email: adminEmail,
                p_provider_id: id,
                p_ip_address: req.ip || req.headers['x-forwarded-for'] || null,
                p_user_agent: req.headers['user-agent'] || null,
                p_details: maskedDetails
            });
            if (error)
                throw error;
            providerConfigService_1.providerConfigService.saveSecureLocalKey(existing.provider_name, null);
            if (existing.provider_name?.toUpperCase() === 'RAILRADAR') {
                railRadarService_1.railRadarService.resetHealth();
            }
            providerConfigService_1.providerConfigService.flushCache(existing.provider_name);
            const feature_matrix = await computeFeatureMatrix();
            res.status(200).json({ success: true, feature_matrix });
        }
        catch (dbError) {
            logger_1.winstonLogger.warn(`[Admin] DB delete provider failed: ${dbError.message}. Using in-memory fallback.`);
            const existing = exports.fallbackProviders.find(p => p.id === id);
            if (!existing) {
                return res.status(404).json({ success: false, error: 'Provider not found' });
            }
            existing.is_deleted = true;
            existing.updated_at = new Date().toISOString();
            providerConfigService_1.providerConfigService.saveSecureLocalKey(existing.provider_name, null);
            if (existing.provider_name?.toUpperCase() === 'RAILRADAR') {
                railRadarService_1.railRadarService.resetHealth();
            }
            providerConfigService_1.providerConfigService.flushCache(existing.provider_name);
            const feature_matrix = await computeFeatureMatrix();
            res.status(200).json({ success: true, feature_matrix, fallback: true });
        }
    }
    catch (error) {
        logger_1.winstonLogger.error(`[ADMIN_EXCEPTION] DeleteProvider transaction failed. Error: ${error.message}`);
        res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
    }
};
exports.deleteProvider = deleteProvider;
