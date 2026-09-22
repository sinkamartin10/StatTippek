/**
 * API kliens. Minden hívás a szerver /api végpontjaira megy; a frontend nem tartalmaz és nem is kap API kulcsot.
 */
import type {
  AppStatus, HistorySummary, League, Match, MatchAnalysis, MatchOdds, PredictionRecord, SourceRecord, Team, TipListEntry, SlipBuildResponse, SlipRecord, SlipStrategy,
  FormSummary, StandingRow, LeagueAverages, MatchResult,
} from '@shared/types';
import { supabase } from './supabase';

export interface MatchWithTeams extends Match {
  homeTeam: Team | null;
  awayTeam: Team | null;
  league: League | null;
}

export interface StandingsResponse {
  league: League;
  averages: LeagueAverages;
  origin: 'demo' | 'live';
  standings: (StandingRow & { team: Team | null; form: string })[];
}

export interface TeamResponse {
  team: Team;
  league: League | null;
  origin: 'demo' | 'live';
  last10: FormSummary;
  home: FormSummary;
  away: FormSummary;
  upcoming: MatchWithTeams[];
  recent: (MatchResult & { homeTeam?: Team; awayTeam?: Team; league?: League })[];
}

export interface SearchResponse { teams: Team[]; leagues: League[]; matches: MatchWithTeams[] }
export interface HistoryResponse { predictions: PredictionRecord[]; summary: HistorySummary; origin: 'demo' | 'live' }

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** A bejelentkezett felhasználó access tokenje (a szerver ebből azonosít; a PRO/FREE állapotot a szerver dönti el). */
async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { authorization: `Bearer ${data.session.access_token}` } : {};
}

/**
 * Az API alapcíme.
 *  - Fejlesztésben és közös hoszton: üres → relatív `/api/...` (a Vite dev szerver proxyzza a 3001-es portra).
 *  - Külön API-hoszton (pl. frontend Cloudflare Pages, backend Render): VITE_API_URL=https://api.pelda.hu
 * A záró perjelet levágjuk, hogy a `${API_BASE}/api/...` mindig helyes legyen.
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeader();
  const res = await fetch(`${API_BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...auth, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Hiba (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  status: () => request<AppStatus>('/status'),
  leagues: () => request<League[]>('/leagues'),
  matches: (params: Record<string, string | undefined>) => request<MatchWithTeams[]>(`/matches${qs(params)}`),
  match: (id: string) => request<MatchWithTeams>(`/matches/${encodeURIComponent(id)}`),
  analysis: (id: string, refresh = false) => request<MatchAnalysis>(`/matches/${encodeURIComponent(id)}/analysis${refresh ? '?refresh=1' : ''}`),
  saveOdds: (id: string, markets: Record<string, string>, bookmaker?: string) =>
    request<MatchOdds>(`/matches/${encodeURIComponent(id)}/odds`, { method: 'POST', body: JSON.stringify({ markets, bookmaker }) }),
  deleteOdds: (id: string) => request<{ ok: true }>(`/matches/${encodeURIComponent(id)}/odds`, { method: 'DELETE' }),
  savePrediction: (id: string, market: string) => request<PredictionRecord>(`/matches/${encodeURIComponent(id)}/predictions`, { method: 'POST', body: JSON.stringify({ market }) }),
  tips: (date?: string) => request<TipListEntry[]>(`/tips${qs({ date })}`),
  standings: (leagueId: string) => request<StandingsResponse>(`/standings/${encodeURIComponent(leagueId)}`),
  team: (id: string) => request<TeamResponse>(`/teams/${encodeURIComponent(id)}`),
  search: (q: string) => request<SearchResponse>(`/search${qs({ q })}`),
  history: (params: Record<string, string | undefined>) => request<HistoryResponse>(`/history${qs(params)}`),
  sources: (params: Record<string, string | undefined>) => request<SourceRecord[]>(`/sources${qs(params)}`),
  slips: (params: Record<string, string | undefined>) => request<SlipBuildResponse>(`/slips${qs(params)}`),
  savedSlips: () => request<SlipRecord[]>('/slips/saved'),
  saveSlip: (strategy: SlipStrategy, label: string, legs: { matchId: string; market: string }[]) => request<SlipRecord>('/slips', { method: 'POST', body: JSON.stringify({ strategy, label, legs }) }),
  billingConfig: () => request<{ configured: boolean; supabase: boolean; productName?: string; amount?: number; currency?: string; interval?: string; label?: string; error?: string }>('/billing/config'),
  billingMe: () => request<{ userId: string; email: string | null; pro: boolean }>('/billing/me'),
  checkout: () => request<{ url: string }>('/billing/checkout', { method: 'POST', body: '{}' }),
  billingPortal: () => request<{ url: string }>('/billing/portal', { method: 'POST', body: '{}' }),
  billingSync: () => request<{ synced: boolean; pro?: boolean; status?: string; reason?: string }>('/billing/sync', { method: 'POST', body: '{}' }),
  settings: () => request<{ shrinkageK: number; status: AppStatus }>('/settings'),
  saveSettings: (shrinkageK: number) => request<{ shrinkageK: number }>('/settings', { method: 'POST', body: JSON.stringify({ shrinkageK }) }),
};
