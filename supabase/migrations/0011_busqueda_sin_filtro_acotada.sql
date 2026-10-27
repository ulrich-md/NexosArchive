-- La búsqueda sin autor ni años ya no se pasa del tiempo (corrige la 0008).
--
-- Medido en producción (2026-10-27): "artículos sobre comida" respondía
-- BD_ERROR "canceling statement due to statement timeout". Sin filtros, la
-- 0008 ordenaba TODAS las coincidencias por `ts || ts_meta`, y para eso
-- descomprimía el cuerpo completo de cada una. Con el tema ampliado (cocina,
-- gastronomía, mole…) y el choque del stemmer ("comida" → 'com' = "cómo"),
-- eran miles de cuerpos: más de los ~8 s que PostgREST le da a una sentencia.
--
-- Ahora el orden sale de `ts_meta` (título, resumen y temas: chico, y es
-- donde el enriquecimiento dejó de qué trata cada texto) y del cuerpo solo se
-- toman unos cuantos candidatos para completar. El vector sigue filtrando y
-- ordenando igual. La rama CON filtro (autor, años) no cambia: su subconjunto
-- es chico.
--
-- Idempotente: solo reemplaza la función.

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
    select a.id, v.embedding, coalesce(a.ts, ''::tsvector) || coalesce(m.ts_meta, ''::tsvector) as ts
      from articulos a
      left join articulos_vectores v on v.id = a.id
      left join articulos_ts_meta m on m.id = a.id
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
        (select b.id, ts_rank_cd(b.ts, v_q) as rk,
                case when p_embedding is not null then (b.embedding <=> p_embedding)::real end as d
           from base b
          where v_filtrado and v_q is not null and b.ts @@ v_q
          order by ts_rank_cd(b.ts, v_q) desc
          limit v_k)
        union all
        -- Sin filtro: candidatos ACOTADOS de cada índice antes de calcular
        -- nada caro. Se ordena por título + resumen + temas (`ts_meta`, chico)
        -- y del cuerpo solo se toma un puñado para completar, sin ordenarlo:
        -- ordenar por `ts || ts_meta` obligaba a descomprimir el cuerpo de
        -- CADA coincidencia, y "comida" coincide con miles ('com' = "cómo").
        (select c.id, c.rk,
                case when p_embedding is not null then
                  (select (vv.embedding <=> p_embedding)::real from articulos_vectores vv where vv.id = c.id)
                end as d
           from (
             select u.id, max(u.rk) as rk
               from (
                 (select y.id, ts_rank_cd(y.ts_meta, v_q) as rk
                    from articulos_ts_meta y
                   where not v_filtrado and v_q is not null and y.ts_meta @@ v_q
                   order by 2 desc
                   limit v_k * 4)
                 union all
                 (select x.id, 0::real as rk
                    from articulos x
                   where not v_filtrado and v_q is not null and x.ts @@ v_q
                   limit v_k)
               ) u
              group by u.id
           ) c
          order by c.rk desc, c.id desc
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
