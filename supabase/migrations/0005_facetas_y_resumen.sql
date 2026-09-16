-- Dos cosas que le faltaban al frontend, encontradas al diagnosticar por qué
-- el sidebar nunca cargaba: la Edge Function `facetas` (sección 3, mejora 2)
-- necesita secciones y décadas, no solo autores, y nunca se habían creado.

-- === Secciones y décadas, mismo patrón que autores_conteo (0001) ===========

create materialized view secciones_conteo as
  select seccion, count(*) as n
  from articulos
  where seccion is not null and seccion <> ''
  group by 1 order by n desc;

create unique index on secciones_conteo (seccion);
revoke all on secciones_conteo from anon, authenticated;

create materialized view decadas_conteo as
  select ((anio_pub / 10) * 10)::text || 's' as decada, count(*) as n
  from articulos
  group by 1 order by 1;

create unique index on decadas_conteo (decada);
revoke all on decadas_conteo from anon, authenticated;

-- Refresca las tres facetas en un solo viaje. `refrescar_autores_conteo()`
-- (0002) se queda tal cual: los scripts de ingesta ya la llaman y no hay
-- razón para romper esa firma. Esta es la que se usa de ahora en adelante.
create or replace function refrescar_facetas()
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  refresh materialized view autores_conteo;
  refresh materialized view secciones_conteo;
  refresh materialized view decadas_conteo;
end;
$$;

revoke all on function refrescar_facetas() from public, anon, authenticated;
grant execute on function refrescar_facetas() to service_role;

refresh materialized view secciones_conteo;
refresh materialized view decadas_conteo;

-- No hay tabla de "resumen del archivo cacheado": el resumen varía con cada
-- pregunta (da información sobre ESA consulta: cuántos artículos, qué años),
-- así que cachear un texto fijo no aplica. Panorama ya lo redacta con el LLM
-- (`sintesis`); catálogo lo arma sin LLM, calculado de sus propios resultados,
-- para no romper la regla de responder en <100 ms (CLAUDE.md sección 4).
