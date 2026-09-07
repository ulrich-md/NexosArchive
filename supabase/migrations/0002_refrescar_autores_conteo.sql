-- La vista materializada `autores_conteo` no se refresca sola: se queda con la
-- foto del momento en que se creó. Si la ingesta corre después, el sidebar
-- carga vacío para siempre — exactamente el bug que CLAUDE.md sección 0 le
-- reprocha a la versión de Lovable ("esqueletos permanentes").
--
-- PostgREST no puede ejecutar REFRESH MATERIALIZED VIEW, así que se expone
-- como función para que la ingesta la llame al terminar.

create or replace function refrescar_autores_conteo()
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  refresh materialized view autores_conteo;
end;
$$;

-- Solo el service role puede refrescarla. Ni anon ni authenticated deben
-- siquiera poder invocarla: la vista lista a todos los autores del archivo.
revoke all on function refrescar_autores_conteo() from public, anon, authenticated;
grant execute on function refrescar_autores_conteo() to service_role;

-- Primer refresco, para dejarla poblada con lo que ya se cargó.
refresh materialized view autores_conteo;
