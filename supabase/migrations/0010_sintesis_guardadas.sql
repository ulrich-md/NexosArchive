-- Panoramas ya redactados, para no pagar dos veces el mismo.
--
-- Una lista de catálogo ("Todo lo que publicó Ángeles Mastretta") abre con un
-- panorama que redacta el modelo: de qué escribe, cómo cambia con los años,
-- qué textos la representan. La misma lista se pide muchas veces (las
-- pestañas del sidebar la lanzan con un clic) y su obra cambia poco: se
-- guarda la redacción por los filtros que la produjeron y se reutiliza 30
-- días. Así un clic repetido cuesta cero créditos y responde en milisegundos.
--
-- Solo service role, como todo lo demás (CLAUDE.md sección 6). El texto cita
-- con [id:N]: no trae títulos ni autores escritos por el modelo.
--
-- Idempotente.

create table if not exists sintesis_guardadas (
  clave         text primary key,
  texto         text not null,
  articulo_ids  bigint[] not null default '{}',
  modelo        text not null,
  creada_en     timestamptz not null default now()
);

alter table sintesis_guardadas enable row level security;
revoke all on sintesis_guardadas from anon, authenticated;
