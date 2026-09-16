-- Decisión del dueño del proyecto (2026-09-16): el archivo es de lectura
-- libre sin sesión para los TRES carriles, no solo `catalogo`. Solo lo
-- conocerán los administradores de Nexos, así que la sesión deja de ser una
-- puerta de acceso y pasa a servir solo para conservar el historial de
-- conversaciones entre visitas. Ver CLAUDE.md sección 6.
--
-- Como ahora los anónimos SÍ pueden llegar a `panorama` e `hibrida` (los
-- carriles que llaman a un LLM), el límite de 30 consultas/hora necesita algo
-- que identifique a quien no tiene sesión. `consultas.usuario` es una FK a
-- `auth.users` y no puede guardar una IP, así que se agrega una columna
-- aparte en vez de forzar el dato en una columna que significa otra cosa.

alter table consultas add column if not exists ip text;

-- Acelera el conteo del límite de tasa: por usuario (con sesión) o por ip
-- (sin sesión), siempre acotado a la última hora.
create index if not exists consultas_usuario_creada_idx on consultas (usuario, creada_en desc);
create index if not exists consultas_ip_creada_idx on consultas (ip, creada_en desc);
