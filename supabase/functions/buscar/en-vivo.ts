// Transmisión en vivo de una respuesta mientras se redacta.
//
// El frontend pide `?en_vivo=1` y recibe Server-Sent Events: pedazos del
// texto conforme Haiku lo escribe y, al final, la misma respuesta JSON de
// siempre, completa y validada. El texto en vivo es solo vista previa: lo que
// queda en pantalla es el `final`.
//
// El emisor vive en un AsyncLocalStorage para no tener que pasarlo por el
// router y los tres carriles: `redactar()` lo busca y, si no hay (petición
// normal), no emite nada.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Ficha } from './tipos.ts';

export type EventoVivo =
  /** Pedazo nuevo del texto de la respuesta (con marcas [id:N]). */
  | { t: 'texto'; d: string }
  /** Ficha de una marca [id:N] que acaba de aparecer, para pintar la liga. */
  | { t: 'ficha'; f: Ficha }
  /** Lo transmitido se descarta: el modelo falló y se reintenta con otro. */
  | { t: 'reinicio' }
  /** La respuesta completa, igual a la de una petición normal. */
  | { t: 'final'; estado: number; cuerpo: unknown };

const almacen = new AsyncLocalStorage<(e: EventoVivo) => void>();

export function emitir(e: EventoVivo): void {
  almacen.getStore()?.(e);
}

export function hayEmisor(): boolean {
  return almacen.getStore() !== undefined;
}

/**
 * Corre `producir` con un emisor activo y devuelve un Response SSE que manda
 * cada evento conforme ocurre y, al final, el cuerpo de la respuesta normal.
 */
export function responderEnVivo(
  producir: () => Promise<Response>,
  encabezados: Record<string, string>,
): Response {
  const codificador = new TextEncoder();
  const cuerpo = new ReadableStream<Uint8Array>({
    start(control) {
      let cerrado = false;
      const enviar = (e: EventoVivo) => {
        if (cerrado) return;
        try {
          control.enqueue(codificador.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          cerrado = true; // el navegador se fue: se deja de escribir
        }
      };
      almacen.run(enviar, async () => {
        try {
          const r = await producir();
          enviar({ t: 'final', estado: r.status, cuerpo: await r.json() });
        } catch (e) {
          enviar({
            t: 'final',
            estado: 500,
            cuerpo: { ok: false, error: { codigo: 'ERROR_INTERNO', mensaje: 'Falló la consulta.', detalle: String(e) } },
          });
        } finally {
          cerrado = true;
          try {
            control.close();
          } catch {
            // ya estaba cerrado
          }
        }
      });
    },
  });
  return new Response(cuerpo, {
    status: 200,
    headers: {
      ...encabezados,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
