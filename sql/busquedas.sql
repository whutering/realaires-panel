-- ════════════════════════════════════════════════════════════════════
-- REAL AIRES · MÓDULO BÚSQUEDAS
-- Ejecutar una sola vez en Supabase: SQL Editor → New query → pegar todo → Run
-- Es seguro volver a ejecutarlo: no borra datos existentes.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Administradores ─────────────────────────────────────────────────
-- Los administradores ven y editan todas las búsquedas.
-- Se reconoce como administrador a quien esté en esta lista o tenga
-- app_metadata.rol = 'admin'. Para sumar un administrador, agregar su
-- email a la lista y volver a ejecutar solo esta función.
create or replace function public.ra_es_admin()
returns boolean
language sql stable
as $$
  select coalesce(
    (auth.jwt() ->> 'email') = any (array[
      'pabloe@realaires.com.ar',
      'noelia@realaires.com.ar',
      'sabrina@realaires.com.ar',
      'valentin@realaires.com.ar',
      'adm.realaires@gmail.com'
    ])
    or (auth.jwt() -> 'app_metadata' ->> 'rol') = 'admin',
  false)
$$;

-- Normaliza texto para comparar barrios sin acentos ni mayúsculas
create or replace function public.ra_norm(t text)
returns text
language sql immutable
as $$
  select lower(translate(coalesce(t,''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunaeiouun'))
$$;

-- ── Tabla: búsquedas (una por cliente) ──────────────────────────────
create table if not exists public.busquedas (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  asesor          text,                                   -- nombre del asesor (tabla asesores)
  asesor_email    text not null default (auth.jwt() ->> 'email'),
  cliente_nombre  text not null,
  cliente_tel     text,
  cliente_email   text,
  operacion       text not null default 'Venta',          -- Venta | Alquiler
  tipos           text[] not null default '{}',           -- Departamento, Casa, PH...
  barrios         text[] not null default '{}',
  amb_min         int,
  amb_max         int,
  dorm_min        int,
  precio_min      numeric,
  precio_max      numeric,
  moneda          text not null default 'USD',            -- USD | ARS
  sup_min         numeric,
  requisitos      text[] not null default '{}',           -- Cochera, Balcón, Apto crédito...
  forma_pago      text,                                   -- Contado | Crédito hipotecario | Con venta de propiedad
  estado          text not null default 'Activa',         -- Activa | Pausada | Concretada | Caída
  notas           text
);

-- ── Tabla: propiedades relevadas (pozo común, sin duplicados) ───────
create table if not exists public.propiedades_relevadas (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  creado_por          text default (auth.jwt() ->> 'email'),
  link                text unique,
  portal              text,
  titulo              text,
  tipo                text,
  operacion           text,
  direccion           text,
  barrio              text,
  precio              numeric,
  moneda              text default 'USD',
  expensas            numeric,
  exp_moneda          text default 'ARS',
  amb                 int,
  dorm                int,
  banos               int,
  cocheras            int,
  sup_cub             numeric,
  sup_tot             numeric,
  antiguedad          int,
  contacto_anunciante text,
  contacto_tel        text,
  contacto_whatsapp   text,
  contacto_email      text,
  datos               jsonb
);

-- ── Tabla: vínculo búsqueda ↔ propiedad, con su seguimiento ────────
create table if not exists public.busqueda_propiedades (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  busqueda_id   uuid not null references public.busquedas(id) on delete cascade,
  propiedad_id  uuid not null references public.propiedades_relevadas(id) on delete cascade,
  etapa         text not null default 'Relevada',   -- Relevada | Enviada al cliente | Visita coordinada | Visitada | Ofertada | Descartada
  contactado    text not null default 'Pendiente',  -- Pendiente | Sí | No
  reubicacion   text not null default 'A confirmar',
  prioridad     text not null default 'Media',      -- Alta | Media | Baja
  obs           text,
  agregado_por  text default (auth.jwt() ->> 'email'),
  unique (busqueda_id, propiedad_id)
);

create index if not exists busquedas_asesor_email_idx on public.busquedas (asesor_email);
create index if not exists busquedas_estado_idx       on public.busquedas (estado);
create index if not exists bp_busqueda_idx            on public.busqueda_propiedades (busqueda_id);
create index if not exists bp_propiedad_idx           on public.busqueda_propiedades (propiedad_id);

-- ── updated_at automático ──────────────────────────────────────────
create or replace function public.ra_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_busquedas_touch on public.busquedas;
create trigger trg_busquedas_touch before update on public.busquedas
  for each row execute function public.ra_touch_updated_at();

drop trigger if exists trg_prop_rel_touch on public.propiedades_relevadas;
create trigger trg_prop_rel_touch before update on public.propiedades_relevadas
  for each row execute function public.ra_touch_updated_at();

drop trigger if exists trg_bp_touch on public.busqueda_propiedades;
create trigger trg_bp_touch before update on public.busqueda_propiedades
  for each row execute function public.ra_touch_updated_at();

-- ── Seguridad (RLS) ────────────────────────────────────────────────
alter table public.busquedas             enable row level security;
alter table public.propiedades_relevadas enable row level security;
alter table public.busqueda_propiedades  enable row level security;

-- Búsquedas: cada asesor ve y edita solo las suyas; administradores, todas
drop policy if exists busquedas_select on public.busquedas;
drop policy if exists busquedas_insert on public.busquedas;
drop policy if exists busquedas_update on public.busquedas;
drop policy if exists busquedas_delete on public.busquedas;
create policy busquedas_select on public.busquedas for select to authenticated
  using (asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin());
create policy busquedas_insert on public.busquedas for insert to authenticated
  with check (asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin());
create policy busquedas_update on public.busquedas for update to authenticated
  using (asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin())
  with check (asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin());
create policy busquedas_delete on public.busquedas for delete to authenticated
  using (asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin());

-- Propiedades relevadas: pozo compartido por todo el equipo
drop policy if exists prop_rel_select on public.propiedades_relevadas;
drop policy if exists prop_rel_insert on public.propiedades_relevadas;
drop policy if exists prop_rel_update on public.propiedades_relevadas;
drop policy if exists prop_rel_delete on public.propiedades_relevadas;
create policy prop_rel_select on public.propiedades_relevadas for select to authenticated using (true);
create policy prop_rel_insert on public.propiedades_relevadas for insert to authenticated with check (true);
create policy prop_rel_update on public.propiedades_relevadas for update to authenticated using (true) with check (true);
create policy prop_rel_delete on public.propiedades_relevadas for delete to authenticated using (public.ra_es_admin());

-- Vínculos: acceso según la búsqueda a la que pertenecen
drop policy if exists bp_all on public.busqueda_propiedades;
create policy bp_all on public.busqueda_propiedades for all to authenticated
  using (exists (select 1 from public.busquedas b where b.id = busqueda_id
                 and (b.asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin())))
  with check (exists (select 1 from public.busquedas b where b.id = busqueda_id
                 and (b.asesor_email = (auth.jwt() ->> 'email') or public.ra_es_admin())));

-- ── Cruce automático propiedad ↔ búsquedas activas de todo el equipo ─
-- Devuelve, para cada propiedad, las búsquedas activas que encajan.
-- De las búsquedas de otros asesores solo informa el nombre del asesor
-- (no los datos del cliente).
create or replace function public.ra_cruce_propiedades(p_ids uuid[])
returns table (propiedad_id uuid, busqueda_id uuid, asesor text, es_propia boolean, cliente text, ya_vinculada boolean)
language sql stable security definer
set search_path = public
as $$
  select p.id,
         case when mine then b.id end,
         b.asesor,
         mine,
         case when mine then b.cliente_nombre end,
         exists (select 1 from busqueda_propiedades bp where bp.busqueda_id = b.id and bp.propiedad_id = p.id)
  from propiedades_relevadas p
  join busquedas b on b.estado = 'Activa'
  cross join lateral (select (b.asesor_email = (auth.jwt() ->> 'email') or ra_es_admin()) as mine) m
  where p.id = any (p_ids)
    and auth.uid() is not null
    and (p.operacion is null or b.operacion = p.operacion)
    and (cardinality(b.tipos) = 0 or p.tipo is null or p.tipo = any (b.tipos))
    and (cardinality(b.barrios) = 0 or p.barrio is null or exists (
          select 1 from unnest(b.barrios) z
          where ra_norm(p.barrio) like '%' || ra_norm(z) || '%'
             or ra_norm(z) like '%' || ra_norm(p.barrio) || '%'))
    and (p.amb is null or b.amb_min is null or p.amb >= b.amb_min)
    and (p.amb is null or b.amb_max is null or p.amb <= b.amb_max)
    and (p.dorm is null or b.dorm_min is null or p.dorm >= b.dorm_min)
    and (b.sup_min is null or coalesce(p.sup_cub, p.sup_tot) is null or coalesce(p.sup_cub, p.sup_tot) >= b.sup_min)
    and (p.precio is null or p.moneda is distinct from b.moneda or (
          (b.precio_max is null or p.precio <= b.precio_max * 1.10) and
          (b.precio_min is null or p.precio >= b.precio_min * 0.90)))
$$;

revoke all on function public.ra_cruce_propiedades(uuid[]) from public, anon;
grant execute on function public.ra_cruce_propiedades(uuid[]) to authenticated;
