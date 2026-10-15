/**
 * Melyik modell számolta a valószínűségeket, és – a több ligás modellnél – milyen
 * adatminőségi kategóriában. A modellt a SZERVER választja (PRO: xs-strength-1, ha az
 * adatminőség engedi); a felület csak megjeleníti.
 */
import type { ServedModelInfo } from '@shared/types';
import { fmtDateTime } from '../lib/format';

const QUALITY_BADGE: Record<NonNullable<ServedModelInfo['quality']>, string> = {
  elegendo: 'badge-green', korlatozott: 'badge-yellow', keves_regularizalt: 'badge-yellow', elegtelen: 'badge-red',
};

/** Tömör jelvény (tippkártya, fejléc). Régi válasznál (model nélkül) nem jelenik meg. */
export function ModelBadge({ model }: { model?: ServedModelInfo }) {
  if (!model) return null;
  if (model.id === 'xs-strength-1') {
    return (
      <span className={`badge ${model.quality ? QUALITY_BADGE[model.quality] : 'badge-blue'}`} title={model.qualityReason ?? ''} data-model={model.id}>
        🧠 Több ligás modell{model.qualityLabel ? ` · ${model.qualityLabel}` : ''}
      </span>
    );
  }
  return (
    <span className="badge badge-muted" title={model.fallbackReason ?? ''} data-model={model.id}>
      xG + Poisson{model.fallbackReason ? ' · alap motor' : ''}
    </span>
  );
}

/** Részletes magyarázat a mérkőzésoldalon: kategória-indoklás, visszaesés oka, becslés-azonosító. */
export function ModelNote({ model }: { model?: ServedModelInfo }) {
  if (!model || (model.id === 'xg-poisson-1' && !model.fallbackReason)) return null;
  if (model.id === 'xs-strength-1') {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary-soft px-4 py-3 text-sm font-semibold" data-model-note="xs">
        <b>Több ligás erősségmodell (xs-strength-1).</b> {model.qualityLabel}{model.qualityReason ? ` – ${model.qualityReason}` : ''}
        <span className="mt-1 block text-xs text-text-muted">
          Tanítóadat: {model.trainedMatches ?? '–'} lezárt meccs{model.fitCutoff ? `, ${fmtDateTime(model.fitCutoff)} előtt` : ''} · becslés: <span className="mono">{model.fitId?.slice(0, 12) ?? '–'}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card-2 px-4 py-3 text-sm font-semibold" data-model-note="fallback">
      <b>Alap motor (xG + Poisson).</b> A több ligás modell ennél a meccsnél nem szolgál ki: {model.fallbackReason}
    </div>
  );
}
