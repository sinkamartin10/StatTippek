/** Supabase séma-ellenőrző (fejlesztéshez). Futtatás: npx tsx scripts/check-schema.ts */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const db = createClient((process.env.SUPABASE_URL ?? '').trim(), (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(), { auth: { persistSession: false } });
for (const t of ['predictions', 'slips', 'app_settings', 'manual_odds', 'stripe_events', 'profiles']) {
  const { data, error } = await db.from(t).select('*').limit(1);
  console.log(t.padEnd(16), error ? 'HIBA: ' + error.message.slice(0, 80) : `OK (${data?.length ?? 0} minta sor, oszlopok: ${data?.[0] ? Object.keys(data[0]).join(',').slice(0, 90) : 'üres tábla'})`);
}
