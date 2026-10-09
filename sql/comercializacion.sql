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

-- Autorización de venta e informes al propietario (agregado)
alter table public.comercializaciones add column if not exists autorizacion_inicio date;
alter table public.comercializaciones add column if not exists autorizacion_dias   int not null default 120;
alter table public.comercializaciones add column if not exists informes_enviados   jsonb not null default '[]';
alter table public.comercializaciones add column if not exists informes_avisados   int[] not null default '{}';
alter table public.reportes_operacion  add column if not exists comercializacion_id uuid;

-- ════════════════════════════════════════════════════════════════════
-- INFORMES AL PROPIETARIO (agregado)
-- ════════════════════════════════════════════════════════════════════
alter table public.comercializaciones add column if not exists propietario_email text;

create table if not exists public.informes_propietario (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  comercializacion_id uuid not null references public.comercializaciones(id) on delete cascade,
  hito                int,
  estado              text not null default 'Borrador',  -- Borrador | Descargado | Enviado
  datos               jsonb not null default '{}',
  creado_por          text default (auth.jwt() ->> 'email'),
  descargado_at       timestamptz,
  enviado_at          timestamptz,
  enviado_a           text
);
create index if not exists informes_prop_com_idx on public.informes_propietario (comercializacion_id, created_at desc);

alter table public.informes_propietario enable row level security;
drop policy if exists inf_prop_all on public.informes_propietario;
-- El asesor responsable de la propiedad y los administradores
create policy inf_prop_all on public.informes_propietario for all to authenticated
  using (public.ra_es_admin() or exists (select 1 from public.comercializaciones c
         where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email')))
  with check (public.ra_es_admin() or exists (select 1 from public.comercializaciones c
         where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email')));

-- ════════════════════════════════════════════════════════════════════
-- CRUCE PROPIEDADES PROPIAS ↔ BÚSQUEDAS ACTIVAS (agregado)
-- Para cada propiedad en comercialización devuelve las búsquedas activas
-- que encajan. De búsquedas de otros asesores solo informa el asesor.
-- ════════════════════════════════════════════════════════════════════
create or replace function public.ra_cruce_comercializaciones(p_ids uuid[])
returns table (comercializacion_id uuid, busqueda_id uuid, asesor text, es_propia boolean, cliente text)
language sql stable security definer
set search_path = public
as $$
  select c.id,
         case when mine then b.id end,
         b.asesor,
         mine,
         case when mine then b.cliente_nombre end
  from comercializaciones c
  cross join lateral (select
      nullif(c.datos_tokko ->> 'tipo', '')                      as tipo,
      nullif(c.datos_tokko ->> 'ambientes', '')::numeric::int   as amb,
      nullif(c.datos_tokko ->> 'dormitorios', '')::numeric::int as dorm,
      coalesce(nullif(c.datos_tokko ->> 'sup_cubierta', '')::numeric, nullif(c.datos_tokko ->> 'sup_total', '')::numeric) as sup
    ) p
  join busquedas b on b.estado = 'Activa'
  cross join lateral (select (b.asesor_email = (auth.jwt() ->> 'email') or ra_es_admin()) as mine) m
  where c.id = any (p_ids)
    and auth.uid() is not null
    and c.estado = 'Activa'
    and b.operacion = c.operacion
    and (cardinality(b.tipos) = 0 or p.tipo is null or p.tipo = any (b.tipos))
    and (cardinality(b.barrios) = 0 or c.barrio is null or exists (
          select 1 from unnest(b.barrios) z
          where ra_norm(c.barrio) like '%' || ra_norm(z) || '%'
             or ra_norm(z) like '%' || ra_norm(c.barrio) || '%'
             or ra_norm(z) = any (select trim(ra_norm(x)) from unnest(string_to_array(coalesce(c.datos_tokko ->> 'ubicacion', ''), '|')) x)))
    and (p.amb is null or b.amb_min is null or p.amb >= b.amb_min)
    and (p.amb is null or b.amb_max is null or p.amb <= b.amb_max)
    and (p.dorm is null or b.dorm_min is null or p.dorm >= b.dorm_min)
    and (b.sup_min is null or p.sup is null or p.sup >= b.sup_min)
    and (c.precio is null or c.moneda is distinct from b.moneda or (
          (b.precio_max is null or c.precio <= b.precio_max * 1.10) and
          (b.precio_min is null or c.precio >= b.precio_min * 0.90)))
$$;

revoke all on function public.ra_cruce_comercializaciones(uuid[]) from public, anon;
grant execute on function public.ra_cruce_comercializaciones(uuid[]) to authenticated;

-- ════════════════════════════════════════════════════════════════════
-- CONSULTAS DE INTERESADOS (avisos de Tokko leídos desde Gmail) (agregado)
-- ════════════════════════════════════════════════════════════════════
create table if not exists public.consultas (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  recibida_at         timestamptz not null,
  tokko_webcontact_id bigint,
  tokko_id            bigint,
  tokko_ref           text,
  comercializacion_id uuid references public.comercializaciones(id) on delete set null,
  propiedad_texto     text,
  portal              text,
  etiquetas           text[] not null default '{}',
  interesado          text,
  interesado_email    text,
  interesado_tel      text,
  mensaje             text,
  aviso_url           text,
  estado              text not null default 'Nueva',   -- Nueva | Contactada | Visita agendada | Descartada
  contactada_at       timestamptz,
  visita_id           uuid,
  gmail_id            text,
  unique (tokko_webcontact_id, tokko_id)
);
create index if not exists consultas_com_idx on public.consultas (comercializacion_id, recibida_at desc);
create index if not exists consultas_estado_idx on public.consultas (estado, recibida_at desc);

alter table public.consultas enable row level security;
drop policy if exists consultas_select on public.consultas;
drop policy if exists consultas_update on public.consultas;
-- Ven y gestionan la consulta el asesor responsable de la propiedad y los administradores.
-- El alta la hace solo la función ingresar-consulta (clave de servicio).
create policy consultas_select on public.consultas for select to authenticated
  using (public.ra_es_admin() or exists (select 1 from public.comercializaciones c
         where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email')));
create policy consultas_update on public.consultas for update to authenticated
  using (public.ra_es_admin() or exists (select 1 from public.comercializaciones c
         where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email')))
  with check (public.ra_es_admin() or exists (select 1 from public.comercializaciones c
         where c.id = comercializacion_id and c.asesor_email = (auth.jwt() ->> 'email')));

-- Conteo de consultas por propiedad visible para todo el equipo (sin datos personales)
create or replace function public.ra_consultas_resumen()
returns table (comercializacion_id uuid, total bigint, nuevas bigint, ultima timestamptz)
language sql stable security definer
set search_path = public
as $$
  select comercializacion_id, count(*), count(*) filter (where estado = 'Nueva'), max(recibida_at)
  from consultas where comercializacion_id is not null and auth.uid() is not null
  group by comercializacion_id
$$;
revoke all on function public.ra_consultas_resumen() from public, anon;
grant execute on function public.ra_consultas_resumen() to authenticated;

-- Vincular consultas que llegaron antes de que la propiedad se sincronizara
create or replace function public.ra_vincular_consultas()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tokko_id is not null then
    update consultas set comercializacion_id = new.id
    where comercializacion_id is null and tokko_id = new.tokko_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_vincular_consultas on public.comercializaciones;
create trigger trg_vincular_consultas after insert or update of tokko_id on public.comercializaciones
  for each row execute function public.ra_vincular_consultas();
