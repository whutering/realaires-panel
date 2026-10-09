-- ════════════════════════════════════════════════════════════════════
-- REAL AIRES · COMERCIALIZACIÓN DE CAPTACIONES Y VISITAS
-- Ejecutar una sola vez en Supabase: SQL Editor → New query → pegar todo → Run
-- Es seguro volver a ejecutarlo: no borra datos existentes.
-- Requiere public.ra_es_admin() (sql/busquedas.sql u operaciones_mejoras.sql).
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Propiedades en comercialización (una por captación) ─────────────
create table if not exists public.comercializaciones (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  ficha_id           text unique,                       -- id de public.fichas (si viene de prelisting)
  direccion          text not null,
  barrio             text,
  operacion          text not null default 'Venta',     -- Venta | Alquiler
  propietario        text,
  asesor             text,                              -- nombre del asesor responsable
  asesor_email       text default (auth.jwt() ->> 'email'),
  precio             numeric,
  moneda             text not null default 'USD',
  historial_precios  jsonb not null default '[]',       -- [{ fecha, precio, moneda }]
  fecha_publicacion  date,
  portales           text[] not null default '{}',
  link_aviso         text,
  estado             text not null default 'Activa',    -- Activa | Pausada | Reservada | Vendida | Retirada
  notas              text,
  metricas           jsonb not null default '{}'        -- métricas de portales y Meta para el informe
);

-- ── Visitas a cada propiedad ────────────────────────────────────────
create table if not exists public.visitas (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  comercializacion_id uuid not null references public.comercializaciones(id) on delete cascade,
  fecha_hora          timestamptz not null,
  asesor              text,                             -- quien acompaña la visita
  asesor_email        text not null default (auth.jwt() ->> 'email'),
  interesado          text,
  interesado_tel      text,
  busqueda_id         uuid,                             -- búsqueda (Prebuying) vinculada, si existe
  canal               text,                             -- Zonaprop, Argenprop, MercadoLibre, Meta, Cartel, Referido, Base propia, Otro
  estado              text not null default 'Agendada', -- Agendada | Realizada | Cancelada | No se presentó
  etapa               text,                             -- Primera visita | Segunda visita | Oferta | Reserva | Descartado
  interes             text,                             -- Alto | Medio | Bajo
  valoraciones        text[] not null default '{}',     -- Le gustó, Precio alto, Ubicación, Estado del inmueble...
  devolucion          text,
  devolucion_at       timestamptz
);

create index if not exists visitas_com_idx    on public.visitas (comercializacion_id, fecha_hora desc);
create index if not exists visitas_asesor_idx on public.visitas (asesor_email, estado, fecha_hora);

-- ── Permisos ────────────────────────────────────────────────────────
alter table public.comercializaciones enable row level security;
alter table public.visitas            enable row level security;

drop policy if exists com_select on public.comercializaciones;
drop policy if exists com_insert on public.comercializaciones;
drop policy if exists com_update on public.comercializaciones;
drop policy if exists com_delete on public.comercializaciones;

-- Todo el equipo ve las propiedades en comercialización (para cargar visitas con sus compradores)
create policy com_select on public.comercializaciones for select to authenticated using (true);
create policy com_insert on public.comercializaciones for insert to authenticated with check (true);
-- Edita el asesor responsable o un administrador
create policy com_update on public.comercializaciones for update to authenticated
  using (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'))
  with check (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'));
create policy com_delete on public.comercializaciones for delete to authenticated
  using (public.ra_es_admin());

drop policy if exists vis_select on public.visitas;
drop policy if exists vis_insert on public.visitas;
drop policy if exists vis_update on public.visitas;
drop policy if exists vis_delete on public.visitas;

-- Ve una visita quien la cargó, el responsable de la propiedad o un administrador
create policy vis_select on public.visitas for select to authenticated
  using (
    public.ra_es_admin()
    or asesor_email = (auth.jwt() ->> 'email')
    or exists (select 1 from public.comercializaciones c
               where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email'))
  );
-- Cada asesor carga las visitas que acompaña
create policy vis_insert on public.visitas for insert to authenticated
  with check (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'));
create policy vis_update on public.visitas for update to authenticated
  using (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'))
  with check (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'));
create policy vis_delete on public.visitas for delete to authenticated
  using (public.ra_es_admin() or asesor_email = (auth.jwt() ->> 'email'));

-- ════════════════════════════════════════════════════════════════════
-- SINCRONIZACIÓN CON TOKKO BROKER (agregado)
-- ════════════════════════════════════════════════════════════════════
alter table public.comercializaciones add column if not exists tokko_id        bigint unique;
alter table public.comercializaciones add column if not exists tokko_ref       text;
alter table public.comercializaciones add column if not exists tokko_url       text;
alter table public.comercializaciones add column if not exists tokko_status    int;
alter table public.comercializaciones add column if not exists datos_tokko     jsonb not null default '{}';
alter table public.comercializaciones add column if not exists sincronizado_at timestamptz;
alter table public.comercializaciones add column if not exists asesor_manual   boolean not null default false;
alter table public.comercializaciones alter column portales set default array['Zonaprop','Argenprop','MercadoLibre','Properati','Meta','Web Real Aires'];

-- Sincronización incremental (agregado)
alter table public.comercializaciones add column if not exists tokko_hash text;
create table if not exists public.sync_estado (
  clave     text primary key,
  ultimo_at timestamptz,
  resumen   jsonb
);
alter table public.sync_estado enable row level security;
drop policy if exists sync_estado_select on public.sync_estado;
create policy sync_estado_select on public.sync_estado for select to authenticated using (true);
