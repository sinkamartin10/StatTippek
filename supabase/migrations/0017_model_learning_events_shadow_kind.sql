-- ===========================================================================
-- 0017 – audit-esemény típus: 'shadow_evaluation'
--
-- MIÉRT KELL: a 0015 korábbi változata nélküle hozta létre a
-- `model_learning_events_kind` megszorítást. Az árnyék-kiértékelés (és így az
-- aktiválás árnyék-kapuja) ezt az eseménytípust írja. A 0015 újrafuttatása ezt
-- nem javítja (`create table if not exists` a meglévő megszorítást kihagyja).
--
-- MIT TESZ: ha a megszorítás még nem engedi a 'shadow_evaluation' típust,
-- lecseréli a 0015 jelenlegi definíciójára (a régi lista bővítése – minden
-- meglévő sor továbbra is érvényes). Más objektumhoz nem nyúl.
--
-- Újrafuttatható: ha a megszorítás már tartalmazza, semmit nem csinál.
-- Egy tranzakcióban futtatandó.
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_learning_events_kind'
      and conrelid = 'public.model_learning_events'::regclass
      and pg_get_constraintdef(oid) like '%''shadow_evaluation''%'
  ) then
    alter table public.model_learning_events drop constraint if exists model_learning_events_kind;
    alter table public.model_learning_events add constraint model_learning_events_kind check (kind in (
      'evaluation', 'insufficient_data', 'candidate_rejected', 'candidate_eligible',
      'promotion', 'promotion_refused', 'rollback', 'failure', 'fallback', 'shadow_evaluation'));
  end if;
end $$;
