// npm run firmas-sitio — encuentra la cuenta del propio blog en cada subdominio.
//
// El tema de algunos subdominios cuelga la cuenta institucional del blog junto
// al autor real: en cultura, "Sofia Marquez and Cultura Nexos"; en
// eljuegodelacorte, "Saúl López Noriega y Juego de La Nueva Suprema Corte".
// Guardar esas cuentas como autores inventaría personas con miles de artículos
// en el índice del sidebar, que es justo lo que prohíbe CLAUDE.md §7.
//
// No se escriben a mano: se deducen de una muestra, con dos reglas, y basta con
// que se cumpla una.
//
//  a) El slug es el del propio sitio (`cultura` en cultura.nexos.com.mx,
//     `educacion` en educacion.nexos.com.mx).
//  b) Su nombre es el nombre del blog, el que declara el propio WordPress en
//     `/wp-json/`: "Distancia por tiempos", "Caminos sin ley", "Juego de La
//     Nueva Suprema Corte".
//
// La frecuencia NO sirve para esto, aunque lo parezca: medido, `justicia` firma
// 7 de 30 en eljuegodelacorte y `cultura` 16 de 30 en cultura, así que un
// umbral de presencia los dejaría pasar. Y subirlo al revés sería peor: en
// salud, Octavio Gómez Dantés firma todo, y una regla por frecuencia borraría
// al único autor de un blog de autor.
//
// Las dos reglas solo se aplican donde la firma viene enlazada; en los blogs de
// texto plano no hay slug que juzgar y el archivo sale vacío para ese sitio.
//
// El resultado se cachea en datos/firmas-institucionales.json para poder
// revisarlo a ojo: es una decisión sobre quién es persona y quién no, y merece
// quedar por escrito en algún lado que un editor pueda abrir.
import './lib/red.js';
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { clienteSupabase } from './lib/supabase.js';
import { SUBDOMINIOS, type Sitio } from './lib/sitios.js';
import { anclasDeFirma } from './lib/firma.js';
import { sleep } from './lib/wp.js';

const MUESTRA = 30;
const DELAY_MS = 250;
const RUTA = 'datos/firmas-institucionales.json';

/** Compara nombres sin acentos, sin mayúsculas, sin puntuación y sin artículo inicial. */
function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^(el|la|los|las)/, '');
}

/** El nombre que el propio WordPress se da en /wp-json/. */
async function nombreDelSitio(sitio: Sitio): Promise<string> {
  const url = `https://${sitio.clave}.nexos.com.mx/wp-json/`;
  const d = await fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : null))
    .catch(() => null);
  return d?.name ?? '';
}

const supabase = clienteSupabase();

interface Cuenta {
  slug: string;
  nombre: string;
  apariciones: number;
  acompanada: number;
  razon: string;
}

async function urlsDe(sitio: Sitio): Promise<string[]> {
  // Se toma una muestra repartida por todo el sitio, no las primeras N: los
  // primeros artículos de un blog suelen ser presentaciones firmadas por el
  // propio blog, y sesgarían la cuenta.
  const { count } = await supabase
    .from('articulos').select('*', { count: 'exact', head: true }).eq('sitio', sitio.clave);
  const total = count ?? 0;
  if (total === 0) return [];

  const paso = Math.max(1, Math.floor(total / MUESTRA));
  const urls: string[] = [];
  for (let i = 0; i < total && urls.length < MUESTRA; i += paso) {
    const { data } = await supabase
      .from('articulos').select('url').eq('sitio', sitio.clave).order('id').range(i, i);
    const fila = (data as { url: string }[] | null)?.[0];
    if (fila) urls.push(fila.url);
  }
  return urls;
}

async function analizar(sitio: Sitio): Promise<Cuenta[]> {
  const urls = await urlsDe(sitio);
  if (urls.length === 0) return [];

  const nombreSitio = await nombreDelSitio(sitio);
  const vistas = new Map<string, { nombre: string; n: number; acompanada: number }>();
  let conAnclas = 0;

  for (const url of urls) {
    const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    const anclas = anclasDeFirma(html);
    if (anclas.length === 0) continue;
    conAnclas++;
    for (const a of anclas) {
      const e = vistas.get(a.slug) ?? { nombre: a.nombre, n: 0, acompanada: 0 };
      e.n++;
      if (anclas.length > 1) e.acompanada++;
      vistas.set(a.slug, e);
    }
    await sleep(DELAY_MS);
  }

  if (conAnclas === 0) return []; // sitio de texto plano: no hay slugs que juzgar

  const cuentas: Cuenta[] = [];
  for (const [slug, e] of vistas) {
    const esDelSitio = slug === sitio.clave;
    const seLlamaComoElBlog =
      nombreSitio !== '' && normalizar(e.nombre) === normalizar(nombreSitio);
    if (!esDelSitio && !seLlamaComoElBlog) continue;
    cuentas.push({
      slug,
      nombre: e.nombre,
      apariciones: e.n,
      acompanada: e.acompanada,
      razon: esDelSitio ? 'slug del propio sitio' : `se llama como el blog ("${nombreSitio}")`,
    });
  }
  return cuentas;
}

async function main() {
  console.log('Archivo Nexos — cuentas institucionales de los subdominios\n');
  const salida: Record<string, Cuenta[]> = {};

  for (const sitio of SUBDOMINIOS) {
    const cuentas = await analizar(sitio);
    if (cuentas.length > 0) {
      salida[sitio.clave] = cuentas;
      for (const c of cuentas) {
        console.log(`${sitio.clave.padEnd(18)} ${c.slug.padEnd(28)} "${c.nombre}"  (${c.razon})`);
      }
    } else {
      console.log(`${sitio.clave.padEnd(18)} —`);
    }
  }

  mkdirSync('datos', { recursive: true });
  writeFileSync(RUTA, JSON.stringify(salida, null, 2));
  console.log(`\nGuardado en ${RUTA}`);
}

main().catch((err) => {
  console.error('Falló la detección de firmas de sitio:', err);
  process.exit(1);
});
