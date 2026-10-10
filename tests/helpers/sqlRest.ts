/**
 * SQL-alapú PostgREST-utánzat TESZTEKHEZ – a `@supabase/supabase-js` lekérdezés-
 * építőjének azt a részhalmazát valósítja meg, amelyet a `Postgres*Store`
 * osztályok használnak, és minden hívást a PostgREST által generált SQL
 * megfelelőjére fordít, majd egy HELYI, eldobható adatbázison `service_role`
 * szerepben futtat (psql-en át).
 *
 * Hűség: a beszúrás/frissítés a PostgREST-hez hasonlóan `json_populate_recordset`
 * / `json_populate_record` segítségével alakítja a JSON-t sorrá (ugyanaz a
 * típus-koerció), a válasz `json_agg` (ugyanaz a JSON-szerializáció), az
 * időzóna UTC, és opcionálisan emulálja a `db-max-rows` korlátot.
 *
 * NEM PostgREST: az URL-kódolás, a JWT-alapú szerepváltás, a séma-gyorsítótár,
 * a HTTP-állapotkódok és a PGRST-hibakódok NEM ellenőrizhetők vele.
 */
import { execFileSync } from 'node:child_process';

export interface SqlRestOptions {
  host: '127.0.0.1';
  db: string;
  psql: string;
  role: string;
  /** a PostgREST `db-max-rows` korlátjának emulációja (alapból nincs) */
  maxRows?: number;
}

export interface RecordedOp {
  /** a hívó tároló-metódus neve (a `tagged` burkoló állítja) */
  tag: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'RPC';
  resource: string;
  kind: 'select' | 'insert' | 'upsert' | 'update' | 'rpc';
  columns: string[];
  payloadKeys: string[];
  filters: string[];
  order: string[];
  range: string | null;
  returning: string[] | null;
  count: boolean;
  single: boolean;
  onConflict: string | null;
  ok: boolean;
  error: string | null;
  rows: number | null;
}

type Filter = { col: string; op: string; val: unknown } | { raw: string };

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('nem véges szám'); return String(v); }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** A PostgREST `or=(…)` logikai fa egyszerű részhalmaza: `col.op.value,…` */
function parseOr(expr: string): string {
  const parts: string[] = [];
  let cur = ''; let q = false;
  for (const ch of expr) {
    if (ch === '"') q = !q;
    if (ch === ',' && !q) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  const ops: Record<string, string> = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
  return '(' + parts.map((p) => {
    const m = p.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/);
    if (!m) throw new Error(`nem támogatott or-kifejezés: ${p}`);
    const [, col, op, rawVal] = m;
    const val = rawVal.startsWith('"') && rawVal.endsWith('"') ? rawVal.slice(1, -1) : rawVal;
    if (op === 'is') { if (val !== 'null') throw new Error('csak is.null támogatott'); return `${ident(col)} IS NULL`; }
    if (!ops[op]) throw new Error(`nem támogatott operátor: ${op}`);
    return `${ident(col)} ${ops[op]} ${lit(val)}`;
  }).join(' OR ') + ')';
}

export class SqlRest {
  log: RecordedOp[] = [];
  /** a következő N hívás hibával tér vissza (átmeneti hiba szimulációja) */
  failNext = 0;
  /** célzott hiba: ha igaz, az adott művelet hibával tér vissza */
  failOn: ((op: RecordedOp) => boolean) | null = null;
  /** az éppen futó tároló-metódus neve */
  tag = '';
  constructor(private o: SqlRestOptions) {}

  /** Nyers SQL a megadott szerepben; JSON-t ad vissza. */
  run(sql: string): { ok: true; out: string } | { ok: false; err: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: this.o.host, PGDATABASE: this.o.db, PGCLIENTENCODING: 'UTF8' };
    for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[k];
    try {
      const out = execFileSync(this.o.psql, ['-h', this.o.host, '-U', process.env.PGUSER || 'postgres', '-d', this.o.db, '-X', '-q', '-t', '-A',
        '-v', 'ON_ERROR_STOP=1'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
        input: `set timezone = 'UTC';\nset role ${this.o.role};\n${sql}`,
      });
      return { ok: true, out: out.replace(/\r/g, '').trim() };
    } catch (e) {
      const x = e as { stderr?: string };
      return { ok: false, err: String(x.stderr ?? e).replace(/\r/g, '').replace(/^psql:[^:]*:\d+: /gm, '').trim() };
    }
  }

  from(resource: string) { return new Builder(this, this.o, resource); }

  rpc(fn: string, args: Record<string, unknown>) {
    const self = this;
    return {
      then(resolve: (v: { data: null; error: { message: string } | null }) => void, reject?: (e: unknown) => void) {
        try {
          const op: RecordedOp = { tag: self.tag, method: 'RPC', resource: `rpc/${fn}`, kind: 'rpc', columns: [], payloadKeys: Object.keys(args), filters: [], order: [], range: null,
            returning: null, count: false, single: false, onConflict: null, ok: false, error: null, rows: null };
          self.log.push(op);
          if (self.failNext > 0 || self.failOn?.(op)) { if (self.failNext > 0) self.failNext--; op.error = 'szimulált átmeneti hiba'; resolve({ data: null, error: { message: op.error } }); return; }
          // A PostgREST nevesített paraméterekkel hívja; a típusokat a katalógusból vesszük.
          const meta = self.run(`select coalesce(json_agg(json_build_object('n', n, 't', format_type(t, null))), '[]') from pg_proc p,
            unnest(p.proargnames, p.proargtypes::oid[]) as a(n, t) where p.proname = ${lit(fn)} and p.pronamespace = 'public'::regnamespace`);
          if (!meta.ok) throw new Error(meta.err);
          const sig = JSON.parse(meta.out) as { n: string; t: string }[];
          const unknown = Object.keys(args).filter((k) => !sig.some((s) => s.n === k));
          if (!sig.length || unknown.length) {
            op.error = `Could not find the function public.${fn}(${Object.keys(args).join(', ')}) in the schema cache`;
            resolve({ data: null, error: { message: op.error } });
            return;
          }
          const call = sig.filter((s) => s.n in args).map((s) => `${s.n} => ${lit(args[s.n])}::${s.t}`).join(', ');
          const r = self.run(`select public.${fn}(${call});`);
          op.ok = r.ok; op.error = r.ok ? null : r.err;
          resolve({ data: null, error: r.ok ? null : { message: r.err } });
        } catch (e) { reject?.(e); }
      },
    };
  }
}

class Builder {
  private kind: RecordedOp['kind'] = 'select';
  private cols = '*';
  private countExact = false;
  private head = false;
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private lim: number | null = null;
  private off = 0;
  private payload: Record<string, unknown>[] = [];
  private returning: string | null = null;
  private onConflict: string | null = null;
  private ignoreDup = false;
  private single = false;

  constructor(private api: SqlRest, private o: SqlRestOptions, private rel: string) {}

  select(cols = '*', opts: { count?: 'exact'; head?: boolean } = {}) {
    if (this.kind === 'select') { this.cols = cols; this.countExact = opts.count === 'exact'; this.head = !!opts.head; } else this.returning = cols;
    return this;
  }
  insert(v: Record<string, unknown> | Record<string, unknown>[]) { this.kind = 'insert'; this.payload = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Record<string, unknown> | Record<string, unknown>[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.kind = 'upsert'; this.payload = Array.isArray(v) ? v : [v]; this.onConflict = o.onConflict ?? null; this.ignoreDup = !!o.ignoreDuplicates;
    if (!this.ignoreDup) throw new Error('csak ignoreDuplicates upsert támogatott');
    return this;
  }
  update(v: Record<string, unknown>) { this.kind = 'update'; this.payload = [v]; return this; }
  eq(col: string, val: unknown) { this.filters.push({ col, op: '=', val }); return this; }
  neq(col: string, val: unknown) { this.filters.push({ col, op: '<>', val }); return this; }
  lt(col: string, val: unknown) { this.filters.push({ col, op: '<', val }); return this; }
  gte(col: string, val: unknown) { this.filters.push({ col, op: '>=', val }); return this; }
  ilike(col: string, val: unknown) { this.filters.push({ col, op: 'ILIKE', val }); return this; }
  in(col: string, vals: unknown[]) { this.filters.push({ col, op: 'IN', val: vals }); return this; }
  or(expr: string) { this.filters.push({ raw: parseOr(expr) }); return this; }
  order(col: string, o: { ascending?: boolean } = {}) { this.orders.push({ col, asc: o.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.off = a; this.lim = b - a + 1; return this; }
  maybeSingle() { this.single = true; return this; }

  private where(): string {
    if (!this.filters.length) return '';
    return ' WHERE ' + this.filters.map((f) => {
      if ('raw' in f) return f.raw;
      if (f.op === 'IN') { const v = f.val as unknown[]; return v.length ? `${ident(f.col)} IN (${v.map(lit).join(', ')})` : 'false'; }
      return `${ident(f.col)} ${f.op} ${lit(f.val)}`;
    }).join(' AND ');
  }

  private record(extra: Partial<RecordedOp>): RecordedOp {
    const method: RecordedOp['method'] = this.kind === 'select' ? (this.head ? 'HEAD' : 'GET') : this.kind === 'update' ? 'PATCH' : 'POST';
    const op: RecordedOp = {
      tag: this.api.tag, method, resource: this.rel, kind: this.kind,
      columns: this.kind === 'select' ? this.cols.split(',').map((c) => c.trim()) : [],
      payloadKeys: [...new Set(this.payload.flatMap((p) => Object.keys(p)))],
      filters: this.filters.map((f) => ('raw' in f ? `or${f.raw}` : `${f.col} ${f.op}`)),
      order: this.orders.map((x) => `${x.col} ${x.asc ? 'asc' : 'desc'}`),
      range: this.lim == null ? null : `${this.off}-${this.off + this.lim - 1}`,
      returning: this.returning == null ? null : this.returning.split(',').map((c) => c.trim()),
      count: this.countExact, single: this.single, onConflict: this.onConflict,
      ok: false, error: null, rows: null, ...extra,
    };
    this.api.log.push(op);
    return op;
  }

  private exec(): { data: unknown; error: { message: string } | null; count: number | null } {
    const op = this.record({});
    if (this.api.failNext > 0 || this.api.failOn?.(op)) { if (this.api.failNext > 0) this.api.failNext--; op.error = 'szimulált átmeneti hiba'; return { data: null, error: { message: op.error }, count: null }; }
    const rel = `public.${ident(this.rel)}`;
    let sql: string;
    if (this.kind === 'select') {
      const cols = this.cols === '*' ? '*' : this.cols.split(',').map((c) => ident(c.trim())).join(', ');
      const order = this.orders.length ? ' ORDER BY ' + this.orders.map((x) => `${ident(x.col)} ${x.asc ? 'ASC' : 'DESC'}`).join(', ') : '';
      let lim = this.lim;
      if (this.o.maxRows != null) lim = lim == null ? this.o.maxRows : Math.min(lim, this.o.maxRows);
      const page = `${lim == null ? '' : ` LIMIT ${lim}`}${this.off ? ` OFFSET ${this.off}` : ''}`;
      const where = this.where();
      // HEAD-nél is a kért oszlopokkal épül a lekérdezés (a PostgREST is így validálja őket)
      sql = `select json_build_object('data', ${this.head ? `(select null::json from (select ${cols} from ${rel}${where} limit 0) h)` : `(select coalesce(json_agg(t), '[]'::json) from (select ${cols} from ${rel}${where}${order}${page}) t)`},
        'count', ${this.countExact ? `(select count(*) from (select ${cols} from ${rel}${where}) c)` : 'null'});`;
    } else if (this.kind === 'insert' || this.kind === 'upsert') {
      const keys = [...new Set(this.payload.flatMap((p) => Object.keys(p)))];
      const body = lit(JSON.stringify(this.payload));
      const conflict = this.kind === 'upsert' ? ` ON CONFLICT (${this.onConflict!.split(',').map((c) => ident(c.trim())).join(', ')}) DO NOTHING` : '';
      const ins = `INSERT INTO ${rel} (${keys.map(ident).join(', ')}) SELECT ${keys.map(ident).join(', ')} FROM json_populate_recordset(NULL::${rel}, ${body}::json)${conflict}`;
      sql = this.returning == null
        ? `${ins}; select json_build_object('data', null, 'count', null);`
        : `with w as (${ins} RETURNING ${this.returning.split(',').map((c) => ident(c.trim())).join(', ')}) select json_build_object('data', (select coalesce(json_agg(w), '[]'::json) from w), 'count', null);`;
    } else {
      const keys = Object.keys(this.payload[0]);
      const body = lit(JSON.stringify(this.payload[0]));
      const set = `(${keys.map(ident).join(', ')}) = (SELECT ${keys.map((k) => `r.${ident(k)}`).join(', ')} FROM json_populate_record(NULL::${rel}, ${body}::json) r)`;
      const upd = `UPDATE ${rel} SET ${keys.length === 1 ? `${ident(keys[0])} = (SELECT r.${ident(keys[0])} FROM json_populate_record(NULL::${rel}, ${body}::json) r)` : set}${this.where()}`;
      sql = this.returning == null
        ? `with w as (${upd} RETURNING 1) select json_build_object('data', null, 'count', null);`
        : `with w as (${upd} RETURNING ${this.returning.split(',').map((c) => ident(c.trim())).join(', ')}) select json_build_object('data', (select coalesce(json_agg(w), '[]'::json) from w), 'count', null);`;
    }
    const r = this.api.run(sql);
    if (!r.ok) { op.error = r.err; return { data: null, error: { message: r.err }, count: null }; }
    // a json_agg az elemek közé sortörést tesz – a teljes kimenet EGY JSON-érték
    const res = JSON.parse(r.out) as { data: unknown[] | null; count: number | null };
    op.ok = true; op.rows = Array.isArray(res.data) ? res.data.length : null;
    if (this.single) {
      const d = res.data ?? [];
      if (d.length > 1) { op.ok = false; op.error = 'JSON object requested, multiple (or no) rows returned'; return { data: null, error: { message: op.error }, count: null }; }
      return { data: d[0] ?? null, error: null, count: res.count };
    }
    return { data: res.data, error: null, count: res.count };
  }

  then(resolve: (v: { data: unknown; error: { message: string } | null; count: number | null }) => void, reject?: (e: unknown) => void) {
    try { resolve(this.exec()); } catch (e) { reject?.(e); }
  }
}

/** A tároló minden metódushívásánál beállítja a `tag`-et – így a napló metódusonként csoportosítható. */
export function tagged<T extends object>(store: T, rest: SqlRest): T {
  return new Proxy(store, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => { rest.tag = String(prop); return (v as (...a: unknown[]) => unknown).apply(t, args); };
    },
  });
}
