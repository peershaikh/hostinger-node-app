"use strict";
/**
 * PHASE_RAIL_PROVIDER_REGISTRY_044 — Capability-Aware Rail Provider Registry
 *
 * Defines the standard RailProvider contract, explicit capability matrix,
 * provider adapters wrapping existing services, and a centralized registry.
 *
 * Note: Runtime routing remains untouched in this phase (Phase 044 is abstraction only).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.railProviderRegistry = exports.RailProviderRegistry = exports.DatabaseScheduleAdapter = exports.RapidApiAdapter = exports.RailYatriAdapter = exports.ConfirmTktAdapter = exports.RailRadarAdapter = exports.IRCTCAdapter = exports.UnsupportedCapabilityError = void 0;
const logger_1 = require("../middleware/logger");
const irctcService_1 = require("./irctcService");
const railRadarService_1 = require("./railRadarService");
const confirmtktService_1 = require("./confirmtktService");
const railyatriService_1 = require("./railyatriService");
const dbService_1 = require("./dbService");
const providerConfigService_1 = require("./providerConfigService");
function mapGuardToHealthStatus(guard, latencyMs) {
    let status = 'UNAVAILABLE';
    if (guard.enabled) {
        status = 'HEALTHY';
    }
    else if (guard.reason === 'PROVIDER_NOT_CONFIGURED' || guard.reason === 'MISSING_CREDENTIALS') {
        status = 'NOT_CONFIGURED';
    }
    else if (guard.reason === 'CIRCUIT_BREAKER_BLOCKED' || guard.reason === 'RATE_LIMITED') {
        status = 'DEGRADED';
    }
    else {
        status = 'UNAVAILABLE';
    }
    return {
        status,
        latencyMs,
        message: guard.reason,
        timestamp: new Date().toISOString()
    };
}
class UnsupportedCapabilityError extends Error {
    constructor(providerId, capability) {
        super(`UNSUPPORTED_CAPABILITY: Provider '${providerId}' does not support '${capability}'`);
        this.name = 'UnsupportedCapabilityError';
        this.providerId = providerId;
        this.capability = capability;
    }
}
exports.UnsupportedCapabilityError = UnsupportedCapabilityError;
// ─── 1. IRCTC ADAPTER ──────────────────────────────────────────────────────────
class IRCTCAdapter {
    constructor() {
        this.providerId = 'IRCTC';
        this.displayName = 'IRCTC Official / Connect API';
        this.capabilities = {
            search: true,
            availability: true,
            liveTracking: true,
            pnr: true,
            schedule: true
        };
    }
    async searchTrains(params) {
        return irctcService_1.irctcService.search(params.from, params.to, params.date);
    }
    async checkAvailability(params) {
        return irctcService_1.irctcService.getAvailability(params.trainNo, params.date, params.from, params.to, params.classType || '3A', params.quota || 'GN');
    }
    async getLiveStatus(params) {
        const v2 = await irctcService_1.irctcService.getLiveStatusV2(params.trainNo, params.date);
        if (v2 && !v2.not_running)
            return v2;
        return irctcService_1.irctcService.getLiveStatus(params.trainNo, params.date);
    }
    async getPNRStatus(params) {
        return irctcService_1.irctcService.checkPNRStatus(params.pnr);
    }
    async getTrainSchedule(params) {
        return irctcService_1.irctcService.getTrainInfo(params.trainNo);
    }
    async healthCheck() {
        const start = Date.now();
        try {
            const guard = await providerConfigService_1.providerConfigService.isProviderEnabled('IRCTC');
            return mapGuardToHealthStatus(guard, Date.now() - start);
        }
        catch (e) {
            return {
                status: 'UNAVAILABLE',
                latencyMs: Date.now() - start,
                message: e.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}
exports.IRCTCAdapter = IRCTCAdapter;
// ─── 2. RAILRADAR ADAPTER ──────────────────────────────────────────────────────
class RailRadarAdapter {
    constructor() {
        this.providerId = 'RAILRADAR';
        this.displayName = 'RailRadar Real-Time Tracking';
        this.capabilities = {
            search: false,
            availability: false,
            liveTracking: false,
            pnr: true,
            schedule: false
        };
    }
    async searchTrains(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'search');
    }
    async checkAvailability(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'availability');
    }
    async getLiveStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'liveTracking');
    }
    async getPNRStatus(params) {
        return railRadarService_1.railRadarService.getPNRStatus(params.pnr);
    }
    async getTrainSchedule(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'schedule');
    }
    async healthCheck() {
        const start = Date.now();
        try {
            const guard = await providerConfigService_1.providerConfigService.isProviderEnabled('RAILRADAR');
            const serviceHealth = railRadarService_1.railRadarService.getHealthStatus();
            if (serviceHealth.status === 'UNHEALTHY') {
                return {
                    status: 'UNAVAILABLE',
                    latencyMs: Date.now() - start,
                    message: serviceHealth.message || 'AUTH_FAILURE_401',
                    timestamp: new Date().toISOString()
                };
            }
            return mapGuardToHealthStatus(guard, Date.now() - start);
        }
        catch (e) {
            return {
                status: 'UNAVAILABLE',
                latencyMs: Date.now() - start,
                message: e.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}
exports.RailRadarAdapter = RailRadarAdapter;
// ─── 3. CONFIRMTKT ADAPTER ─────────────────────────────────────────────────────
class ConfirmTktAdapter {
    constructor() {
        this.providerId = 'CONFIRMTKT';
        this.displayName = 'ConfirmTkt Live Running Status';
        this.capabilities = {
            search: false,
            availability: false,
            liveTracking: true,
            pnr: false,
            schedule: false
        };
    }
    async searchTrains(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'search');
    }
    async checkAvailability(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'availability');
    }
    async getLiveStatus(params) {
        return confirmtktService_1.confirmtktService.getTrainStatus(params.trainNo, params.date);
    }
    async getPNRStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'pnr');
    }
    async getTrainSchedule(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'schedule');
    }
    async healthCheck() {
        const start = Date.now();
        try {
            const guard = await providerConfigService_1.providerConfigService.isProviderEnabled('CONFIRMTKT');
            return mapGuardToHealthStatus(guard, Date.now() - start);
        }
        catch (e) {
            return {
                status: 'UNAVAILABLE',
                latencyMs: Date.now() - start,
                message: e.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}
exports.ConfirmTktAdapter = ConfirmTktAdapter;
// ─── 4. RAILYATRI ADAPTER ──────────────────────────────────────────────────────
class RailYatriAdapter {
    constructor() {
        this.providerId = 'RAILYATRI';
        this.displayName = 'RailYatri Live Running Status';
        this.capabilities = {
            search: false,
            availability: false,
            liveTracking: true,
            pnr: false,
            schedule: false
        };
    }
    async searchTrains(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'search');
    }
    async checkAvailability(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'availability');
    }
    async getLiveStatus(params) {
        return railyatriService_1.railyatriService.getTrainStatus(params.trainNo, params.date);
    }
    async getPNRStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'pnr');
    }
    async getTrainSchedule(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'schedule');
    }
    async healthCheck() {
        const start = Date.now();
        try {
            const guard = await providerConfigService_1.providerConfigService.isProviderEnabled('RAILYATRI');
            return mapGuardToHealthStatus(guard, Date.now() - start);
        }
        catch (e) {
            return {
                status: 'UNAVAILABLE',
                latencyMs: Date.now() - start,
                message: e.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}
exports.RailYatriAdapter = RailYatriAdapter;
// ─── 5. RAPIDAPI ADAPTER (Disabled) ────────────────────────────────────────────
class RapidApiAdapter {
    constructor() {
        this.providerId = 'RAPIDAPI';
        this.displayName = 'RapidAPI Legacy Gateway';
        this.capabilities = {
            search: false,
            availability: false,
            liveTracking: false,
            pnr: false,
            schedule: false
        };
    }
    async searchTrains(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'search');
    }
    async checkAvailability(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'availability');
    }
    async getLiveStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'liveTracking');
    }
    async getPNRStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'pnr');
    }
    async getTrainSchedule(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'schedule');
    }
    async healthCheck() {
        return {
            status: 'NOT_CONFIGURED',
            latencyMs: 0,
            message: 'RAPIDAPI_EXPLICITLY_DISABLED',
            timestamp: new Date().toISOString()
        };
    }
}
exports.RapidApiAdapter = RapidApiAdapter;
// ─── 6. DATABASE SCHEDULE ADAPTER ──────────────────────────────────────────────
class DatabaseScheduleAdapter {
    constructor() {
        this.providerId = 'DATABASE';
        this.displayName = 'Internal Timetable & Cache Database';
        this.capabilities = {
            search: true,
            availability: false,
            liveTracking: false,
            pnr: false,
            schedule: true
        };
    }
    async searchTrains(params) {
        return dbService_1.dbService.searchTrains(params.from, params.to, params.date);
    }
    async checkAvailability(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'availability');
    }
    async getLiveStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'liveTracking');
    }
    async getPNRStatus(params) {
        throw new UnsupportedCapabilityError(this.providerId, 'pnr');
    }
    async getTrainSchedule(params) {
        try {
            const { supabase } = require('../config/supabase');
            const { data, error } = await supabase
                .from('train_schedule')
                .select('*')
                .eq('train_number', params.trainNo)
                .order('sn', { ascending: true });
            if (!error && data && data.length > 0) {
                return { train_number: params.trainNo, stations: data };
            }
            return null;
        }
        catch {
            return null;
        }
    }
    async healthCheck() {
        return {
            status: 'HEALTHY',
            message: 'LOCAL_DB_ONLINE',
            timestamp: new Date().toISOString()
        };
    }
}
exports.DatabaseScheduleAdapter = DatabaseScheduleAdapter;
// ─── CENTRAL REGISTRY ─────────────────────────────────────────────────────────
class RailProviderRegistry {
    constructor() {
        this.providers = new Map();
        this.register(new IRCTCAdapter());
        this.register(new RailRadarAdapter());
        this.register(new ConfirmTktAdapter());
        this.register(new RailYatriAdapter());
        this.register(new RapidApiAdapter());
        this.register(new DatabaseScheduleAdapter());
    }
    register(provider) {
        const key = provider.providerId.toUpperCase().trim();
        this.providers.set(key, provider);
        logger_1.winstonLogger.debug(`[RAIL_REGISTRY] Registered provider: ${key}`);
    }
    getProvider(providerId) {
        if (!providerId)
            return undefined;
        const key = providerId.toUpperCase().trim();
        if (this.providers.has(key))
            return this.providers.get(key);
        for (const [pKey, provider] of this.providers.entries()) {
            if (key.includes(pKey) || pKey.includes(key)) {
                return provider;
            }
        }
        return undefined;
    }
    getAllProviders() {
        return Array.from(this.providers.values());
    }
    getProvidersByCapability(capability) {
        return Array.from(this.providers.values()).filter(p => p.capabilities[capability] === true);
    }
    hasCapability(providerId, capability) {
        const provider = this.getProvider(providerId);
        if (!provider)
            return false;
        return provider.capabilities[capability] === true;
    }
}
exports.RailProviderRegistry = RailProviderRegistry;
exports.railProviderRegistry = new RailProviderRegistry();
