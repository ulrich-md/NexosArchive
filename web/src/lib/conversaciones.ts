/**
 * Conversaciones recientes del sidebar.
 *
 * Dos almacenes con la misma forma:
 *  - Sin sesión: `localStorage` de este navegador, hasta `MAX_LOCALES`
 *    conversaciones, cada una se descarta pasados `DIAS_RETENCION` días.
 *  - Con sesión (Google): la Edge Function `conversaciones`, que las guarda
 *    por usuario y las enseña desde cualquier dispositivo. Al iniciar sesión,
 *    las de este navegador se suben a la cuenta y se borran de aquí.
 *
 * Solo se guardan los turnos ya respondidos (`estado: 'lista'`): uno a medio
 * cargar o con error no tiene sentido restaurarlo tal cual.
 */

import type { Turno } from '@/components/BloqueRespuesta';
import {
  borrarConversacionRemota,
  guardarConversacionRemota,
  importarConversaciones,
  leerConversacion,
  listarConversaciones,
} from '@/lib/api';
import { DIAS_RETENCION } from '@/lib/constantes';

export interface ResumenConversacion {
  id: string;
  titulo: string;
  /** ms desde epoch */
  actualizadaEn: number;
}

export interface Conversacion extends ResumenConversacion {
  turnos: Turno[];
}

const CLAVE = 'archivo-nexos:conversaciones:v2';
/** Versión anterior: una sola conversación por navegador. Se migra al leer. */
const CLAVE_V1 = 'archivo-nexos:conversacion:v1';
const MAX_LOCALES = 20;
const MAX_TURNOS = 100;
const MAX_TITULO = 80;
const RETENCION_MS = DIAS_RETENCION * 24 * 60 * 60 * 1000;

export function nuevoIdConversacion(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function tituloDe(turnos: Turno[]): string {
  const primera = (turnos[0]?.pregunta ?? '').replace(/\s+/g, ' ').trim();
  if (!primera) return 'Conversación';
  return primera.length > MAX_TITULO ? `${primera.slice(0, MAX_TITULO - 1).trimEnd()}…` : primera;
}

export function turnosGuardables(turnos: Turno[]): Turno[] {
  return turnos
    .filter((t) => t.estado === 'lista' && t.respuesta)
    .slice(-MAX_TURNOS)
    .map((t) => ({ ...t, lento: false, paginando: false, error: null }));
}

/**
 * Lo que vuelve de `localStorage` o del servidor se revisa antes de
 * renderizarlo (CLAUDE.md sección 7, regla 5): un turno sin la forma esperada
 * se descarta en vez de dejar la pantalla en blanco.
 */
function turnosValidos(crudo: unknown): Turno[] {
  if (!Array.isArray(crudo)) return [];
  return crudo
    .filter((t): t is Turno => {
      const r = (t as Turno | null)?.respuesta as Record<string, unknown> | null | undefined;
      return (
        !!t &&
        typeof (t as Turno).id === 'string' &&
        typeof (t as Turno).pregunta === 'string' &&
        !!r &&
        typeof r.modo === 'string' &&
        Array.isArray(r.articulos) &&
        Array.isArray(r.traza)
      );
    })
    .map((t) => ({ ...t, estado: 'lista' as const, lento: false, paginando: false, error: null }));
}

function resumen(c: Conversacion): ResumenConversacion {
  return { id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn };
}

// --- Este navegador ----------------------------------------------------------

function leerLocales(): Conversacion[] {
  try {
    const ahora = Date.now();
    const crudo = window.localStorage.getItem(CLAVE);
    const lista: Conversacion[] = crudo ? (JSON.parse(crudo) as Conversacion[]) : [];

    const v1 = window.localStorage.getItem(CLAVE_V1);
    if (v1) {
      window.localStorage.removeItem(CLAVE_V1);
      const viejo = JSON.parse(v1) as { guardadoEn?: number; turnos?: unknown };
      const turnos = turnosValidos(viejo.turnos);
      if (turnos.length > 0 && viejo.guardadoEn) {
        lista.push({ id: `v1-${viejo.guardadoEn}`, titulo: tituloDe(turnos), actualizadaEn: viejo.guardadoEn, turnos });
      }
    }

    return (Array.isArray(lista) ? lista : [])
      .filter((c) => c && typeof c.id === 'string' && ahora - Number(c.actualizadaEn) < RETENCION_MS)
      .map((c) => ({ ...c, turnos: turnosValidos(c.turnos) }))
      .filter((c) => c.turnos.length > 0)
      .sort((a, b) => b.actualizadaEn - a.actualizadaEn);
  } catch {
    // Privado o dato corrupto: se arranca sin conversaciones, nunca se rompe
    // la carga de la app por esto.
    return [];
  }
}

function escribirLocales(lista: Conversacion[]): void {
  let resto = [...lista].sort((a, b) => b.actualizadaEn - a.actualizadaEn).slice(0, MAX_LOCALES);
  while (true) {
    try {
      if (resto.length === 0) window.localStorage.removeItem(CLAVE);
      else window.localStorage.setItem(CLAVE, JSON.stringify(resto));
      return;
    } catch {
      // Cuota agotada: se sueltan las más viejas hasta que quepa. Si ni una
      // cabe, la conversación sigue en memoria para esta pestaña.
      if (resto.length <= 1) return;
      resto = resto.slice(0, -1);
    }
  }
}

/** La más reciente de este navegador, para retomarla al recargar la página. */
export function conversacionLocalReciente(): Conversacion | null {
  return leerLocales()[0] ?? null;
}

export function recientesLocales(): ResumenConversacion[] {
  return leerLocales().map(resumen);
}

// --- Ambos almacenes, según haya sesión ---------------------------------------

export async function listarRecientes(conSesion: boolean): Promise<ResumenConversacion[]> {
  if (!conSesion) return recientesLocales();
  const lista = await listarConversaciones();
  return lista.map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: Date.parse(c.actualizada_en) || 0 }));
}

export async function abrir(conSesion: boolean, id: string): Promise<Conversacion | null> {
  if (!conSesion) return leerLocales().find((c) => c.id === id) ?? null;
  const c = await leerConversacion(id);
  if (!c) return null;
  const turnos = turnosValidos(c.turnos);
  return { id: c.id, titulo: c.titulo, actualizadaEn: Date.parse(c.actualizada_en) || 0, turnos };
}

export async function guardar(conSesion: boolean, c: Conversacion): Promise<void> {
  if (!conSesion) {
    escribirLocales([c, ...leerLocales().filter((x) => x.id !== c.id)]);
    return;
  }
  await guardarConversacionRemota({ id: c.id, titulo: c.titulo, turnos: c.turnos, actualizada_en: c.actualizadaEn });
}

export async function borrar(conSesion: boolean, id: string): Promise<void> {
  if (!conSesion) {
    escribirLocales(leerLocales().filter((c) => c.id !== id));
    return;
  }
  await borrarConversacionRemota(id);
}

/**
 * Al iniciar sesión: las conversaciones de este navegador pasan a la cuenta.
 * Solo se borran de aquí si el servidor las recibió.
 */
export async function subirLocalesALaCuenta(): Promise<void> {
  const locales = leerLocales();
  if (locales.length === 0) return;
  // De a pocas: cada conversación con sus fichas puede pesar cientos de KB.
  for (let i = 0; i < locales.length; i += 4) {
    await importarConversaciones(
      locales
        .slice(i, i + 4)
        .map((c) => ({ id: c.id, titulo: c.titulo, turnos: c.turnos, actualizada_en: c.actualizadaEn })),
    );
  }
  escribirLocales([]);
}
