/**
 * Conversación guardada por sesión de navegador — sin necesidad de iniciar
 * sesión. Vive solo en `localStorage` de este navegador y se descarta pasados
 * `DIAS_RETENCION` días (la misma cifra que antes solo se explicaba en texto
 * cuando el guardado dependía de iniciar sesión con Google).
 *
 * Solo se guardan los turnos ya respondidos (`estado: 'lista'`): uno a medio
 * cargar o con error no tiene sentido restaurarlo tal cual.
 */

import type { Turno } from '@/components/BloqueRespuesta';
import { DIAS_RETENCION } from '@/lib/constantes';

const CLAVE = 'archivo-nexos:conversacion:v1';

interface Guardado {
  guardadoEn: number;
  turnos: Turno[];
}

export function cargarConversacionGuardada(): Turno[] {
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const datos = JSON.parse(crudo) as Guardado;
    const limiteMs = DIAS_RETENCION * 24 * 60 * 60 * 1000;
    if (!datos.guardadoEn || Date.now() - datos.guardadoEn > limiteMs) {
      window.localStorage.removeItem(CLAVE);
      return [];
    }
    return Array.isArray(datos.turnos) ? datos.turnos : [];
  } catch {
    // Privado, cuota agotada o dato corrupto: se arranca sin conversación,
    // nunca se rompe la carga de la app por esto.
    return [];
  }
}

export function guardarConversacion(turnos: Turno[]): void {
  try {
    const respondidos = turnos.filter((t) => t.estado === 'lista' && t.respuesta);
    if (respondidos.length === 0) {
      window.localStorage.removeItem(CLAVE);
      return;
    }
    const datos: Guardado = { guardadoEn: Date.now(), turnos: respondidos };
    window.localStorage.setItem(CLAVE, JSON.stringify(datos));
  } catch {
    // Cortesía, no crítico: si no se pudo guardar, la conversación sigue
    // funcionando en memoria para esta pestaña.
  }
}

export function borrarConversacionGuardada(): void {
  try {
    window.localStorage.removeItem(CLAVE);
  } catch {
    // Nada que hacer si localStorage no está disponible.
  }
}
