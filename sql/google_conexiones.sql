-- ════════════════════════════════════════════════════════════════════
-- REAL AIRES · CONEXIÓN CON GOOGLE (Calendar y Gmail)
-- Ejecutar una sola vez en Supabase: SQL Editor → New query → pegar todo → Run
-- Es seguro volver a ejecutarlo: no borra datos existentes.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.google_conexiones (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email_panel    text,
  google_email   text,
  calendar       boolean not null default false,
  gmail          boolean not null default false,
  refresh_token  text,          -- cifrado; solo lo lee la función google-oauth-callback
  conectado_at   timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);

alter table public.google_conexiones enable row level security;

-- El token nunca sale hacia el navegador: los usuarios solo pueden leer el estado
revoke all on public.google_conexiones from anon, authenticated;
grant select (user_id, email_panel, google_email, calendar, gmail, conectado_at, actualizado_at)
  on public.google_conexiones to authenticated;

drop policy if exists google_con_select on public.google_conexiones;
create policy google_con_select on public.google_conexiones for select to authenticated
  using (user_id = auth.uid() or public.ra_es_admin());
