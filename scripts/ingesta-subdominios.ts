// Ingesta de los 26 subdominios de Nexos.
//
// El archivo no vive en un solo WordPress (ver CLAUDE.md sección 2): estos 26
// sitios suman 14,479 artículos que `npm run ingesta` no alcanzaba, porque solo
// recorre www.nexos.com.mx.
//
// Dos diferencias con la ingesta principal:
//
// 1. Aquí SÍ viene el cuerpo. La API de los subdominios devuelve
//    `content.rendered` completo, sin paywall y sin credenciales. Pero el
//    cuerpo NO se almacena: se manda a la función `indexar_articulos`, que
//    calcula el tsvector y descarta el texto. Así el buscador encuentra un
//    artículo por lo que dice adentro, los artículos no "viven" en esta base
//    —siempre se manda a nexos.com.mx— y si la base se filtrara lo que se
//    llevarían serían lexemas, no 56 años de archivo legible.
//
// 2. Hay que deduplicar. Los subdominios republican parte del sitio principal
//    en proporción muy desigual: angelesmastretta repite el 83% y aguilarcamin
//    nada. Se compara por título normalizado, que es lo único común entre
//    instalaciones con espacios de ids distintos.
//
// El autor NO se resuelve aquí: /wp/v2/users da 401 igual que en www, y solo
// algunos subdominios tienen taxonomía de coautores. Se deja en 'ausente' y lo
// llena después `npm run recuperar-autores`, que lee la firma de la página y ya
// probó recuperar el 74%.
import './lib/red.js';
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { clienteSupabase } from './lib/supabase.js';
import { decode, esNumeroConMes, esNumeroRevista, fetchJson, sleep } from './lib/wp.js';
import { SUBDOMINIOS, type Sitio, claveTitulo, idDeBase, urlApi } from './lib/sitios.js';

const TAM_LOTE = 25; // trae cuerpo: lotes chicos, un lote grande pesa ~500 KB
const DELAY_MS = 300;
const LOTE_INDICE = 25;
const FECHA_MIN = new Date('1978-01-01T00:00:00Z');
const FECHA_MAX = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
const RUTA_AVANCE = 'datos/avance-subdominios.json';

const soloArg = process.argv.find((a) => a.startsWith('--sitio='));
const SOLO = soloArg ? soloArg.split('=')[1] : null;
const SECO = process.argv.includes('--seco');

const supabase = clienteSupabase();

interface PostSub {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  content?: { rendered: string };
  categories?: number[];
}

interface ErrorWp extends Error {
  status?: number;
  code?: string;
  jsonInvalido?: boolean;
}

// El avance se guarda como `offset`, no como página: la ingesta parte los lotes
// cuando el servidor devuelve JSON inválido, así que el tamaño no es constante.
interface EstadoSitio {
  offset: number;
  insertados: number;
  duplicados: number;
  sin_indexar: number; // artículos guardados sin indexar el cuerpo (JSON roto)
  ultima_pagina?: number; // formato viejo, se convierte al leer
}
type Avance = Record<string, EstadoSitio>;

function leerAvance(): Avance {
  if (!existsSync(RUTA_AVANCE)) return {};
  const bruto = JSON.parse(readFileSync(RUTA_AVANCE, 'utf8')) as Avance;
  for (const estado of Object.values(bruto)) {
    // Corridas viejas guardaban páginas de 25; se convierten a offset.
    if (estado.offset === undefined) estado.offset = (estado.ultima_pagina ?? 0) * 25;
    delete estado.ultima_pagina;
    estado.sin_indexar ??= 0;
  }
  return bruto;
}

function guardarAvance(a: Avance): void {
  mkdirSync('datos', { recursive: true });
  writeFileSync(RUTA_AVANCE, JSON.stringify(a, null, 2));
}

/** Títulos ya cargados, para deduplicar. 33k claves caben de sobra en memoria. */
async function titulosExistentes(): Promise<Set<string>> {
  const claves = new Set<string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('articulos').select('titulo').order('id').range(desde, desde + 999);
    if (error) throw new Error(`Error listando títulos: ${error.message}`);
    if (!data?.length) break;
    for (const f of data as { titulo: string }[]) claves.add(claveTitulo(f.titulo));
    if (data.length < 1000) break;
  }
  return claves;
}

/** Mapa id -> nombre de categoría del sitio, para número de revista y sección. */
async function categoriasDe(sitio: Sitio): Promise<Map<number, string>> {
  const mapa = new Map<number, string>();
  for (let page = 1; ; page++) {
    try {
      const r = await fetchJson<{ id: number; name: string }[]>(
        `${urlApi(sitio)}/categories?per_page=100&page=${page}&_fields=id,name`,
      );
      if (r.data.length === 0) break;
      for (const c of r.data) mapa.set(c.id, decode(c.name));
      if (r.data.length < 100) break;
    } catch (err) {
      if ((err as ErrorWp).status === 400) break;
      break; // un sitio sin categorías no debe matar la corrida
    }
    await sleep(DELAY_MS);
  }
  return mapa;
}

/** Texto plano del cuerpo, solo para calcular el índice. Nunca se guarda. */
function cuerpoPlano(html: string | undefined): string {
  if (!html) return '';
  return decode(html).slice(0, 60_000);
}

/**
 * Trae un lote de posts por `offset`, no por página, porque el tamaño del lote
 * cambia cuando hay que partirlo.
 *
 * El WordPress de Nexos a veces emite JSON inválido: una comilla sin escapar
 * dentro del cuerpo de un artículo rompe la respuesta entera (verificado en
 * cultura, offset 3950). Reintentar no sirve —el servidor devuelve byte por
 * byte lo mismo— y perder 25 artículos por uno roto sería peor. Así que el lote
 * se parte a la mitad hasta aislar al culpable, y a ese único artículo se le
 * pide la metadata sin `content`: se conserva el texto en el archivo, se pierde
 * solo su indexación por cuerpo, y queda contado en `sin_indexar`.
 */
async function traerLote(
  sitio: Sitio,
  offset: number,
  tam: number,
  estado: EstadoSitio,
  conCuerpo = true,
): Promise<PostSub[]> {
  const campos = conCuerpo
    ? 'id,date,link,title,content,categories'
    : 'id,date,link,title,categories';
  const url =
    `${urlApi(sitio)}/posts?per_page=${tam}&offset=${offset}&orderby=id&order=asc&_fields=${campos}`;

  try {
    return (await fetchJson<PostSub[]>(url)).data;
  } catch (err) {
    const e = err as ErrorWp;
    if (!e.jsonInvalido) throw err; // 400 = fin; red = ya reintentó fetchJson

    if (tam > 1) {
      const mitad = Math.ceil(tam / 2);
      await sleep(DELAY_MS);
      const a = await traerLote(sitio, offset, mitad, estado, conCuerpo);
      if (a.length < mitad) return a; // se acabaron los posts
      await sleep(DELAY_MS);
      const b = await traerLote(sitio, offset + mitad, tam - mitad, estado, conCuerpo);
      return [...a, ...b];
    }

    if (conCuerpo) {
      console.warn(`   ⚠ ${sitio.clave} offset ${offset}: JSON inválido del servidor; se guarda sin indexar el cuerpo`);
      estado.sin_indexar++;
      await sleep(DELAY_MS);
      return traerLote(sitio, offset, 1, estado, false);
    }

    throw err; // ni siquiera la metadata es legible: eso sí es un fallo
  }
}

async function ingerirSitio(sitio: Sitio, vistos: Set<string>, avance: Avance): Promise<void> {
  const estado: EstadoSitio =
    avance[sitio.clave] ?? { offset: 0, insertados: 0, duplicados: 0, sin_indexar: 0 };
  const categorias = await categoriasDe(sitio);

  console.log(`\n── ${sitio.clave} (esperados ${sitio.esperados}, ${categorias.size} categorías)`);
  if (estado.offset > 0) console.log(`   reanudando desde el artículo ${estado.offset + 1}`);

  for (;;) {
    let posts: PostSub[];
    try {
      posts = await traerLote(sitio, estado.offset, TAM_LOTE, estado);
    } catch (err) {
      if ((err as ErrorWp).status === 400) break; // rest_post_invalid_page_number: terminaste
      throw err;
    }

    if (posts.length === 0) break;

    const filas: Record<string, unknown>[] = [];
    const cuerpos: { id: number; cuerpo: string }[] = [];

    for (const post of posts) {
      const titulo = decode(post.title?.rendered);
      if (!titulo) continue;

      const clave = claveTitulo(titulo);
      if (vistos.has(clave)) {
        estado.duplicados++;
        continue; // ya está, publicado en el sitio principal u otro subdominio
      }

      const fecha = new Date(post.date);
      if (Number.isNaN(fecha.getTime()) || fecha < FECHA_MIN || fecha > FECHA_MAX) continue;

      const nombres = (post.categories ?? [])
        .map((id) => categorias.get(id))
        .filter((n): n is string => !!n);
      const numeros = nombres.filter(esNumeroRevista);

      const id = idDeBase(sitio, post.id);
      filas.push({
        id,
        id_wp: post.id,
        sitio: sitio.clave,
        url: post.link,
        titulo,
        autores: [],
        autor_confianza: 'ausente', // lo llena `npm run recuperar-autores`
        fecha_pub: fecha.toISOString().slice(0, 10),
        numero: numeros.find(esNumeroConMes) ?? numeros[0] ?? null,
        seccion: nombres.find((n) => !esNumeroRevista(n)) ?? null,
      });

      const cuerpo = cuerpoPlano(post.content?.rendered);
      if (cuerpo) cuerpos.push({ id, cuerpo });
      vistos.add(clave);
    }

    if (filas.length > 0 && !SECO) {
      const { error } = await supabase.from('articulos').upsert(filas, { onConflict: 'id' });
      if (error) throw new Error(`upsert ${sitio.clave} @${estado.offset}: ${error.message}`);

      // El cuerpo va al índice y se descarta: nunca toca una columna.
      for (let i = 0; i < cuerpos.length; i += LOTE_INDICE) {
        const { error: errIdx } = await supabase.rpc('indexar_articulos', {
          p_filas: cuerpos.slice(i, i + LOTE_INDICE),
        });
        if (errIdx) throw new Error(`indexar ${sitio.clave} @${estado.offset}: ${errIdx.message}`);
      }
    }

    const previo = estado.offset;
    estado.insertados += filas.length;
    estado.offset += posts.length;
    avance[sitio.clave] = estado;
    if (!SECO) guardarAvance(avance);

    if (Math.floor(previo / 500) !== Math.floor(estado.offset / 500) || posts.length < TAM_LOTE) {
      console.log(`   @${estado.offset}: acumulado ${estado.insertados} · duplicados ${estado.duplicados}`);
    }
    if (posts.length < TAM_LOTE) break;
    await sleep(DELAY_MS);
  }

  avance[sitio.clave] = estado;
  const nota = estado.sin_indexar > 0 ? `, ${estado.sin_indexar} sin indexar el cuerpo` : '';
  console.log(`   ${sitio.clave}: ${estado.insertados} nuevos, ${estado.duplicados} duplicados${nota}`);
}

async function main() {
  console.log('Archivo Nexos — ingesta de los 26 subdominios\n');

  const objetivo = SOLO ? SUBDOMINIOS.filter((s) => s.clave === SOLO) : SUBDOMINIOS;
  if (objetivo.length === 0) {
    console.error(`No existe el subdominio "${SOLO}".`);
    process.exit(1);
  }

  console.log('Cargando títulos ya existentes para deduplicar...');
  const vistos = await titulosExistentes();
  console.log(`${vistos.size} títulos en la base.`);

  const avance = leerAvance();
  for (const sitio of objetivo) {
    await ingerirSitio(sitio, vistos, avance);
  }

  const { count } = await supabase.from('articulos').select('*', { count: 'exact', head: true });
  const nuevos = Object.values(avance).reduce((s, e) => s + e.insertados, 0);
  const dups = Object.values(avance).reduce((s, e) => s + e.duplicados, 0);
  const sinIdx = Object.values(avance).reduce((s, e) => s + (e.sin_indexar ?? 0), 0);

  console.log('\n=== RESUMEN ===');
  console.log(`Insertados desde subdominios: ${nuevos}`);
  console.log(`Duplicados omitidos:          ${dups}`);
  console.log(`Guardados sin indexar cuerpo: ${sinIdx}  (JSON inválido del servidor)`);
  console.log(`Total en articulos:           ${count}`);
  console.log(`Avance reanudable:            ${RUTA_AVANCE}`);
}

main().catch((err) => {
  console.error('\nFalló la ingesta de subdominios:', err);
  process.exit(1);
});
