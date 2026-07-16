"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBetaAccess = void 0;
const betaService_1 = require("../services/betaService");
const checkBetaAccess = (req, res, next) => {
    const betaCode = req.headers['x-beta-code'];
    if (!betaCode) {
        return res.status(403).json({ success: false, error: 'beta_code_required', message: 'A beta code is required to access this endpoint.' });
    }
    if (!betaService_1.betaService.isValidCode(betaCode)) {
        return res.status(403).json({ success: false, error: 'invalid_beta_code', message: 'The provided beta code is invalid or has expired.' });
    }
    next();
};
exports.checkBetaAccess = checkBetaAccess;
