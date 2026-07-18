import { Request, Response } from 'express';
import { authService } from '../services/authService';
import { cacheService } from '../services/cacheService';
import {
  getJwtUserId,
  getBetaCode,
  getDeviceId,
  hasLegacyUserIdQuery,
} from '../utils/requestIdentity';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { userRepository } from '../repositories/userRepository';
import { winstonLogger } from '../middleware/logger';
import * as admin from 'firebase-admin';
import jwt from 'jsonwebtoken';

export class AuthController {
  googleLogin = async (req: Request, res: Response) => {
    try {
      const { idToken, deviceId, referralCode } = req.body;
      if (!idToken) {
        return res.status(400).json({ success: false, error: 'Google ID Token is required' });
      }

      if (!admin.apps.length) {
        // Initialize Firebase Admin dynamically just for token verification
        const decodedUnverified = jwt.decode(idToken) as any;
        if (!decodedUnverified || !decodedUnverified.aud) {
          return res.status(400).json({ success: false, error: 'Invalid token structure' });
        }
        admin.initializeApp({ projectId: decodedUnverified.aud });
      }

      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const payload = {
        email: decodedToken.email,
        name: decodedToken.name,
        picture: decodedToken.picture
      };
      
      if (!payload || !payload.email) {
        return res.status(400).json({ success: false, error: 'Invalid Google token' });
      }

      const result = await authService.googleLogin(
        payload.email,
        payload.name || '',
        payload.picture || '',
        deviceId,
        referralCode
      );

      res.cookie('refreshToken', result.tokens.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      return res.json({ 
        success: true, 
        data: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        ...(result.referralMeta ? { referralMeta: result.referralMeta } : {})
      });
    } catch (err: any) {
      winstonLogger.error(`[AUTH_GOOGLE] Failed google login: ${err.message}`);
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  signup = async (req: Request, res: Response) => {
    try {
      const { email, password, referralCode, deviceId, otp, fullName, mobileNumber, dob } = req.body;
      if (!email || !password || !otp) {
        return res.status(400).json({ success: false, error: 'Email, password, and OTP required' });
      }

      // Conditional validation for Phase A optional profile fields
      if (fullName !== undefined) {
        if (typeof fullName !== 'string' || fullName.trim().length < 2 || !/^[a-zA-Z\s]+$/.test(fullName)) {
          return res.status(400).json({ success: false, error: 'Full name must be at least 2 characters and contain letters only' });
        }
      }

      if (mobileNumber !== undefined && mobileNumber !== '') {
        if (typeof mobileNumber !== 'string' || !/^(?:\+91|91)?[6-9]\d{9}$/.test(mobileNumber)) {
          return res.status(400).json({ success: false, error: 'Invalid mobile number format' });
        }
      }

      if (dob !== undefined && dob !== '') {
        if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          return res.status(400).json({ success: false, error: 'Date of birth must be in YYYY-MM-DD format' });
        }
        const birthDate = new Date(dob);
        if (isNaN(birthDate.getTime()) || birthDate >= new Date()) {
          return res.status(400).json({ success: false, error: 'Invalid date of birth' });
        }
      }

      // Check device lock for abuse prevention
      if (deviceId) {
        const isLocked = authService.checkDeviceLock(deviceId, null);
        if (isLocked) {
          return res.status(403).json({ 
            success: false, 
            error: 'This device is already registered to another account. Please use a different device or contact support.' 
          });
        }
      }

      const result = await authService.signup(email, password, referralCode, deviceId, otp, fullName, mobileNumber, dob);

      // Associate device ID with user for abuse prevention
      if (deviceId) {
        // This is handled in the signup method now
      }

      res.cookie('refreshToken', result.tokens.refreshToken, {
        httpOnly: true,
        secure: true, // required for sameSite:none
        sameSite: 'none', // cross-domain fix: www.trayago.com → app.trayago.in
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      return res.json({ 
        success: true, 
        data: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,   // Mobile stores this; browsers rely on httpOnly cookie
        ...(result.referralMeta ? { referralMeta: result.referralMeta } : {})
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  login = async (req: Request, res: Response) => {
    try {
      const { email, password, deviceId, referralCode } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
      }

      // Check device lock for abuse prevention
      if (deviceId) {
        // We'll check this after login
      }

      const result = await authService.login(email, password, deviceId, referralCode);

      res.cookie('refreshToken', result.tokens.refreshToken, {
        httpOnly: true,
        secure: true, // required for sameSite:none
        sameSite: 'none', // cross-domain fix: www.trayago.com → app.trayago.in
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      return res.json({ 
        success: true, 
        data: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,   // Mobile stores this; browsers rely on httpOnly cookie
        ...(result.referralMeta ? { referralMeta: result.referralMeta } : {})
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  sendOtp = async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, error: 'Email required' });
      }

      await authService.sendOtp(email);
      return res.json({ success: true, message: 'OTP sent successfully' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  verifyOtp = async (req: Request, res: Response) => {
    // Deprecated for signup, but kept for compatibility
    return res.json({ success: true, data: { message: 'Email verified' } });
  };

  status = async (req: Request, res: Response) => {
    try {
      const userId = getJwtUserId(req);
      const betaCode = getBetaCode(req);

      // PHASE_4C967: reject legacy query userId — identity must come from JWT only
      if (hasLegacyUserIdQuery(req) && !userId) {
        return res.status(401).json({
          success: false,
          error: 'JWT required for user status',
          code: 'JWT_REQUIRED',
        });
      }

      if (!userId && !betaCode) {
        return res.status(400).json({ success: false, error: 'JWT or betaCode required' });
      }

      const status = await authService.getUserStatus(userId, betaCode);
      if (!status) return res.status(404).json({ success: false, error: 'User not found' });

      return res.json({ success: true, data: status });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  getQuotaStatus = async (req: Request, res: Response) => {
    try {
      const userId = getJwtUserId(req);
      let deviceId = getDeviceId(req);
      const betaCode = getBetaCode(req);

      if (!userId && !deviceId) {
        deviceId = `ip_${req.ip}`;
      }

      // Check Cache
      const cacheKey = `quota_status:${userId || deviceId}`;
      const cached = cacheService.get<any>(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached });
      }

      const status = await authService.getUserStatus(userId, betaCode, deviceId);
      if (!status) {
        return res.status(404).json({ success: false, error: 'User or device not found' });
      }

      // Filter to return only relevant quota and warning information
      const filteredData = {
        planType: status.planType || (status.isGuest ? 'guest' : 'free'),
        isAdmin: status.isAdmin || false,
        isBeta: status.isBeta || false,
        bypassQuota: status.bypassQuota || status.isAdmin || status.isBeta || status.planType === 'admin',
        usage: status.usage || { searches: 0, pnr: 0, live: 0 },
        limits: status.limits || { searches: 3, pnr: 2, live: 2 },
        warnings: status.warnings || { searches: false, pnr: false, live: false },
        hasSplitAccess: status.hasSplitAccess || false
      };

      // Set Cache with a 15-second TTL
      cacheService.set(cacheKey, filteredData, 15);

      return res.json({ success: true, data: filteredData });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  canUseFeature = async (req: Request, res: Response) => {
    try {
      const { userId, feature } = req.body;
      if (!userId || !feature) {
        return res.status(400).json({ success: false, error: 'userId and feature required' });
      }

      const canUse = await authService.canUseFeature(userId, feature);
      return res.json({ success: true, data: { canUse } });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  canUseSplit = async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId required' });
      }

      const canUse = await authService.canUseSplit(userId);
      return res.json({ success: true, data: { canUse } });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  checkDeviceLock = async (req: Request, res: Response) => {
    try {
      const { deviceId, userId } = req.body;
      const isLocked = authService.checkDeviceLock(deviceId, userId);
      res.json({ success: true, isLocked });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  mockAdView = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string || null;
      let deviceId = req.headers['x-device-id'] as string;
      if (!userId && !deviceId) deviceId = `ip_${req.ip}`;

      const result = await authService.watchAd(userId, deviceId);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─── Forgot Password Flow ─────────────────────────────────────────────────

  forgotPassword = async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required' });
      }
      await authService.sendPasswordResetOtp(email);
      return res.json({ success: true, message: 'Password reset OTP sent to your email' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  resetPassword = async (req: Request, res: Response) => {
    try {
      const { email, otp, newPassword } = req.body;
      if (!email || !otp || !newPassword) {
        return res.status(400).json({ success: false, error: 'Email, OTP and new password are required' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      }
      authService.resetPassword(email, otp, newPassword);
      return res.json({ success: true, message: 'Password reset successfully. Please log in.' });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  refresh = async (req: Request, res: Response) => {
    try {
      // Dual-mode: cookie (web) first, then Authorization header, then JSON body (mobile)
      const authHeader = req.headers['authorization'];
      const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const token = req.cookies?.refreshToken || headerToken || req.body?.refreshToken;
      if (!token) {
        return res.status(401).json({
          success: false,
          error: 'No refresh token provided',
          code: 'REFRESH_REQUIRED',
        });
      }

      const tokens = await authService.verifyRefreshToken(token);

      // Re-set cookie with cross-domain settings
      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });

      // Return refreshToken in body too — mobile clients store it in AsyncStorage
      return res.json({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: any) {
      res.clearCookie('refreshToken');
      return res.status(401).json({
        success: false,
        error: 'Refresh token invalid or revoked',
        code: 'SESSION_EXPIRED',
      });
    }
  };

  logout = async (req: Request, res: Response) => {
    // Increment tokenVersion so existing access tokens are immediately rejected
    // by usageMiddleware (which checks x-token-version on every quota-gated request)
    const userId = req.headers['x-user-id'] as string | undefined;
    if (userId) {
      try {
        await authService.terminateUserSessions(userId);
      } catch (err: any) {
        winstonLogger.warn(`[AUTH] logout: terminateUserSessions failed for ${userId}: ${err.message}`);
        // Non-fatal — still proceed with logout
      }
    }
    res.clearCookie('refreshToken');
    return res.json({ success: true, message: 'Logged out successfully' });
  };

  appOpen = async (req: Request, res: Response) => {
    try {
      const userId = (req.body.userId as string) || (req.headers['x-user-id'] as string) || null;
      let deviceId = (req.body.deviceId as string) || (req.headers['x-device-id'] as string);

      if (!userId && !deviceId) {
        deviceId = `ip_${req.ip}`;
      }

      const resetPerformed = await authService.resetDailyUsageExplicit(userId, deviceId);
      
      // Invalidate quota status cache for this user/device on reset
      const cacheKey = `quota_status:${userId || deviceId}`;
      cacheService.del(cacheKey);

      return res.json({ success: true, resetPerformed });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  getProfile = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const user = await authService.getUserById(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // 1. Calculate profile completion percentage
      let score = 40; // Base: signed up & email verified
      if (user.fullName && user.fullName.trim().length >= 2 && /^[a-zA-Z\s]+$/.test(user.fullName)) {
        score += 20;
      }
      if (user.mobileNumber && /^(?:\+91|91)?[6-9]\d{9}$/.test(user.mobileNumber)) {
        score += 20;
      }
      if (user.dob && !isNaN(Date.parse(user.dob)) && new Date(user.dob) < new Date()) {
        score += 20;
      }

      // 2. Birthday verification (IST timezone)
      const todayIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const birthdayMMDD = `${String(todayIST.getMonth() + 1).padStart(2, '0')}-${String(todayIST.getDate()).padStart(2, '0')}`;
      const isBirthdayToday = !!(user.dob && user.dob.substring(5, 10) === birthdayMMDD);
      const canClaimBirthdayReward = isBirthdayToday && (user.birthdayRewardLastClaimedYear !== todayIST.getFullYear());

      return res.json({
        success: true,
        data: {
          email: user.email,
          fullName: user.fullName || '',
          mobileNumber: user.mobileNumber || '',
          dob: user.dob || '',
          avatarUrl: user.avatarUrl || '',
          profileCompletionPercentage: score,
          isBirthdayToday,
          rewardEligibility: {
            canClaimBirthdayReward,
            rewardLastClaimedYear: user.birthdayRewardLastClaimedYear || null
          },
          mobileVerification: {
            verified: user.mobileVerified || false,
            method: user.mobileVerificationMethod || null,
            verifiedAt: user.mobileVerifiedAt || null
          },
          preferences: {
            notifyEmail: user.notifyEmail !== false,
            notifyBirthday: user.notifyBirthday !== false,
            notifyMarketing: !!user.notifyMarketing
          }
        }
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  updateProfile = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { fullName, dob, preferences, mobileNumber } = req.body;

      // Validate inputs
      if (fullName !== undefined) {
        if (typeof fullName !== 'string' || fullName.trim().length < 2 || !/^[a-zA-Z\s]+$/.test(fullName)) {
          return res.status(400).json({ success: false, error: 'Full name must be at least 2 characters and contain letters only' });
        }
      }

      if (dob !== undefined && dob !== '') {
        if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          return res.status(400).json({ success: false, error: 'Date of birth must be in YYYY-MM-DD format' });
        }
        const birthDate = new Date(dob);
        if (isNaN(birthDate.getTime()) || birthDate >= new Date()) {
          return res.status(400).json({ success: false, error: 'Invalid date of birth' });
        }
      }

      if (mobileNumber !== undefined && mobileNumber !== '') {
        if (typeof mobileNumber !== 'string' || !/^(?:\+91|91)?[6-9]\d{9}$/.test(mobileNumber)) {
          return res.status(400).json({ success: false, error: 'Invalid Indian mobile number format' });
        }
      }

      const updatedUser = await authService.updateUserProfile(userId, { fullName, dob, preferences, mobileNumber });

      // Calculate new completion score
      let score = 40;
      if (updatedUser.fullName && updatedUser.fullName.trim().length >= 2 && /^[a-zA-Z\s]+$/.test(updatedUser.fullName)) {
        score += 20;
      }
      if (updatedUser.mobileNumber && /^(?:\+91|91)?[6-9]\d{9}$/.test(updatedUser.mobileNumber)) {
        score += 20;
      }
      if (updatedUser.dob && !isNaN(Date.parse(updatedUser.dob)) && new Date(updatedUser.dob) < new Date()) {
        score += 20;
      }

      return res.json({
        success: true,
        message: 'Profile details updated successfully',
        profileCompletionPercentage: score
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  sendMobileOtp = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { mobileNumber } = req.body;
      if (!mobileNumber) {
        return res.status(400).json({ success: false, error: 'Mobile number is required' });
      }

      if (!/^(?:\+91|91)?[6-9]\d{9}$/.test(mobileNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid Indian mobile number format' });
      }

      await authService.sendMobileOtp(userId, mobileNumber);

      return res.json({
        success: true,
        message: 'OTP sent to mobile successfully'
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  verifyMobileOtp = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { otpCode } = req.body;
      if (!otpCode) {
        return res.status(400).json({ success: false, error: 'Verification code is required' });
      }

      await authService.verifyMobileOtp(userId, otpCode);

      // Fetch updated user to return latest status
      const updatedUser = await authService.getUserById(userId);
      let score = 40;
      if (updatedUser) {
        if (updatedUser.fullName && updatedUser.fullName.trim().length >= 2 && /^[a-zA-Z\s]+$/.test(updatedUser.fullName)) {
          score += 20;
        }
        if (updatedUser.mobileNumber && /^(?:\+91|91)?[6-9]\d{9}$/.test(updatedUser.mobileNumber)) {
          score += 20;
        }
        if (updatedUser.dob && !isNaN(Date.parse(updatedUser.dob)) && new Date(updatedUser.dob) < new Date()) {
          score += 20;
        }
      }

      return res.json({
        success: true,
        message: 'Mobile number verified successfully',
        profileCompletionPercentage: score
      });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  };

  uploadAvatar = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { avatarData } = req.body;
      if (!avatarData) {
        return res.status(400).json({ success: false, error: 'No image data provided' });
      }

      // Check size (max 2MB)
      const base64Length = avatarData.length;
      const sizeInBytes = Math.floor(base64Length * (3 / 4));
      if (sizeInBytes > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Image size exceeds maximum limit of 2MB' });
      }

      // Validate base64 image type
      const match = avatarData.match(/^data:image\/(jpeg|png|webp);base64,/);
      if (!match) {
        return res.status(400).json({ success: false, error: 'Invalid image format. Allowed: JPEG, PNG, WEBP' });
      }

      const ext = match[1];
      const cleanBase64 = avatarData.replace(/^data:image\/(jpeg|png|webp);base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');

      // Strict magic-bytes verification
      let magicBytesValid = false;
      const header = buffer.toString('hex', 0, 4).toUpperCase();
      
      if (ext === 'png' && header === '89504E47') magicBytesValid = true;
      else if (ext === 'jpeg' && (header.startsWith('FFD8FF'))) magicBytesValid = true;
      else if (ext === 'webp' && header.startsWith('52494646')) magicBytesValid = true; // "RIFF"

      if (!magicBytesValid) {
        return res.status(400).json({ success: false, error: 'Malicious file signature detected. Upload aborted.' });
      }

      let avatarUrl = '';
      let supabaseUploaded = false;

      // Try uploading to Supabase Storage if configured
      if (isSupabaseConfigured()) {
        try {
          const filePath = `${userId}-${Date.now()}.${ext}`;
          
          // Upload file buffer directly using supabase-js client
          const { data, error } = await supabase.storage
            .from('avatars')
            .upload(filePath, buffer, {
              contentType: `image/${ext}`,
              upsert: true
            });

          if (error) {
            winstonLogger.warn(`[UPLOAD_SUPABASE_FAIL] Supabase storage upload failed: ${error.message}. Falling back to local.`);
          } else {
            const { data: publicUrlData } = supabase.storage
              .from('avatars')
              .getPublicUrl(filePath);

            avatarUrl = publicUrlData.publicUrl;
            supabaseUploaded = true;
            winstonLogger.info(`[UPLOAD_SUCCESS] Uploaded user avatar to Supabase: ${avatarUrl}`);
          }
        } catch (e: any) {
          winstonLogger.warn(`[UPLOAD_SUPABASE_EXCEPTION] ${e.message}. Falling back to local.`);
        }
      }

      // Fallback: Write file to local static directory
      if (!supabaseUploaded) {
        const publicDir = path.join(__dirname, '../../public/uploads');
        if (!fs.existsSync(publicDir)) {
          fs.mkdirSync(publicDir, { recursive: true });
        }

        const fileName = `${userId}-${Date.now()}.${ext}`;
        const filePath = path.join(publicDir, fileName);
        
        fs.writeFileSync(filePath, buffer);
        
        const host = req.get('host') || 'localhost:5000';
        const protocol = req.protocol || 'http';
        avatarUrl = `${protocol}://${host}/uploads/${fileName}`;
        winstonLogger.info(`[UPLOAD_SUCCESS] Saved user avatar locally: ${avatarUrl}`);
      }

      // Update user record in memory and database
      const updatedUser = await authService.getUserById(userId);
      if (updatedUser) {
        updatedUser.avatarUrl = avatarUrl;
        
        // Save locally & database
        if (isSupabaseConfigured()) {
          try {
            await userRepository.update(userId, { avatarUrl });
          } catch (err: any) {
            winstonLogger.warn(`[UPLOAD_DB_SYNC_FAIL] Failed to update avatarUrl in Supabase users table: ${err.message}`);
          }
          const { userCache } = require('../cache/userCache');
          await userCache.invalidate(userId);
        }
        
        (authService as any).updateLocalUser(updatedUser);
        (authService as any).saveUsers();
      }

      return res.json({
        success: true,
        message: 'Avatar uploaded successfully',
        avatarUrl
      });
    } catch (err: any) {
      winstonLogger.error(`[UPLOAD_EXCEPTION] ${err.message}`);
      return res.status(500).json({ success: false, error: err.message || 'Failed to upload profile photo' });
    }
  };

  removeAvatar = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const updatedUser = await authService.getUserById(userId);
      if (updatedUser) {
        updatedUser.avatarUrl = '';

        if (isSupabaseConfigured()) {
          try {
            await userRepository.update(userId, { avatarUrl: '' });
          } catch (err: any) {
            winstonLogger.warn(`[REMOVE_DB_SYNC_FAIL] Failed to reset avatarUrl in Supabase: ${err.message}`);
          }
          const { userCache } = require('../cache/userCache');
          await userCache.invalidate(userId);
        }

        (authService as any).updateLocalUser(updatedUser);
        (authService as any).saveUsers();
      }

      return res.json({
        success: true,
        message: 'Profile photo removed successfully'
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to remove profile photo' });
    }
  };

  deleteAccount = async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      await authService.deleteUserAccount(userId);
      res.clearCookie('refreshToken');
      
      return res.json({
        success: true,
        message: 'Account deleted successfully'
      });
    } catch (err: any) {
      winstonLogger.error(`[AUTH_CONTROLLER_DELETE] Deletion error: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message || 'Failed to delete account' });
    }
  };
}

export const authController = new AuthController();

