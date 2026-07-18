"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const availabilityProvider_1 = require("./services/availabilityProvider");
async function run() {
    console.log('Testing live IRCTC availability for Train 11139 CSMT → PUNE on 2026-06-25...');
    const res = await availabilityProvider_1.availabilityProvider.getAvailability({
        trainNo: '11139',
        from: 'CSMT',
        to: 'PUNE',
        date: '2026-06-25',
        classType: '3A',
        quota: 'GN'
    });
    console.log('Availability Result:', JSON.stringify(res, null, 2));
}
run().catch(console.error);
