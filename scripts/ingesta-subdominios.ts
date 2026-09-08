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

const PER_PAGE = 50; // trae cuerpo: páginas más chicas para no armar respuestas enormes
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
}

type Avance = Record<string, { ultima_pagina: number; insertados: number; duplicados: number }>;

function leerAvance(): Avance {
  if (!existsSync(RUTA_AVANCE)) return {};
  return JSON.parse(readFileSync(RUTA_AVANCE, 'utf8')) as Avance;
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

async function ingerirSitio(sitio: Sitio, vistos: Set<string>, avance: Avance): Promise<void> {
  const estado = avance[sitio.clave] ?? { ultima_pagina: 0, insertados: 0, duplicados: 0 };
  const categorias = await categoriasDe(sitio);

  console.log(`\n── ${sitio.clave} (esperados ${sitio.esperados}, ${categorias.size} categorías)`);
  if (estado.ultima_pagina > 0) console.log(`   reanudando desde la página ${estado.ultima_pagina + 1}`);

  for (let page = estado.ultima_pagina + 1; ; page++) {
    let respuesta;
    try {
      respuesta = await fetchJson<PostSub[]>(
        `${urlApi(sitio)}/posts?per_page=${PER_PAGE}&page=${page}&orderby=id&order=asc` +
          `&_fields=id,date,link,title,content,categories`,
      );
    } catch (err) {
      const e = err as ErrorWp;
      if (e.status === 400 && e.code === 'rest_post_invalid_page_number') break;
      if (e.status === 400) break;
      throw err;
    }

    const posts = respuesta.data;
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
      if (error) throw new Error(`upsert ${sitio.clave} p${page}: ${error.message}`);

      // El cuerpo va al índice y se descarta: nunca toca una columna.
      for (let i = 0; i < cuerpos.length; i += LOTE_INDICE) {
        const { error: errIdx } = await supabase.rpc('indexar_articulos', {
          p_filas: cuerpos.slice(i, i + LOTE_INDICE),
        });
        if (errIdx) throw new Error(`indexar ${sitio.clave} p${page}: ${errIdx.message}`);
      }
    }

    estado.insertados += filas.length;
    estado.ultima_pagina = page;
    avance[sitio.clave] = estado;
    if (!SECO) guardarAvance(avance);

    if (page % 5 === 0 || posts.length < PER_PAGE) {
      console.log(`   p${page}: +${filas.length} · acumulado ${estado.insertados} · duplicados ${estado.duplicados}`);
    }
    if (posts.length < PER_PAGE) break;
    await sleep(DELAY_MS);
  }

  console.log(`   ${sitio.clave}: ${estado.insertados} nuevos, ${estado.duplicados} duplicados`);
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

  console.log('\n=== RESUMEN ===');
  console.log(`Insertados desde subdominios: ${nuevos}`);
  console.log(`Duplicados omitidos:          ${dups}`);
  console.log(`Total en articulos:           ${count}`);
  console.log(`Avance reanudable:            ${RUTA_AVANCE}`);
}

main().catch((err) => {
  console.error('\nFalló la ingesta de subdominios:', err);
  process.exit(1);
});
