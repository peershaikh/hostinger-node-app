"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingDecisionService = exports.attributionToQueryString = exports.generateAttribution = exports.bookingProviderRegistry = void 0;
/**
 * PHASE_4C824 / PHASE_4C825 — Booking Gateway Foundation + Decision Engine — barrel export
 *
 * Consumers import from here:
 *   import { createBookingIntent, bookingProviderRegistry, generateAttribution,
 *            bookingDecisionService } from '../booking';
 */
__exportStar(require("./interfaces"), exports);
__exportStar(require("./bookingIntent"), exports);
__exportStar(require("./decisionTypes"), exports);
var providerRegistry_1 = require("./providerRegistry");
Object.defineProperty(exports, "bookingProviderRegistry", { enumerable: true, get: function () { return providerRegistry_1.bookingProviderRegistry; } });
var partnerAttribution_1 = require("./partnerAttribution");
Object.defineProperty(exports, "generateAttribution", { enumerable: true, get: function () { return partnerAttribution_1.generateAttribution; } });
Object.defineProperty(exports, "attributionToQueryString", { enumerable: true, get: function () { return partnerAttribution_1.attributionToQueryString; } });
var bookingDecisionService_1 = require("./bookingDecisionService");
Object.defineProperty(exports, "bookingDecisionService", { enumerable: true, get: function () { return bookingDecisionService_1.bookingDecisionService; } });
