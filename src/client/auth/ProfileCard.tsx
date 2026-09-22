/** Dashboard fiók-kártya: bejelentkezett e-mail, előfizetés státusza, FREE / PRO jelvény. */
import { Link } from 'react-router-dom';
import { Crown, UserCircle2 } from 'lucide-react';
import { Card, ErrorBox, Loading } from '../components/ui';
import { useAuth } from './AuthContext';
import { STATUS_LABEL, daysUntilEnd, expiryText } from './useProfile';
import { usePlan } from './PlanContext';
import { fmtDateTime } from '../lib/format';

export function PlanBadge({ pro }: { pro: boolean }) {
  return pro
    ? <span className="badge badge-green"><Crown className="h-3 w-3" /> PRO</span>
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
          <div className="rounded-lg border border-border bg-bg-2/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Bejelentkezve</div>
            <div className="mt-1 flex items-center gap-2 truncate text-sm font-semibold" title={user.email ?? ''}><UserCircle2 className="h-4 w-4 shrink-0 text-accent" /> {user.email}</div>
          </div>
          <div className="rounded-lg border border-border bg-bg-2/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Előfizetés</div>
            <div className="mt-1 text-sm font-semibold">{profile ? STATUS_LABEL[profile.subscription_status] : '–'}</div>
            {profile && (pro || profile.subscription_end) && (() => {
              const d = daysUntilEnd(profile);
              const soon = d != null && d >= 0 && d <= 7;
              return <div className={`mt-1 text-xs ${d != null && d < 0 ? 'text-danger' : soon ? 'text-warn' : 'text-muted'}`}>{expiryText(profile, fmtDateTime)}{soon ? ' – hamarosan lejár' : ''}</div>;
            })()}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-bg-2/60 p-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Csomag</div>
              <div className="mt-1"><PlanBadge pro={pro} /></div>
            </div>
            <Link to="/pro" className={`btn btn-sm ${pro ? '' : 'btn-primary'}`}><Crown className="h-3.5 w-3.5" /> {pro ? 'PRO részletek' : 'Váltás PRO-ra'}</Link>
          </div>
        </div>
      )}
    </Card>
  );
}
