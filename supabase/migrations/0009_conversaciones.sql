-- Conversaciones de quien inicia sesión con Google.
--
-- Sin sesión, las conversaciones viven en el navegador (localStorage, 7 días).
-- Con sesión, se guardan aquí y se ven desde cualquier dispositivo. La sesión
-- sigue sin ser la llave del archivo (CLAUDE.md sección 6, ACCESO_ANONIMO):
-- solo conserva el historial.
--
-- Mismas reglas que el resto de la base: RLS sin ninguna policy y sin
-- permisos para anon/authenticated. Se lee y se escribe solo por la Edge
-- Function `conversaciones`, que valida el JWT y filtra por el usuario.
--
-- Lo que se guarda es lo que la interfaz ya enseñó: preguntas, el texto de la
-- respuesta y las fichas (título, autor, fecha, liga). Nunca el cuerpo de un
-- artículo.
--
-- Idempotente: se puede correr completa las veces que sea.

create table if not exists conversaciones (
  usuario         uuid not null references auth.users(id) on delete cascade,
  id              text not null check (id ~ '^[A-Za-z0-9._-]{8,64}$'),
  titulo          text not null check (char_length(titulo) between 1 and 200),
  turnos          jsonb not null check (jsonb_typeof(turnos) = 'array'),
  creada_en       timestamptz not null default now(),
  actualizada_en  timestamptz not null default now(),
  -- El id lo genera el navegador: la llave incluye al usuario para que un id
  -- repetido nunca pise la conversación de otra persona.
  primary key (usuario, id)
);

comment on table conversaciones is
  'Historial de conversaciones por usuario con sesión. Solo service role (Edge Function conversaciones).';

alter table conversaciones enable row level security;
revoke all on conversaciones from anon, authenticated;

create index if not exists conversaciones_recientes
  on conversaciones (usuario, actualizada_en desc);

-- Tope de 200 conversaciones por persona: al guardar una nueva, se van las
-- más viejas. Sin esto, una cuenta podría llenar la base sin límite.
create or replace function conversaciones_podar()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  delete from conversaciones
   where usuario = new.usuario
     and id in (
       select id from conversaciones
        where usuario = new.usuario
        order by actualizada_en desc
        offset 200
     );
  return null;
end;
$$;

revoke all on function conversaciones_podar() from public, anon, authenticated;

drop trigger if exists conversaciones_podar on conversaciones;
create trigger conversaciones_podar
  after insert on conversaciones
  for each row execute function conversaciones_podar();
