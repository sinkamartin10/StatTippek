/** Fiók-kártya és csomag-jelvény: bejelentkezett e-mail, előfizetés státusza, FREE / PRO. */
import { Link } from 'react-router-dom';
import { Crown, UserCircle2 } from 'lucide-react';
import { Card, ErrorBox, Loading } from '../components/ui';
import { useAuth } from './AuthContext';
import { STATUS_LABEL, daysUntilEnd, expiryText } from './useProfile';
import { usePlan } from './PlanContext';
import { fmtDateTime } from '../lib/format';

export function PlanBadge({ pro }: { pro: boolean }) {
  return pro
    ? <span className="badge badge-yellow"><Crown className="h-3 w-3" /> PRO</span>
    : <span className="badge badge-muted">FREE</span>;
}

export function ProfileCard() {
  const { user, configured } = useAuth();
  const { profile, loading, error, pro, reload } = usePlan();
  if (!configured || !user) return null;

  return (
    <Card title="Fiók" right={<PlanBadge pro={pro} />}>
      {loading && !profile ? <Loading text="Profil betöltése…" /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-card-2 p-3.5">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Bejelentkezve</div>
            <div className="mt-1 flex items-center gap-2 truncate text-sm font-extrabold" title={user.email ?? ''}><UserCircle2 className="h-4 w-4 shrink-0 text-primary" /> {user.email}</div>
          </div>
          <div className="rounded-xl border border-border bg-card-2 p-3.5">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Előfizetés</div>
            <div className="mt-1 text-sm font-extrabold">{profile ? STATUS_LABEL[profile.subscription_status] : '–'}</div>
            {profile && (pro || profile.subscription_end) && (() => {
              const d = daysUntilEnd(profile);
              const soon = d != null && d >= 0 && d <= 7;
              return <div className={`mt-1 text-xs font-bold ${d != null && d < 0 ? 'text-danger' : soon ? 'text-warning' : 'text-text-muted'}`}>{expiryText(profile, fmtDateTime)}{soon ? ' – hamarosan lejár' : ''}</div>;
            })()}
          </div>
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card-2 p-3.5">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Csomag</div>
              <div className="mt-1"><PlanBadge pro={pro} /></div>
            </div>
            <Link to="/pro" className={`btn btn-sm ${pro ? '' : 'btn-primary'}`}><Crown className="h-3.5 w-3.5" /> {pro ? 'PRO részletek' : 'Váltás PRO-ra'}</Link>
          </div>
        </div>
      )}
    </Card>
  );
}
