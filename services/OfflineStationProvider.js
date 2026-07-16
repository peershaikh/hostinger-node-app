"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfflineStationProvider = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../middleware/logger");
class OfflineStationProvider {
    /**
     * Recursively freezes an object to guarantee immutability.
     */
    static deepFreeze(obj) {
        const propNames = Reflect.ownKeys(obj);
        for (const name of propNames) {
            const value = obj[name];
            if (value && typeof value === 'object') {
                this.deepFreeze(value);
            }
        }
        return Object.freeze(obj);
    }
    /**
     * Validates schema: Record<string, string[]>
     */
    static validateSchema(data, fileName) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error(`Schema validation failed for ${fileName}: Root is not an object.`);
        }
        const sanitized = {};
        for (const [key, val] of Object.entries(data)) {
            if (typeof key !== 'string') {
                throw new Error(`Schema validation failed for ${fileName}: Key is not a string.`);
            }
            if (!Array.isArray(val)) {
                throw new Error(`Schema validation failed for ${fileName}: Value for key "${key}" is not an array.`);
            }
            for (const item of val) {
                if (typeof item !== 'string') {
                    throw new Error(`Schema validation failed for ${fileName}: Array item in key "${key}" is not a string.`);
                }
            }
            sanitized[key.toUpperCase().trim()] = val.map(v => v.toUpperCase().trim());
        }
        return sanitized;
    }
    /**
     * Initializes the provider by pre-loading and freezing alias and city configuration.
     * Designed to be called during application startup (fail-fast lifecycle).
     */
    static async initialize() {
        if (this.isInitialized)
            return;
        try {
            const aliasesPath = path_1.default.join(__dirname, '../data/offline_aliases.json');
            const cityPath = path_1.default.join(__dirname, '../data/cityStations.json');
            // 1. Load offline_aliases.json
            if (!fs_1.default.existsSync(aliasesPath)) {
                throw new Error(`Missing offline_aliases.json at path: ${aliasesPath}`);
            }
            const aliasesRaw = fs_1.default.readFileSync(aliasesPath, 'utf8');
            const aliasesParsed = JSON.parse(aliasesRaw);
            const validatedAliases = this.validateSchema(aliasesParsed, 'offline_aliases.json');
            // 2. Load cityStations.json
            if (!fs_1.default.existsSync(cityPath)) {
                throw new Error(`Missing cityStations.json at path: ${cityPath}`);
            }
            const cityRaw = fs_1.default.readFileSync(cityPath, 'utf8');
            const cityParsed = JSON.parse(cityRaw);
            const validatedCity = this.validateSchema(cityParsed, 'cityStations.json');
            // 3. Freeze configurations in memory
            this.aliases = this.deepFreeze(validatedAliases);
            this.cityMap = this.deepFreeze(validatedCity);
            this.isInitialized = true;
            this.initError = undefined;
            logger_1.winstonLogger.info(`[OFFLINE_STATION] Successfully initialized. Loaded ${Object.keys(this.aliases).length} aliases and ${Object.keys(this.cityMap).length} cities.`);
        }
        catch (err) {
            this.initError = err.message;
            logger_1.winstonLogger.error(`[OFFLINE_STATION] Initialization failed: ${err.message}`);
            throw err;
        }
    }
    /**
     * Resolves a city name or alias to actual IRCTC station codes offline.
     * Returns [key] if no offline mappings are found.
     */
    static getStations(input) {
        if (!this.isInitialized) {
            // Synchronous fallback warning in case it wasn't called during startup (e.g. unit tests)
            logger_1.winstonLogger.warn('[OFFLINE_STATION] Provider not pre-initialized. Triggering lazy boot.');
            try {
                // Run sync-init for compatibility
                const aliasesPath = path_1.default.join(__dirname, '../data/offline_aliases.json');
                const cityPath = path_1.default.join(__dirname, '../data/cityStations.json');
                const aliasesRaw = fs_1.default.readFileSync(aliasesPath, 'utf8');
                const validatedAliases = this.validateSchema(JSON.parse(aliasesRaw), 'offline_aliases.json');
                const cityRaw = fs_1.default.readFileSync(cityPath, 'utf8');
                const validatedCity = this.validateSchema(JSON.parse(cityRaw), 'cityStations.json');
                this.aliases = this.deepFreeze(validatedAliases);
                this.cityMap = this.deepFreeze(validatedCity);
                this.isInitialized = true;
            }
            catch (err) {
                this.initError = err.message;
                logger_1.winstonLogger.error(`[OFFLINE_STATION] Lazy initialization failed: ${err.message}`);
                return [input.toUpperCase().trim()];
            }
        }
        if (!input || typeof input !== 'string')
            return [];
        const match = input.match(/\(([^)]+)\)/);
        const rawKey = match ? match[1] : input;
        const key = rawKey.toUpperCase().trim();
        // 1. Resolve aliases
        if (this.aliases[key]) {
            return this.aliases[key];
        }
        // 2. Resolve city mappings
        if (this.cityMap[key]) {
            return this.cityMap[key];
        }
        // 3. Fallback: treat input as station code itself
        return [key];
    }
    /**
     * Checks if the alias key exists offline.
     */
    static hasAlias(aliasName) {
        if (!aliasName || typeof aliasName !== 'string')
            return false;
        const key = aliasName.toUpperCase().trim();
        return !!this.aliases[key];
    }
    /**
     * Checks if the city key exists offline.
     */
    static hasCity(cityName) {
        if (!cityName || typeof cityName !== 'string')
            return false;
        const key = cityName.toUpperCase().trim();
        return !!this.cityMap[key];
    }
    /**
     * Returns current health of the provider.
     */
    static health() {
        if (this.initError) {
            return { status: 'unhealthy', error: this.initError };
        }
        return { status: this.isInitialized ? 'healthy' : 'unhealthy' };
    }
    /**
     * Returns provider statistics.
     */
    static statistics() {
        return {
            aliasesCount: Object.keys(this.aliases).length,
            citiesCount: Object.keys(this.cityMap).length,
        };
    }
}
exports.OfflineStationProvider = OfflineStationProvider;
OfflineStationProvider.aliases = {};
OfflineStationProvider.cityMap = {};
OfflineStationProvider.isInitialized = false;
OfflineStationProvider.initError = undefined;
