"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketService = void 0;
const socket_io_1 = require("socket.io");
const logger_1 = require("../middleware/logger");
const cacheService_1 = require("./cacheService");
const irctcService_1 = require("./irctcService");
const liveTrackingService_1 = require("./liveTrackingService");
const providerConfigService_1 = require("./providerConfigService");
const corsOrigin_1 = require("../config/corsOrigin");
class SocketService {
    constructor() {
        this.io = null;
        this.activePNRSubscriptions = new Map(); // pnr -> Set of socketIds
        this.activeTrainSubscriptions = new Map(); // trainNo -> Set of socketIds
    }
    initialize(httpServer) {
        this.io = new socket_io_1.Server(httpServer, {
            cors: {
                origin: corsOrigin_1.corsOriginValidator, // PHASE_4C849: strict per-request whitelist
                credentials: true
            }
        });
        this.io.on('connection', (socket) => {
            logger_1.winstonLogger.info(`[SOCKET_CONNECTED] ${socket.id}`);
            // Handle PNR subscription
            socket.on('subscribe:pnr', async (pnr) => {
                logger_1.winstonLogger.info(`[SOCKET_SUBSCRIBE_PNR] ${socket.id} -> ${pnr}`);
                this.subscribeToPNR(socket, pnr);
            });
            // Handle train subscription
            socket.on('subscribe:train', async (trainNo) => {
                logger_1.winstonLogger.info(`[SOCKET_SUBSCRIBE_TRAIN] ${socket.id} -> ${trainNo}`);
                this.subscribeToTrain(socket, trainNo);
            });
            // Handle availability subscription
            socket.on('subscribe:availability', async (data) => {
                logger_1.winstonLogger.info(`[SOCKET_SUBSCRIBE_AVAILABILITY] ${socket.id} -> ${data.trainNo}`);
                this.subscribeToAvailability(socket, data);
            });
            // Handle unsubscribe
            socket.on('unsubscribe:pnr', (pnr) => {
                this.unsubscribeFromPNR(socket, pnr);
            });
            socket.on('unsubscribe:train', (trainNo) => {
                this.unsubscribeFromTrain(socket, trainNo);
            });
            // Handle disconnect
            socket.on('disconnect', () => {
                logger_1.winstonLogger.info(`[SOCKET_DISCONNECTED] ${socket.id}`);
                this.handleDisconnect(socket);
            });
        });
        // Start periodic updates
        this.startPeriodicUpdates();
        logger_1.winstonLogger.info('[SOCKET_SERVICE] Initialized');
    }
    subscribeToPNR(socket, pnr) {
        if (!this.activePNRSubscriptions.has(pnr)) {
            this.activePNRSubscriptions.set(pnr, new Set());
        }
        this.activePNRSubscriptions.get(pnr)?.add(socket.id);
        socket.join(`pnr:${pnr}`);
    }
    subscribeToTrain(socket, trainNo) {
        if (!this.activeTrainSubscriptions.has(trainNo)) {
            this.activeTrainSubscriptions.set(trainNo, new Set());
        }
        this.activeTrainSubscriptions.get(trainNo)?.add(socket.id);
        socket.join(`train:${trainNo}`);
    }
    subscribeToAvailability(socket, data) {
        const roomId = `availability:${data.trainNo}:${data.from}:${data.to}:${data.date}:${data.quota}:${data.classType}`;
        socket.join(roomId);
    }
    unsubscribeFromPNR(socket, pnr) {
        const subscriptions = this.activePNRSubscriptions.get(pnr);
        if (subscriptions) {
            subscriptions.delete(socket.id);
            if (subscriptions.size === 0) {
                this.activePNRSubscriptions.delete(pnr);
            }
        }
        socket.leave(`pnr:${pnr}`);
    }
    unsubscribeFromTrain(socket, trainNo) {
        const subscriptions = this.activeTrainSubscriptions.get(trainNo);
        if (subscriptions) {
            subscriptions.delete(socket.id);
            if (subscriptions.size === 0) {
                this.activeTrainSubscriptions.delete(trainNo);
            }
        }
        socket.leave(`train:${trainNo}`);
    }
    handleDisconnect(socket) {
        // Remove socket from all PNR subscriptions
        this.activePNRSubscriptions.forEach((sockets, pnr) => {
            if (sockets.has(socket.id)) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    this.activePNRSubscriptions.delete(pnr);
                }
            }
        });
        // Remove socket from all train subscriptions
        this.activeTrainSubscriptions.forEach((sockets, trainNo) => {
            if (sockets.has(socket.id)) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    this.activeTrainSubscriptions.delete(trainNo);
                }
            }
        });
    }
    // Emit PNR update to all subscribed clients
    async emitPNRUpdate(pnr, data) {
        if (this.io) {
            this.io.to(`pnr:${pnr}`).emit('pnr:update', { pnr, data });
            logger_1.winstonLogger.info(`[SOCKET_EMIT_PNR] ${pnr} to ${this.activePNRSubscriptions.get(pnr)?.size || 0} clients`);
        }
    }
    // Emit train update to all subscribed clients
    async emitTrainUpdate(trainNo, data) {
        if (this.io) {
            this.io.to(`train:${trainNo}`).emit('train:update', { trainNo, data });
            logger_1.winstonLogger.info(`[SOCKET_EMIT_TRAIN] ${trainNo} to ${this.activeTrainSubscriptions.get(trainNo)?.size || 0} clients`);
        }
    }
    // Emit availability update to all subscribed clients
    async emitAvailabilityUpdate(data, availabilityData) {
        if (this.io) {
            const roomId = `availability:${data.trainNo}:${data.from}:${data.to}:${data.date}:${data.quota}:${data.classType}`;
            this.io.to(roomId).emit('availability:update', availabilityData);
            logger_1.winstonLogger.info(`[SOCKET_EMIT_AVAILABILITY] ${roomId}`);
        }
    }
    // Get PNR status from multiple sources
    async getPNRStatus(pnr) {
        let rawStatus = null;
        let pnrSource = "RAPIDAPI";
        const irctcGuard = await providerConfigService_1.providerConfigService.isProviderEnabled('IRCTC');
        if (irctcGuard.enabled) {
            try {
                logger_1.winstonLogger.info(`[PNR_PRIMARY] IRCTC for ${pnr}`);
                rawStatus = await irctcService_1.irctcService.checkPNRStatus(pnr);
                if (rawStatus) {
                    pnrSource = "IRCTC";
                    logger_1.winstonLogger.info(`[PNR_SUCCESS] IRCTC found ${pnr}`);
                }
                else {
                    logger_1.winstonLogger.warn(`[PNR_IRCTC_EMPTY] IRCTC returned success but insufficient PNR payload for ${pnr}`);
                    rawStatus = null; // Force fallback
                }
            }
            catch (e) {
                logger_1.winstonLogger.error(`[IRCTC_PNR_FAIL] ${pnr}: ${e}`);
            }
        }
        else {
            const skipLabel = (irctcGuard.reason === 'PROVIDER_UNHEALTHY' || irctcGuard.reason === 'CIRCUIT_BREAKER_BLOCKED')
                ? '[PROVIDER_SKIPPED_UNHEALTHY]'
                : '[PROVIDER_SKIPPED_DISABLED]';
            logger_1.winstonLogger.info(`${skipLabel} IRCTC | Reason: ${irctcGuard.reason}`);
        }
        return rawStatus;
    }
    // Periodic updates for subscribed PNRs and trains
    startPeriodicUpdates() {
        // Update PNR status every 60 seconds
        setInterval(async () => {
            for (const [pnr, sockets] of this.activePNRSubscriptions.entries()) {
                if (sockets.size > 0) {
                    try {
                        // Check if chart is prepared (stop auto-refresh if so)
                        const cachedData = cacheService_1.cacheService.getCachedPNR(pnr);
                        if (cachedData && cachedData.data && cachedData.data.chart_status) {
                            const statusUpper = cachedData.data.chart_status.toUpperCase();
                            if ((statusUpper.includes('CHART PREPARED') || statusUpper.includes('CHART PREPARE') || statusUpper.includes('PREPARED')) &&
                                !statusUpper.includes('NOT PREPARED')) {
                                // Notify clients that auto-refresh has stopped
                                this.io?.to(`pnr:${pnr}`).emit('pnr:autoRefreshStopped', {
                                    pnr,
                                    message: 'Chart prepared, auto-refresh stopped'
                                });
                                continue;
                            }
                        }
                        // Fetch fresh PNR data
                        const pnrData = await this.getPNRStatus(pnr);
                        if (pnrData) {
                            await this.emitPNRUpdate(pnr, pnrData);
                            // Cache the updated data
                            cacheService_1.cacheService.cachePNR(pnr, pnrData);
                        }
                    }
                    catch (error) {
                        logger_1.winstonLogger.error(`[SOCKET_PNR_UPDATE_ERROR] ${pnr}: ${error}`);
                    }
                }
            }
        }, 60000); // 60 seconds
        // Update train status every 30 seconds
        setInterval(async () => {
            for (const [trainNo, sockets] of this.activeTrainSubscriptions.entries()) {
                if (sockets.size > 0) {
                    try {
                        const trainData = await liveTrackingService_1.liveTrackingService.getTrainRunningStatus(trainNo, new Date().toISOString().split('T')[0]);
                        if (trainData) {
                            await this.emitTrainUpdate(trainNo, trainData);
                        }
                    }
                    catch (error) {
                        logger_1.winstonLogger.error(`[SOCKET_TRAIN_UPDATE_ERROR] ${trainNo}: ${error}`);
                    }
                }
            }
        }, 30000); // 30 seconds
    }
    // Admin monitoring
    getActiveSubscriptions() {
        return {
            pnrSubscriptions: Array.from(this.activePNRSubscriptions.entries()).map(([pnr, sockets]) => ({
                pnr,
                count: sockets.size
            })),
            trainSubscriptions: Array.from(this.activeTrainSubscriptions.entries()).map(([trainNo, sockets]) => ({
                trainNo,
                count: sockets.size
            }))
        };
    }
    // Broadcast admin message
    broadcastAdminMessage(message) {
        if (this.io) {
            this.io.emit('admin:message', { message });
        }
    }
    // Get connection count
    getConnectionCount() {
        return this.io ? this.io.engine.clientsCount : 0;
    }
}
exports.socketService = new SocketService();
