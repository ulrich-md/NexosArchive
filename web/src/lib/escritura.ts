import { useEffect, useRef, useState } from 'react';

/**
 * Efecto de máquina de escribir para el texto de las respuestas.
 *
 * El texto llega a ráfagas (pedazos del modelo, o de golpe cuando la
 * respuesta no se transmitió), pero se enseña letra por letra a un ritmo
 * parejo que se acelera solo si se acumula mucho pendiente: así nunca se
 * queda muy atrás de lo que ya llegó, ni suelta un párrafo entero de jalón.
 *
 * Continuidad entre la vista previa y la respuesta final: son dos
 * componentes distintos (CargandoRespuesta y BloqueRespuesta), así que lo
 * escrito hasta ahora se recuerda aquí por turno. La final retoma desde ahí
 * en vez de volver a empezar.
 *
 * Solo se anima lo que se pidió en esta visita: una conversación reabierta
 * del historial nunca pasó por la vista previa y se pinta completa.
 */

/** Lo que cada turno lleva escrito en pantalla. */
const escritos = new Map<string, string>();

/** Letras por segundo: mínimo para que se lea como escritura, máximo para
 *  no hacer esperar de más en una respuesta larga que llegó de golpe. */
const VELOCIDAD_MIN = 70;
const VELOCIDAD_MAX = 450;
/** Segundos en que se quiere alcanzar lo pendiente. */
const ALCANCE_S = 2.5;

/**
 * Marca un turno como "se está pidiendo ahora": su respuesta se escribirá
 * aunque llegue de golpe, sin vista previa (catálogo, saludos).
 */
export function empezarEscritura(clave: string): void {
  escritos.set(clave, '');
}

function movimientoReducido(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function prefijoComun(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Ajusta el corte para no partir una marca `[id:N]`: si ya llegó completa se
 * enseña entera (se vuelve el título de golpe, con su liga); si todavía no
 * cierra, el corte se queda antes del corchete.
 */
export function cortarSinPartirMarcas(texto: string, n: number): string {
  const abre = texto.lastIndexOf('[', n - 1);
  if (abre === -1) return texto.slice(0, n);
  const cierra = texto.indexOf(']', abre);
  if (cierra !== -1 && cierra < n) return texto.slice(0, n);
  const marca = /^\[id:\d+\]/.exec(texto.slice(abre));
  if (marca) return texto.slice(0, abre + marca[0].length);
  // Una marca a medio llegar ("[id:12") o un corchete suelto al final: se
  // espera al siguiente pedazo.
  return /^\[(?:i(?:d(?::\d*)?)?)?$/.test(texto.slice(abre)) ? texto.slice(0, abre) : texto.slice(0, n);
}

/**
 * @param clave   id del turno.
 * @param enVivo  true en la vista previa: siempre anima y empieza de cero.
 *                false en la respuesta final: anima solo si ese turno venía
 *                escribiéndose en esta visita.
 * @param completo  ya no llegará más texto.
 */
export function useEscritura(
  texto: string,
  clave: string,
  { enVivo, completo }: { enVivo: boolean; completo: boolean },
): { visible: string; escribiendo: boolean } {
  const [n, setN] = useState(() => {
    if (movimientoReducido()) return Number.POSITIVE_INFINITY;
    if (enVivo) {
      escritos.set(clave, '');
      return 0;
    }
    const previo = escritos.get(clave);
    return previo === undefined ? Number.POSITIVE_INFINITY : prefijoComun(previo, texto);
  });
  const posicion = useRef(n);

  useEffect(() => {
    if (posicion.current >= texto.length) return;
    let cuadro = 0;
    let antes = performance.now();
    const avanzar = (ahora: number) => {
      const dt = Math.min(0.1, (ahora - antes) / 1000);
      antes = ahora;
      const pendiente = texto.length - posicion.current;
      const velocidad = Math.min(VELOCIDAD_MAX, Math.max(VELOCIDAD_MIN, pendiente / ALCANCE_S));
      posicion.current = Math.min(texto.length, posicion.current + velocidad * dt);
      setN(Math.floor(posicion.current));
      if (posicion.current < texto.length) cuadro = requestAnimationFrame(avanzar);
    };
    cuadro = requestAnimationFrame(avanzar);
    return () => cancelAnimationFrame(cuadro);
  }, [texto]);

  const visible =
    completo && n >= texto.length ? texto : cortarSinPartirMarcas(texto, Math.min(n, texto.length));
  const termino = completo && visible.length >= texto.length;

  useEffect(() => {
    if (termino) escritos.delete(clave);
    else escritos.set(clave, visible);
  }, [clave, visible, termino]);

  return { visible, escribiendo: !termino };
}
