-- ===========================================================================
-- 0021 utóellenőrzés – CSAK OLVAS (select), semmit nem módosít.
-- Futtatás: Supabase SQL Editor, a 0021_xs_model_training.sql alkalmazása UTÁN.
-- Elvárt eredmény: minden sor ok = true. (A tests/xsTraining.pg.test.ts ugyanezt futtatja.)
-- ===========================================================================
select check_name, ok from (values
  ('0015 függőség: model_learning_block_removal() létezik',
     exists (select 1 from pg_proc where proname = 'model_learning_block_removal' and pronamespace = 'public'::regnamespace)),
  ('táblák léteznek',
     to_regclass('public.xs_training_matches') is not null and to_regclass('public.xs_training_months') is not null and to_regclass('public.xs_model_fits') is not null),
  ('RLS bekapcsolva mindhárom táblán',
     (select bool_and(relrowsecurity) from pg_class where oid in ('public.xs_training_matches'::regclass, 'public.xs_training_months'::regclass, 'public.xs_model_fits'::regclass))),
  ('nincs policy (anon/authenticated sorhoz sem fér)',
     not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('xs_training_matches', 'xs_training_months', 'xs_model_fits'))),
  ('anon: semmilyen jog',
     not (has_table_privilege('anon', 'public.xs_training_matches', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('anon', 'public.xs_training_months', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('anon', 'public.xs_model_fits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))),
  ('authenticated: semmilyen jog',
     not (has_table_privilege('authenticated', 'public.xs_training_matches', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('authenticated', 'public.xs_training_months', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       or has_table_privilege('authenticated', 'public.xs_model_fits', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))),
  ('service_role: tanítóadat select/insert/update, törlés nincs',
     has_table_privilege('service_role', 'public.xs_training_matches', 'SELECT') and has_table_privilege('service_role', 'public.xs_training_matches', 'INSERT')
       and has_table_privilege('service_role', 'public.xs_training_matches', 'UPDATE') and not has_table_privilege('service_role', 'public.xs_training_matches', 'DELETE,TRUNCATE')
       and has_table_privilege('service_role', 'public.xs_training_months', 'SELECT') and has_table_privilege('service_role', 'public.xs_training_months', 'INSERT')
       and has_table_privilege('service_role', 'public.xs_training_months', 'UPDATE') and not has_table_privilege('service_role', 'public.xs_training_months', 'DELETE,TRUNCATE')),
  ('service_role: becslésnapló csak select/insert (append-only)',
     has_table_privilege('service_role', 'public.xs_model_fits', 'SELECT') and has_table_privilege('service_role', 'public.xs_model_fits', 'INSERT')
       and not has_table_privilege('service_role', 'public.xs_model_fits', 'UPDATE,DELETE,TRUNCATE')),
  ('becslésnapló-őr triggerek (update/delete/truncate)',
     (select count(*) from pg_trigger where tgrelid = 'public.xs_model_fits'::regclass and not tgisinternal
        and tgname in ('xs_model_fits_guard', 'xs_model_fits_no_delete', 'xs_model_fits_no_truncate')) = 3),
  ('dátum-index a tanítóadaton',
     to_regclass('public.idx_xs_training_matches_date') is not null),
  ('megszorítások (azonosító-, csapat-, gól-, hónap-, modell-formátum)',
     (select count(*) from pg_constraint where contype = 'c' and conrelid in ('public.xs_training_matches'::regclass, 'public.xs_training_months'::regclass, 'public.xs_model_fits'::regclass)) >= 16)
) as t(check_name, ok);
