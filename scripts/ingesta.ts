// Ingesta de metadata del archivo de Nexos — fase 1 (sin cuerpo, sin UI).
// Ejecutar localmente: npm run ingesta. Ver CLAUDE.md secciones 2 y 9.
import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { clienteSupabase } from './lib/supabase.js';
import { WP_BASE, fetchJson, sleep, decode, construirMapaCategorias, esNumeroRevista, resolverAutores } from './lib/wp.js';

const PER_PAGE = 100;
const DELAY_MS = 300;
const FECHA_MIN = new Date('1978-01-01T00:00:00Z'); // Nexos se fundó en 1978
const FECHA_MAX = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // margen de 30 días a futuro

mkdirSync('logs', { recursive: true });
const LOG_SOSPECHOSAS = 'logs/fechas-sospechosas.jsonl';

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

  // 1. Total remoto real (independiente de per_page, para no confundir
  //    X-WP-TotalPages de una llamada con per_page=1 con las páginas de 100).
  const probe = await fetchJson<WpPost[]>(`${WP_BASE}/posts?per_page=1&_fields=id`);
  const totalRemoto = Number(probe.headers.get('x-wp-total'));
  const totalPaginas = Math.ceil(totalRemoto / PER_PAGE);
  console.log(`X-WP-Total: ${totalRemoto} · páginas de ${PER_PAGE}: ${totalPaginas}`);

  console.log('Construyendo mapa de categorías (números de revista y secciones)...');
  const categorias = await construirMapaCategorias();
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
  let totalExcluidosPorFecha = 0;

  if (paginaInicio > 1) {
    console.log(`Reanudando desde la página ${paginaInicio} (${totalSincronizados} filas ya sincronizadas).\n`);
  }

  // orderby=id&order=asc: pagina en un orden estable aunque se publiquen
  // artículos nuevos entre corridas, para que la ingesta reanudable no se
  // desalinee (el orden por defecto es por fecha desc).
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
      const fecha = new Date(post.date);
      if (Number.isNaN(fecha.getTime()) || fecha < FECHA_MIN || fecha > FECHA_MAX) {
        // No se inserta: una fecha basura no debe definir el rango visible
        // del archivo (ver CLAUDE.md sección 0). Se registra para revisión manual.
        appendFileSync(
          LOG_SOSPECHOSAS,
          JSON.stringify({ id: post.id, titulo: decode(post.title?.rendered), fecha_wp: post.date, url: post.link }) + '\n',
        );
        totalExcluidosPorFecha++;
        continue;
      }

      const nombresCategorias = (post.categories ?? [])
        .map((id) => categorias.get(id))
        .filter((n): n is string => !!n);
      const numero = nombresCategorias.find(esNumeroRevista) ?? null;
      const seccion = nombresCategorias.find((n) => !esNumeroRevista(n)) ?? null;
      const { autores, confianza } = resolverAutores(post.coauthors);

      filas.push({
        id: post.id,
        url: post.link,
        titulo: decode(post.title?.rendered),
        autores,
        autor_confianza: confianza,
        fecha_pub: fecha.toISOString().slice(0, 10),
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

    console.log(
      `Página ${page}/${totalPaginas} · ${filas.length} filas (${posts.length - filas.length} excluidas por fecha) · acumulado ${totalSincronizados}`,
    );

    await sleep(DELAY_MS);
  }

  // 3. Reconciliación explícita contra X-WP-Total
  const { count: totalLocal, error: errorCount } = await supabase
    .from('articulos')
    .select('*', { count: 'exact', head: true });
  if (errorCount) throw new Error(`Error contando articulos: ${errorCount.message}`);

  const diferencia = totalRemoto - (totalLocal ?? 0) - totalExcluidosPorFecha;

  console.log('\n=== RECONCILIACIÓN ===');
  console.log(`X-WP-Total (remoto):         ${totalRemoto}`);
  console.log(`Filas en articulos:          ${totalLocal}`);
  console.log(`Excluidas por fecha < 1978:  ${totalExcluidosPorFecha} (ver ${LOG_SOSPECHOSAS})`);
  console.log(`Diferencia sin explicar:     ${diferencia}`);

  await supabase
    .from('sync_estado')
    .update({ actualizado_en: new Date().toISOString() })
    .eq('id', 1);

  if (Math.abs(diferencia) > 5) {
    console.error('\n*** LA INGESTA NO CUADRA (diferencia > 5). Revisar antes de continuar a fase 2. ***');
    process.exitCode = 1;
  } else {
    console.log('\nReconciliación dentro de tolerancia (±5). Corre `npm run verificar` para el chequeo completo.');
  }
}

main().catch((err) => {
  console.error('\nFalló la ingesta:', err);
  process.exit(1);
});
