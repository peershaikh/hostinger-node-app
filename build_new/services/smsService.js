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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.smsService = exports.SmsService = void 0;
const logger_1 = require("../middleware/logger");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class SmsService {
    constructor() {
        this.logFilePath = path.join(__dirname, '../../../logs/sms.log');
        // Ensure logs directory exists
        const dir = path.dirname(this.logFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    /**
     * Mock send SMS OTP logic
     * Logs to winston and writes to server/logs/sms.log for easy manual testing
     */
    async sendSmsOtp(mobileNumber, otpCode) {
        try {
            const message = `[SMS_GATEWAY] Mobile OTP sent successfully to ${mobileNumber}: Verification code is ${otpCode}`;
            // Log to Winston Logger
            logger_1.winstonLogger.info(message);
            // Append to local log file for QA testing
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] TO: ${mobileNumber} | CODE: ${otpCode} | MSG: Your Trayago mobile verification code is ${otpCode}. Valid for 5 minutes.\n`;
            fs.appendFileSync(this.logFilePath, logEntry);
            return true;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SMS_EXCEPTION] Failed to send SMS to ${mobileNumber}: ${err.message}`);
            return false;
        }
    }
}
exports.SmsService = SmsService;
exports.smsService = new SmsService();
