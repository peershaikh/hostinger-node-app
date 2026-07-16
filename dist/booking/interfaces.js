"use strict";
/**
 * PHASE_4C824 — Universal Booking Gateway Interfaces
 *
 * This file defines the structural contracts for the Booking Gateway Foundation.
 * It contains interfaces and types ONLY — no implementation, no business logic,
 * no real booking, no payment, no agent login.
 *
 * Everything below is guarded by BOOKING_GATEWAY=false by default.
 * No existing behaviour is changed by importing these types.
 *
 * Future booking providers will implement BookingProvider.
 * The gateway router will consume BookingIntent and produce BookingResult.
 */
Object.defineProperty(exports, "__esModule", { value: true });
