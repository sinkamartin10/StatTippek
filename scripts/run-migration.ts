/**
 * Supabase migráció futtató (fejlesztői segédszkript).
 *
 * Futtatás:  npx tsx scripts/run-migration.ts supabase/migrations/0003_app_data.sql
 *
 * A kapcsolatot a .env SUPABASE_DB_URL változójából olvassa (Supabase Dashboard →
 * Settings → Database → Connection string → URI, a "Session pooler" javasolt).
 * A jelszót/kapcsolati sztringet sosem írja a kimenetbe, és a .env gitignore-olt.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const file = process.argv[2];
if (!file) { console.error('Használat: npx tsx scripts/run-migration.ts <sql fájl>'); process.exit(1); }

const conn = (process.env.SUPABASE_DB_URL ?? '').trim();
if (!conn) {
  console.error('Hiányzik a SUPABASE_DB_URL a .env fájlból.');
  console.error('Supabase Dashboard → Settings → Database → Connection string → URI (Session pooler), a [YOUR-PASSWORD] helyére az adatbázis jelszava.');
  process.exit(1);
}

/**
 * A connection stringet komponensekre bontjuk, és külön mezőkként adjuk át a pg kliensnek.
 * Így a jelszóban lévő speciális karakterek (#, @, /, ?, %) sem tudják elrontani az URL-értelmezést.
 */
function parseConnection(raw: string) {
  const m = raw.match(/^postgres(?:ql)?:\/\/([^:]+):(.*)@([^@/]+?)(?::(\d+))?\/([^?]+)(?:\?(.*))?$/s);
  if (!m) throw new Error('A SUPABASE_DB_URL formátuma nem ismerhető fel.');
  const [, user, password, host, port, database] = m;
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  return { user: dec(user), password: dec(password), host, port: port ? Number(port) : 5432, database: dec(database) };
}

const sql = fs.readFileSync(path.resolve(file), 'utf8');
const cfg = parseConnection(conn);
console.log(`Cél: ${cfg.host}:${cfg.port}/${cfg.database} (felhasználó: ${cfg.user})`);
const client = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`Kapcsolódva. Migráció futtatása: ${path.basename(file)} (${sql.length} karakter)`);
  // Egyetlen tranzakcióban: ha bármi hibázik, semmi nem marad félkészen
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('✓ A migráció sikeresen lefutott.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('✗ A migráció HIBÁRA futott (a változások visszagörgetve):', (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
