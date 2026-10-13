// Lo que no es una búsqueda: saludos, agradecimientos y "¿qué puedes hacer?".
//
// Antes todo pasaba por el router: "hola" se buscaba como tema y devolvía
// artículos con "hola" en el título, y "¿qué puedes hacer?" devolvía
// artículos aproximados. Aquí se contesta como lo haría una persona, sin
// tocar el modelo. La única cifra que se dice (cuántos textos hay) sale de la
// base, nunca de una constante.

import { ANIO_MIN } from './config.ts';
import { bd } from './bd.ts';
import type { Charla } from './texto.ts';

let cacheTotal: { cargado_en: number; total: number } | null = null;

async function totalArchivo(): Promise<number | null> {
  if (cacheTotal && Date.now() - cacheTotal.cargado_en < 10 * 60 * 1000) return cacheTotal.total;
  const { count, error } = await bd().from('articulos').select('id', { count: 'exact', head: true });
  if (error || count == null) return null; // es cortesía: sin la cifra, se dice sin ella
  cacheTotal = { cargado_en: Date.now(), total: count };
  return count;
}

const EJEMPLOS = [
  'por un autor: «todo lo de Carlos Monsiváis en los ochenta»',
  'por un tema: «¿qué se ha escrito sobre el 68?»',
  'o las dos cosas: «¿qué ha escrito Ángeles Mastretta sobre comida?»',
];

export async function responderCharla(tipo: Charla): Promise<string> {
  if (tipo === 'gracias') {
    return 'Con gusto. Si quieres seguir, puedo acotar lo anterior por año, por autor o por tema: ' +
      'basta con escribir, por ejemplo, «¿y en los noventa?».';
  }

  if (tipo === 'saludo') {
    return '¡Hola! ¿Qué quieres buscar en el archivo de Nexos? Puedes preguntarme ' +
      `${EJEMPLOS.join(', ')}.`;
  }

  const total = await totalArchivo();
  const cifra = total ? `${total.toLocaleString('es-MX')} textos` : 'los textos';
  return [
    `Busco en el archivo de Nexos: ${cifra} publicados desde ${ANIO_MIN} en la revista y sus blogs.`,
    `Puedes preguntarme ${EJEMPLOS.join(', ')}. También puedes seguir el hilo: «¿y en 2010?», ` +
    '«de esos, ¿cuáles hablan de economía?».',
    'Solo respondo con lo que existe en el archivo: cada texto que menciono lleva a su página en ' +
    'nexos.com.mx, y arriba de cada respuesta puedes abrir los pasos que seguí para encontrarlo.',
  ].join('\n\n');
}
