/**
 * Trayago Diwali Promotional Email Campaign Broadcaster
 *
 * Usage:
 *   Test single dispatch:
 *     ts-node scripts/broadcast_diwali_promo.ts --test peershaikh25@gmail.com
 *   Broadcast to all 500+ users:
 *     ts-node scripts/broadcast_diwali_promo.ts --all
 */

import { supabase } from '../src/config/supabase';
import { emailService } from '../src/services/emailService';

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const testIdx = args.indexOf('--test');
  const testEmail = testIdx !== -1 && args[testIdx + 1] ? args[testIdx + 1] : 'peershaikh25@gmail.com';

  console.log('====================================================');
  console.log('   TRAYAGO DIWALI 2026 PROMOTIONAL CAMPAIGN         ');
  console.log('====================================================');
  console.log('Offer: Trayago Pro Monthly for ₹35 (Code: OFFER35)');
  console.log('Banner: https://www.trayago.in/branding/trayago-diwali-2026.jpg');
  console.log('Claim URL: https://www.trayago.in/pricing?code=OFFER35');
  console.log('----------------------------------------------------');

  if (!isAll) {
    console.log(`[TEST MODE] Sending test promotional email to: ${testEmail}...`);
    try {
      const success = await emailService.sendDiwaliPromoEmail({
        toEmail: testEmail,
        userName: 'Peer Shaikh',
        claimUrl: 'https://www.trayago.in/pricing?code=OFFER35',
        promoCode: 'OFFER35',
        offerPrice: '₹35',
        originalPrice: '₹49'
      });

      if (success) {
        console.log(`[SUCCESS] Test email delivered to ${testEmail}! Please verify in your inbox.`);
      } else {
        console.error(`[FAILURE] Failed to deliver test email to ${testEmail}. Check email provider logs.`);
      }
    } catch (err: any) {
      console.error(`[ERROR] Test dispatch threw error:`, err.message);
    }
    process.exit(0);
  }

  // ALL USERS BROADCAST MODE
  console.log('[BROADCAST MODE] Querying registered users from Supabase...');
  const { data: users, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .not('email', 'is', null);

  if (error || !users) {
    console.error('Failed to query users:', error);
    process.exit(1);
  }

  // Deduplicate and filter valid emails
  const emailMap = new Map<string, { email: string; name: string }>();
  for (const u of users) {
    const raw = (u.email || '').trim().toLowerCase();
    if (raw && raw.includes('@') && raw.includes('.')) {
      if (!emailMap.has(raw)) {
        emailMap.set(raw, { email: raw, name: u.full_name || 'Traveler' });
      }
    }
  }

  const recipients = Array.from(emailMap.values());
  console.log(`Total registered users found: ${users.length}`);
  console.log(`Unique valid email recipients: ${recipients.length}`);
  console.log('----------------------------------------------------');
  console.log('Starting batch dispatch (15 emails/sec with 1s pause)...');

  const BATCH_SIZE = 15;
  let sentCount = 0;
  let failCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(recipients.length / BATCH_SIZE);

    console.log(`[Batch ${batchNum}/${totalBatches}] Dispatching ${batch.length} emails...`);

    await Promise.all(
      batch.map(async (r) => {
        try {
          const ok = await emailService.sendDiwaliPromoEmail({
            toEmail: r.email,
            userName: r.name,
            claimUrl: 'https://www.trayago.in/pricing?code=OFFER35',
            promoCode: 'OFFER35',
            offerPrice: '₹35',
            originalPrice: '₹49'
          });
          if (ok) sentCount++;
          else failCount++;
        } catch (err: any) {
          failCount++;
          console.error(`  x Failed for ${r.email}: ${err.message}`);
        }
      })
    );

    console.log(`  Progress: ${sentCount + failCount}/${recipients.length} (Success: ${sentCount}, Failed: ${failCount})`);

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('====================================================');
  console.log(`BROADCAST COMPLETE in ${durationSec}s!`);
  console.log(`Total Recipients: ${recipients.length}`);
  console.log(`Delivered:        ${sentCount}`);
  console.log(`Failed:           ${failCount}`);
  console.log('====================================================');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal broadcaster error:', err);
  process.exit(1);
});

