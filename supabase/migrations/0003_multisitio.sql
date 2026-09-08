-- El archivo de Nexos no vive en un solo WordPress: además de www.nexos.com.mx
-- (19,145 artículos) hay 26 subdominios con su propia instalación y su propia
-- API, que suman 14,479. Total: 33,624. Ver CLAUDE.md sección 2.
--
-- Esta migración hace dos cosas.

-- ---------------------------------------------------------------------------
-- 1. La identidad de un artículo es (sitio, id_wp), no id_wp
-- ---------------------------------------------------------------------------
-- Cada WordPress tiene su propio espacio de ids, así que el id de WordPress ya
-- no identifica un artículo por sí solo. La regla del spec ("nunca generar un
-- id propio") se escribió suponiendo un solo sitio; su intención —no perder el
-- vínculo con WordPress— se conserva porque `id` sigue siendo derivable y
-- reversible: id = base_del_sitio + id_wp, con bases múltiplos de mil millones
-- y los ids de WordPress muy por debajo de ese techo.
--
-- A `www` le toca base 0, así que las 19,145 filas ya cargadas NO cambian de id.

alter table articulos add column if not exists sitio text not null default 'www';
alter table articulos add column if not exists id_wp bigint;

update articulos set id_wp = id where id_wp is null;
alter table articulos alter column id_wp set not null;

create unique index if not exists articulos_sitio_idwp_idx on articulos (sitio, id_wp);
create index if not exists articulos_sitio_idx on articulos (sitio);

-- Deduplicación: los subdominios republican parte de lo que ya está en el sitio
-- principal, en proporción muy desigual (angelesmastretta 10 de 12 repetidos,
-- aguilarcamin y redaccion ninguno). Se deduplica por título normalizado, que
-- es lo único comparable entre instalaciones distintas.
create index if not exists articulos_titulo_idx on articulos (lower(titulo));

-- ---------------------------------------------------------------------------
-- 2. El cuerpo se indexa pero NO se almacena
-- ---------------------------------------------------------------------------
-- El dueño del proyecto quiere que el buscador encuentre un artículo por lo que
-- dice adentro, pero que los artículos no "vivan" en esta base: la app siempre
-- manda a nexos.com.mx. Y si la base se filtrara, lo que se llevarían serían
-- lexemas sueltos, no 56 años de archivo legible.
--
-- `ts` era una columna generada a partir de `cuerpo`, lo que obligaba a
-- almacenarlo. Pasa a ser una columna normal que llena la función de abajo: el
-- texto entra como parámetro, se convierte a tsvector y se descarta.

alter table articulos drop column if exists ts;
alter table articulos add column if not exists ts tsvector;

-- `cuerpo` se queda como estaba en el esquema (fase 2 del spec) pero no se
-- llena: la ingesta manda el texto a indexar_articulo() y nunca lo escribe.
comment on column articulos.cuerpo is
  'NO se llena: el cuerpo se indexa en ts vía indexar_articulo() y no se almacena.';

create index if not exists articulos_ts_idx on articulos using gin (ts);

/**
 * Indexa un artículo. `p_cuerpo` se usa para calcular el tsvector y se descarta:
 * nunca se escribe en ninguna columna.
 */
create or replace function indexar_articulo(p_id bigint, p_cuerpo text default null)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  update articulos
     set ts = to_tsvector('spanish',
                coalesce(titulo, '') || ' ' ||
                coalesce(autores_a_texto(autores), '') || ' ' ||
                coalesce(p_cuerpo, ''))
   where id = p_id;
end;
$$;

/** Versión por lotes: un solo viaje para muchos artículos. */
create or replace function indexar_articulos(p_filas jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  n integer := 0;
begin
  update articulos a
     set ts = to_tsvector('spanish',
                coalesce(a.titulo, '') || ' ' ||
                coalesce(autores_a_texto(a.autores), '') || ' ' ||
                coalesce(f.cuerpo, ''))
    from jsonb_to_recordset(p_filas) as f(id bigint, cuerpo text)
   where a.id = f.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function indexar_articulo(bigint, text) from public, anon, authenticated;
revoke all on function indexar_articulos(jsonb) from public, anon, authenticated;
grant execute on function indexar_articulo(bigint, text) to service_role;
grant execute on function indexar_articulos(jsonb) to service_role;

-- Deja indexado lo que ya está cargado (sin cuerpo: solo título y autores).
update articulos
   set ts = to_tsvector('spanish',
              coalesce(titulo, '') || ' ' || coalesce(autores_a_texto(autores), ''))
 where ts is null;
