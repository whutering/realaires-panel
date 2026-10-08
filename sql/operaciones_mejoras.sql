-- ════════════════════════════════════════════════════════════════════
-- REAL AIRES · MEJORAS EN OPERACIONES
-- Firma (horario y dirección verificada) + reportes de asesores
-- Ejecutar una sola vez en Supabase: SQL Editor → New query → pegar todo → Run
-- Es seguro volver a ejecutarlo: no borra datos existentes.
-- Requiere que ya exista la función public.ra_es_admin() (sql/busquedas.sql).
-- ════════════════════════════════════════════════════════════════════

-- ── Firma: horario y dirección verificada con Google ────────────────
alter table public.ventas add column if not exists hora_firma          time;
alter table public.ventas add column if not exists lugar_firma_place_id text;
alter table public.ventas add column if not exists lugar_firma_lat      double precision;
alter table public.ventas add column if not exists lugar_firma_lng      double precision;

-- ── Reportes de asesores sobre sus operaciones ──────────────────────
create table if not exists public.reportes_operacion (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  venta_id      text,                                -- id de public.ventas
  inmueble      text,
  asesor_nombre text,
  asesor_email  text not null default (auth.jwt() ->> 'email'),
  categoria     text not null default 'Otro',
  detalle       text not null,
  estado        text not null default 'Pendiente',   -- Pendiente | Resuelto
  resuelto_at   timestamptz,
  resuelto_por  text,
  mail_enviado  boolean not null default false
);

create index if not exists reportes_operacion_estado_idx on public.reportes_operacion (estado, created_at desc);

alter table public.reportes_operacion enable row level security;

drop policy if exists rep_op_select on public.reportes_operacion;
drop policy if exists rep_op_insert on public.reportes_operacion;
drop policy if exists rep_op_update on public.reportes_operacion;
drop policy if exists rep_op_delete on public.reportes_operacion;

-- Cada asesor ve sus propios reportes; los administradores ven todos
create policy rep_op_select on public.reportes_operacion for select to authenticated
  using (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'));

-- Un asesor solo puede crear reportes a su nombre
create policy rep_op_insert on public.reportes_operacion for insert to authenticated
  with check (asesor_email = (auth.jwt() ->> 'email'));

-- Solo administradores marcan como resuelto o eliminan
create policy rep_op_update on public.reportes_operacion for update to authenticated
  using (public.ra_es_admin()) with check (public.ra_es_admin());
create policy rep_op_delete on public.reportes_operacion for delete to authenticated
  using (public.ra_es_admin());
