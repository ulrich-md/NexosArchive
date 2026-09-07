// Capa HTTP: CORS y serialización de respuestas.

import { ORIGENES_PERMITIDOS } from './config.ts';
import type { Aviso, PasoTraza, RespuestaError, RespuestaOk } from './tipos.ts';
import { VERSION_CONTRATO } from './tipos.ts';
import type { ErrorBuscar } from './errores.ts';

export function encabezadosCors(req: Request): Record<string, string> {
  const origen = req.headers.get('origin') ?? '';
  const permitido = ORIGENES_PERMITIDOS.includes('*')
    ? (origen || '*')
    : (ORIGENES_PERMITIDOS.includes(origen) ? origen : ORIGENES_PERMITIDOS[0] ?? '');

  return {
    'access-control-allow-origin': permitido,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

export function respuestaJson(
  cuerpo: RespuestaOk | RespuestaError,
  estado: number,
  req: Request,
): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: {
      ...encabezadosCors(req),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function respuestaError(
  e: ErrorBuscar,
  req: Request,
  traza: PasoTraza[],
  avisos: Aviso[],
  ms: number,
): Response {
  const cuerpo: RespuestaError = {
    ok: false,
    version: VERSION_CONTRATO,
    error: e.serializar(),
    avisos,
    traza,
    ms: Math.round(ms),
  };
  return respuestaJson(cuerpo, e.estado, req);
}
