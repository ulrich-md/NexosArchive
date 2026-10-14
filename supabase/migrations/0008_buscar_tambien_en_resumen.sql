-- La búsqueda por palabras también lee el resumen y los temas.
--
-- Medido en producción (2026-10-14): "Artículos de 1988 sobre fraude
-- electoral" solo podía encontrar por TÍTULO. `ts` indexa título + autores +
-- cuerpo, y el archivo impreso de www no tiene cuerpo (paywall): para 1978–
-- 2005 el texto buscable era el título y nada más. Mientras tanto
-- `resumen_linea` y `temas` —lo que el enriquecimiento escribió leyendo cada
-- artículo— no entraban a ninguna búsqueda por palabras.
--
-- `ts` no se toca: lleva el cuerpo de los subdominios, que no se guarda en
-- ninguna parte (0003) y no se podría reconstruir. Va una columna aparte,
-- generada de lo que sí está guardado, y la búsqueda mira las dos.
--
-- Idempotente.

alter table articulos add column if not exists ts_meta tsvector
  generated always as (
    setweight(to_tsvector('spanish', coalesce(titulo, '')), 'A') ||
    setweight(to_tsvector('spanish', coalesce(resumen_linea, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(autores_a_texto(temas), '')), 'B')
  ) stored;

create index if not exists articulos_ts_meta_idx on articulos using gin (ts_meta);

-- Misma firma y misma lógica que la 0007; solo cambia el texto que se busca:
-- `ts` (título, autores, cuerpo) o `ts_meta` (título, resumen, temas).
create or replace function buscar_articulos_hibrido(
  p_texto           text     default null,
  p_embedding       extensions.halfvec default null,
  p_autores         text[]   default null,
  p_anio_desde      integer  default null,
  p_anio_hasta      integer  default null,
  p_anios_referidos smallint[] default null,
  p_limite          integer  default 40,
  p_distancia_max   real     default 0.5
)
  returns table (
    id           bigint,
    puntaje      double precision,
    rango_vector integer,
    rango_texto  integer,
    distancia    real
  )
  language plpgsql
  stable
  security definer
  set search_path = public, extensions
as $$
declare
  v_q        tsquery;
  v_t        tsquery;
  v_pal      text;
  v_filtrado boolean;
  v_k        integer := greatest(p_limite, 1) * 3;
begin
  if p_texto is not null and btrim(p_texto) <> '' then
    foreach v_pal in array regexp_split_to_array(btrim(p_texto), '\s+') loop
      v_t := plainto_tsquery('spanish', v_pal);
      if numnode(v_t) > 0 then
        v_q := case when v_q is null then v_t else v_q || v_t end;
      end if;
    end loop;
  end if;

  v_filtrado := coalesce(cardinality(p_autores), 0) > 0
             or p_anio_desde is not null
             or p_anio_hasta is not null
             or coalesce(cardinality(p_anios_referidos), 0) > 0;

  perform set_config('hnsw.ef_search', greatest(v_k, 40)::text, true);

  return query
  with
  base as materialized (
    select a.id, v.embedding, a.ts, a.ts_meta
      from articulos a
      left join articulos_vectores v on v.id = a.id
     where v_filtrado
       and (coalesce(cardinality(p_autores), 0) = 0 or a.autores && p_autores)
       and (p_anio_desde is null or a.anio_pub >= p_anio_desde)
       and (p_anio_hasta is null or a.anio_pub <= p_anio_hasta)
       and (coalesce(cardinality(p_anios_referidos), 0) = 0
            or a.anios_referidos && p_anios_referidos)
  ),
  vec as (
    select x.id, x.d,
           row_number() over (order by x.d)::integer as r
      from (
        -- Con filtro: exacto sobre el subconjunto.
        (select b.id, (b.embedding <=> p_embedding)::real as d
           from base b
          where v_filtrado and p_embedding is not null and b.embedding is not null
          order by b.embedding <=> p_embedding
          limit v_k)
        union all
        -- Sin filtro: índice HNSW de articulos_vectores.
        (select vv.id, (vv.embedding <=> p_embedding)::real as d
           from articulos_vectores vv
          where not v_filtrado and p_embedding is not null
          order by vv.embedding <=> p_embedding
          limit v_k)
      ) x
  ),
  txt as (
    select y.id, y.d,
           row_number() over (order by y.rk desc, y.id desc)::integer as r
      from (
        (select b.id, ts_rank_cd(coalesce(b.ts, ''::tsvector) || b.ts_meta, v_q) as rk,
                case when p_embedding is not null then (b.embedding <=> p_embedding)::real end as d
           from base b
          where v_filtrado and v_q is not null and (b.ts @@ v_q or b.ts_meta @@ v_q)
          order by 2 desc
          limit v_k)
        union all
        (select a.id, ts_rank_cd(coalesce(a.ts, ''::tsvector) || a.ts_meta, v_q) as rk,
                case when p_embedding is not null then
                  (select (vv.embedding <=> p_embedding)::real from articulos_vectores vv where vv.id = a.id)
                end as d
           from articulos a
          where not v_filtrado and v_q is not null and (a.ts @@ v_q or a.ts_meta @@ v_q)
          order by 2 desc
          limit v_k)
      ) y
  ),
  fusion as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) as puntaje,
           v.r as rango_vector,
           t.r as rango_texto,
           coalesce(v.d, t.d) as distancia
      from vec v
      full outer join txt t on t.id = v.id
  )
  select f.id, f.puntaje::double precision, f.rango_vector, f.rango_texto, f.distancia
    from fusion f
   where f.distancia is null  -- sin vector de la pregunta, o artículo aún sin vector
      or f.distancia <= case when f.rango_texto is not null then p_distancia_max * 1.3
                             else p_distancia_max end
   order by f.puntaje desc, f.id desc
   limit p_limite;
end;
$$;

revoke all on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  from public, anon, authenticated;
grant execute on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  to service_role;
