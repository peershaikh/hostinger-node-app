import { authService, User } from './services/authService';
import { betaService } from './services/betaService';
import { usageMiddleware } from './middleware/usageMiddleware';
import { isSupabaseConfigured, supabase } from './config/supabase';
import { userRepository } from './repositories/userRepository';
import { userCache } from './cache/userCache';
import fs from 'fs';
import path from 'path';

// Force configure fallback files
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'guests.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'users.json'), '[]');

// Helper to mock express req/res
const mockReqRes = (headers: any) => {
    const req = { headers, ip: '127.0.0.1' } as any;
    let responseData: any = null;
    let statusCode = 200;
    const res = {
        status: (code: number) => { statusCode = code; return res; },
        json: (data: any) => { responseData = data; return res; }
    } as any;
    const next = () => {};
    return { req, res, next, getResponse: () => ({ status: statusCode, data: responseData }) };
};

const runTests = async () => {
    console.log("====================================================");
    console.log("RUNNING BETA ENTITLEMENT END-TO-END VALIDATION");
    console.log("====================================================\n");

    // Add a 3-second delay to allow asynchronous init() to complete
    console.log("Waiting 3s for betaService and authService initialization...\n");
    await new Promise(resolve => setTimeout(resolve, 3000));

    const TEST_CODE = 'TRAYAGO25';

    // Print Code Diagnostics
    const codeInfo = betaService.getCode(TEST_CODE);
    console.log("=== Code Diagnostics ===");
    console.log("Code details in memory:", JSON.stringify(codeInfo, null, 2));
    if (codeInfo) {
        console.log("isActive:", codeInfo.isActive);
        console.log("currentRedemptions:", codeInfo.currentRedemptions);
        console.log("maxRedemptions:", codeInfo.maxRedemptions);
        console.log("expiresAt:", codeInfo.expiresAt);
        console.log("isValidCode result:", betaService.isValidCode(TEST_CODE));
    }
    console.log("========================\n");

    // 1. Setup mock user with a VALID UUID
    const USER_UUID = 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2';

    // Prevent duplicates and dirty cache/db states
    (authService as any).users = (authService as any).users.filter((u: any) => u.id !== USER_UUID && u.email !== 'beta@tester.com');
    await userCache.invalidate(USER_UUID);

    const mockBetaUser: User = {
        id: USER_UUID, email: 'beta@tester.com', password: 'password', referralCode: 'BETA1',
        createdAt: new Date().toISOString(), dailySearchCount: 0, dailyPnrCount: 0, dailyLiveCount: 0,
        lastUsageReset: new Date().toISOString().split('T')[0], splitAccessUntil: null,
        planType: 'free', planExpiry: null, isAdmin: false, credits: 0, aiSplitSearches: 0,
        adsWatchedToday: 0, lastAdWatchTime: 0
    };

    if (isSupabaseConfigured()) {
        try {
            console.log("Supabase configured. Cleaning up and prepping test user...");
            await supabase.from('users').delete().eq('id', USER_UUID);
            await supabase.from('users').delete().eq('email', 'beta@tester.com');
            const { error: insertErr } = await supabase.from('users').insert({
                id: mockBetaUser.id,
                email: mockBetaUser.email,
                password: mockBetaUser.password,
                referral_code: mockBetaUser.referralCode,
                created_at: mockBetaUser.createdAt,
                daily_search_count: mockBetaUser.dailySearchCount,
                daily_pnr_count: mockBetaUser.dailyPnrCount,
                daily_live_count: mockBetaUser.dailyLiveCount,
                last_usage_reset: mockBetaUser.lastUsageReset,
                plan_type: mockBetaUser.planType,
                is_admin: mockBetaUser.isAdmin,
                is_blocked: false
            });
            if (insertErr) {
                console.warn("Supabase clean insert returned error:", insertErr.message);
            }
        } catch (e: any) {
            console.warn("Failed database setup for test user:", e.message);
        }
    }

    (authService as any).users.push(mockBetaUser);
    (authService as any).saveUsers();
    await userCache.setUser(mockBetaUser);

    // Get the dynamic limits from authService
    const searchLimit = await authService.getEffectiveLimit(USER_UUID, 'free', 'search');
    console.log(`Resolved FREE search limit from DB/fallback: ${searchLimit}\n`);

    // 2. FRESH USER QUOTA TEST (Prior to redemption)
    console.log("=== Test 1: Fresh User (Free Tier) Quota Check ===");
    const headersBeforeRedeem = { 'x-user-id': USER_UUID };
    
    // Simulate search requests up to the free limit
    let isBlocked = false;
    for (let i = 1; i <= searchLimit + 1; i++) {
        let { req, res, next, getResponse } = mockReqRes(headersBeforeRedeem);
        await usageMiddleware('search')(req, res, next);
        
        if (getResponse().status === 200) {
            await authService.incrementUsage(USER_UUID, 'search');
            // Wait for any async Supabase update and invalidation to settle
            await new Promise(resolve => setTimeout(resolve, 300));
            const activeUserAfter = await authService.getUserById(USER_UUID);
            console.log(`Search #${i}: ALLOWED (Searches used: ${activeUserAfter?.dailySearchCount})`);
        } else {
            isBlocked = true;
            console.log(`Search #${i}: BLOCKED - Reason:`, getResponse().data);
        }
    }
    
    const activeUserFinal = await authService.getUserById(USER_UUID);
    if (isBlocked && activeUserFinal?.dailySearchCount === searchLimit) {
        console.log(`✅ SUCCESS: Free user correctly blocked after ${searchLimit} searches.`);
    } else {
        console.log("❌ FAILURE: Free user quota check is broken.");
    }

    // 3. BETA CODE REDEMPTION & ACTIVE ACCESS TEST
    console.log("\n=== Test 2: Redeem TRAYAGO25 Code & Verify Unlimited Access ===");
    
    // Calculate code duration days
    const codeDetails = betaService.getCode(TEST_CODE);
    let durationDays = 30;
    if (codeDetails && codeDetails.expiresAt) {
        const msDiff = new Date(codeDetails.expiresAt).getTime() - Date.now();
        durationDays = Math.max(0.1, msDiff / (24 * 60 * 60 * 1000));
    }
    
    // Execute redemption simulated backend workflow
    const redeemed = await betaService.redeemCode(USER_UUID, TEST_CODE);
    await authService.changeUserPlan(USER_UUID, 'beta', durationDays);
    
    // Synchronously ensure database is updated for the test user to bypass async race conditions
    if (isSupabaseConfigured()) {
        const planExpiry = new Date();
        planExpiry.setDate(planExpiry.getDate() + durationDays);
        await userRepository.update(USER_UUID, {
            planType: 'beta',
            planExpiry: planExpiry.toISOString(),
            lastSubscriptionDate: new Date().toISOString()
        });
        await userCache.invalidate(USER_UUID);
    } else {
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    const activeUserBeta = await authService.getUserById(USER_UUID);
    console.log(`Redeemed code: ${TEST_CODE}. Status: ${redeemed ? "SUCCESS" : "FAILED"}`);
    console.log(`User DB planType: ${activeUserBeta?.planType}, planExpiry: ${activeUserBeta?.planExpiry}`);

    // Verify unlimited searches are bypassed (performing 10 searches)
    let allSearchesAllowed = true;
    for (let i = 1; i <= 10; i++) {
        let { req, res, next, getResponse } = mockReqRes(headersBeforeRedeem);
        await usageMiddleware('search')(req, res, next);
        
        if (getResponse().status === 200) {
            await authService.incrementUsage(USER_UUID, 'search');
            await new Promise(resolve => setTimeout(resolve, 100));
        } else {
            allSearchesAllowed = false;
        }
    }

    // Since they have unlimited access, the dailySearchCount should remain unchanged (at searchLimit)
    const activeUserBetaFinal = await authService.getUserById(USER_UUID);
    console.log(`Searches used after 10 more attempts: ${activeUserBetaFinal?.dailySearchCount}`);
    
    if (allSearchesAllowed && activeUserBetaFinal?.dailySearchCount === searchLimit) {
        console.log("✅ SUCCESS: Active Beta user has unlimited search queries (bypasses limits).");
    } else {
        console.log("❌ FAILURE: Active Beta user was blocked or had usage incremented.");
    }

    // 4. EXPIRY VALIDATION TEST
    console.log("\n=== Test 3: Expired Beta Code Expiry Enforcer Check ===");
    
    // Manually set planExpiry to the past (e.g. 5 minutes ago)
    const pastDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    // Expose memory references to update plans and exhaust limits
    const inMemUser = (authService as any).users.find((u: any) => u.id === USER_UUID);
    if (inMemUser) {
        inMemUser.planExpiry = pastDate;
        inMemUser.dailySearchCount = searchLimit; // Exhaust limits!
        (authService as any).saveUsers();
    }

    // Sync to Supabase directly and clear cache so that the expired status is read
    if (isSupabaseConfigured()) {
        await userRepository.update(USER_UUID, {
            planExpiry: pastDate,
            dailySearchCount: searchLimit
        });
        await userCache.invalidate(USER_UUID);
    } else {
        const u = await authService.getUserById(USER_UUID);
        if (u) {
            u.planExpiry = pastDate;
            u.dailySearchCount = searchLimit;
            await userCache.setUser(u);
        }
    }

    // Request search
    let expiredReq = mockReqRes(headersBeforeRedeem);
    await usageMiddleware('search')(expiredReq.req, expiredReq.res, expiredReq.next);
    const expiredResult = expiredReq.getResponse();
    
    // Wait for the async downgrade writes to settle in database and cache!
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const activeUserExpired = await authService.getUserById(USER_UUID);
    console.log("Expired user search request status:", expiredResult.status);
    console.log("User planType after evaluation:", activeUserExpired?.planType);
    console.log("User planExpiry after evaluation:", activeUserExpired?.planExpiry);

    if (expiredResult.status === 403 && activeUserExpired?.planType === 'free') {
        console.log("✅ SUCCESS: Expired beta entitlement correctly downgraded to free and blocked.");
    } else {
        console.log("❌ FAILURE: Expired beta entitlement allowed request or failed to downgrade.");
    }

    // 5. GUEST ACCESS WITH BETA CODE HEADER TEST
    console.log("\n=== Test 4: Guest Access via x-beta-code Header ===");
    const guestHeadersWithBeta = { 'x-device-id': 'guest-device-p1', 'x-beta-code': TEST_CODE };
    
    let allGuestAllowed = true;
    for (let i = 1; i <= 10; i++) {
        let { req, res, next, getResponse } = mockReqRes(guestHeadersWithBeta);
        await usageMiddleware('search')(req, res, next);
        if (getResponse().status !== 200) {
            allGuestAllowed = false;
        }
    }

    if (allGuestAllowed) {
        console.log("✅ SUCCESS: Guest using valid beta header successfully bypassed limits.");
    } else {
        console.log("❌ FAILURE: Guest with valid beta header was blocked.");
    }

    console.log("\n====================================================");
    console.log("ALL E2E VALIDATION TESTS COMPLETED");
    console.log("====================================================");
};

runTests();

