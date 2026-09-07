// Ingesta de metadata del archivo de Nexos — fase 1 (sin cuerpo, sin UI).
// Ver CLAUDE.md secciones 2 y 9.
import './lib/red.js';
import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { clienteSupabase } from './lib/supabase.js';
import { leerCache, mapaDesdeCache } from './lib/cache-autores.js';
import {
  WP_BASE, fetchJson, sleep, decode, construirMapaCategorias,
  esNumeroRevista, esNumeroConMes, fechaDesdeNumero, resolverAutores,
} from './lib/wp.js';

const PER_PAGE = 100;
const DELAY_MS = 300;
const FECHA_MIN = new Date('1978-01-01T00:00:00Z'); // Nexos se fundó en 1978
const FECHA_MAX = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // margen de 30 días a futuro

mkdirSync('logs', { recursive: true });
const LOG_EXCLUIDAS = 'logs/fechas-sospechosas.jsonl';
const LOG_CORREGIDAS = 'logs/fechas-corregidas.jsonl';

const supabase = clienteSupabase();

interface WpPost {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  coauthors?: unknown;
  categories?: number[];
}

interface ErrorWp extends Error {
  status?: number;
  code?: string;
}

async function main() {
  console.log('Archivo Nexos — ingesta de metadata (fase 1)');
  console.log(`WordPress base: ${WP_BASE}\n`);

  // El mapa de autores es requisito: sin él, `coauthors` son IDs numéricos y
  // todos los artículos quedarían sin autor. Se construye con `npm run autores`.
  const cacheAutores = leerCache();
  if (!cacheAutores) {
    console.error('Falta datos/autores.json. Corre primero `npm run autores`.');
    console.error('Sin ese mapa, coauthors son IDs numéricos y ningún artículo tendría autor.');
    process.exit(1);
  }
  const mapaAutores = mapaDesdeCache(cacheAutores);
  console.log(`Mapa de autores: ${mapaAutores.size} nombres reales.`);

  // 1. Total remoto real. Se calcula el número de páginas en vez de leer
  //    X-WP-TotalPages de una llamada con per_page=1, donde valdría 19,145.
  const probe = await fetchJson<WpPost[]>(`${WP_BASE}/posts?per_page=1&_fields=id`);
  const totalRemoto = Number(probe.headers.get('x-wp-total'));
  const totalPaginas = Math.ceil(totalRemoto / PER_PAGE);
  console.log(`X-WP-Total: ${totalRemoto} · páginas de ${PER_PAGE}: ${totalPaginas}`);

  console.log('Construyendo mapa de categorías (números de revista y secciones)...');
  const categorias = await construirMapaCategorias(DELAY_MS);
  console.log(`${categorias.size} categorías cargadas.\n`);

  // 2. Estado reanudable
  const { data: estadoPrevio } = await supabase.from('sync_estado').select('*').eq('id', 1).maybeSingle();

  await supabase.from('sync_estado').upsert({
    id: 1,
    total_paginas: totalPaginas,
    total_remoto: totalRemoto,
    ultima_pagina: estadoPrevio?.ultima_pagina ?? 0,
    total_sincronizados: estadoPrevio?.total_sincronizados ?? 0,
    actualizado_en: new Date().toISOString(),
  });

  const paginaInicio = (estadoPrevio?.ultima_pagina ?? 0) + 1;
  let totalSincronizados = estadoPrevio?.total_sincronizados ?? 0;
  let totalExcluidos = 0;
  let totalCorregidos = 0;
  let totalSinAutor = 0;

  if (paginaInicio > 1) {
    console.log(`Reanudando desde la página ${paginaInicio} (${totalSincronizados} filas ya sincronizadas).\n`);
  }

  // orderby=id&order=asc: orden estable aunque se publiquen artículos nuevos
  // entre corridas, para que la paginación reanudable no se desalinee.
  for (let page = paginaInicio; ; page++) {
    const url = `${WP_BASE}/posts?per_page=${PER_PAGE}&page=${page}&orderby=id&order=asc&_fields=id,date,link,title,coauthors,categories`;

    let respuesta;
    try {
      respuesta = await fetchJson<WpPost[]>(url);
    } catch (err) {
      const e = err as ErrorWp;
      if (e.status === 400 && e.code === 'rest_post_invalid_page_number') {
        console.log(`Página ${page}: rest_post_invalid_page_number — fin del archivo.`);
        break;
      }
      throw err;
    }

    const posts = respuesta.data;
    if (posts.length === 0) {
      console.log(`Página ${page}: sin resultados — fin del archivo.`);
      break;
    }

    const filas: Record<string, unknown>[] = [];
    for (const post of posts) {
      const nombresCategorias = (post.categories ?? [])
        .map((id) => categorias.get(id))
        .filter((n): n is string => !!n);

      // Los números de revista vienen como "1978 Enero" y como "1978". Se
      // prefiere el que trae mes; ninguno de los dos es una sección temática.
      const numerosRevista = nombresCategorias.filter(esNumeroRevista);
      const numero = numerosRevista.find(esNumeroConMes) ?? numerosRevista[0] ?? null;
      const seccion = nombresCategorias.find((n) => !esNumeroRevista(n)) ?? null;

      let fechaPub: string | null = null;
      const fecha = new Date(post.date);
      const fechaValida = !Number.isNaN(fecha.getTime()) && fecha >= FECHA_MIN && fecha <= FECHA_MAX;

      if (fechaValida) {
        fechaPub = fecha.toISOString().slice(0, 10);
      } else {
        // `date` corrupto (los hay con 1970-01-01). El número de la revista es
        // metadata del propio archivo, así que la fecha se recupera de ahí:
        // es un dato del archivo, no una deducción nuestra.
        const recuperada = numero ? fechaDesdeNumero(numero) : null;
        const registro = {
          id: post.id,
          titulo: decode(post.title?.rendered),
          fecha_wp: post.date,
          numero,
          url: post.link,
        };
        if (recuperada) {
          fechaPub = recuperada;
          totalCorregidos++;
          appendFileSync(LOG_CORREGIDAS, JSON.stringify({ ...registro, fecha_recuperada: recuperada }) + '\n');
        } else {
          // Sin número no hay de dónde recuperarla, y una fecha inventada
          // contaminaría el rango visible del archivo. Se excluye y se registra.
          totalExcluidos++;
          appendFileSync(LOG_EXCLUIDAS, JSON.stringify(registro) + '\n');
          continue;
        }
      }

      const { autores, confianza } = resolverAutores(post.coauthors, mapaAutores);
      if (confianza === 'ausente') totalSinAutor++;

      filas.push({
        id: post.id,
        url: post.link,
        titulo: decode(post.title?.rendered),
        autores,
        autor_confianza: confianza,
        fecha_pub: fechaPub,
        numero,
        seccion,
      });
    }

    if (filas.length > 0) {
      const { error } = await supabase.from('articulos').upsert(filas, { onConflict: 'id' });
      if (error) throw new Error(`Error en upsert de la página ${page}: ${error.message}`);
    }

    totalSincronizados += filas.length;
    const { error: errorEstado } = await supabase
      .from('sync_estado')
      .update({
        ultima_pagina: page,
        total_sincronizados: totalSincronizados,
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', 1);
    if (errorEstado) throw new Error(`Error guardando sync_estado en página ${page}: ${errorEstado.message}`);

    console.log(`Página ${page}/${totalPaginas} · ${filas.length} filas · acumulado ${totalSincronizados}`);

    await sleep(DELAY_MS);
  }

  // 3. Reconciliación explícita contra X-WP-Total
  const { count: totalLocal, error: errorCount } = await supabase
    .from('articulos')
    .select('*', { count: 'exact', head: true });
  if (errorCount) throw new Error(`Error contando articulos: ${errorCount.message}`);

  const diferencia = totalRemoto - (totalLocal ?? 0) - totalExcluidos;

  console.log('\n=== RECONCILIACIÓN ===');
  console.log(`X-WP-Total (remoto):          ${totalRemoto}`);
  console.log(`Filas en articulos:           ${totalLocal}`);
  console.log(`Fechas recuperadas del número:${totalCorregidos}  (ver ${LOG_CORREGIDAS})`);
  console.log(`Excluidos sin fecha usable:   ${totalExcluidos}  (ver ${LOG_EXCLUIDAS})`);
  console.log(`Sin autor en esta corrida:    ${totalSinAutor}`);
  console.log(`Diferencia sin explicar:      ${diferencia}`);

  await supabase.from('sync_estado').update({ actualizado_en: new Date().toISOString() }).eq('id', 1);

  if (Math.abs(diferencia) > 5) {
    console.error('\n*** LA INGESTA NO CUADRA (diferencia > 5). Revisar antes de continuar. ***');
    process.exitCode = 1;
  } else {
    console.log('\nReconciliación dentro de tolerancia (±5). Corre `npm run verificar`.');
  }
}

main().catch((err) => {
  console.error('\nFalló la ingesta:', err);
  process.exit(1);
});
