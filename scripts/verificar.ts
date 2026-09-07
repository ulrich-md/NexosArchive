// npm run verificar — contrasta la ingesta contra la API en vivo y falla
// ruidosamente si no cuadra. Ver CLAUDE.md secciones 1 y 9.
import './lib/red.js';
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { WP_BASE, fetchJson, sleep } from './lib/wp.js';

const supabase = clienteSupabase();

// Verificados contra la API el 2026-09-07 (ver CLAUDE.md sección 1).
const ANIOS_VERIFICADOS: Record<number, number> = {
  1988: 246,
  1994: 283,
  2006: 307,
  2016: 568,
  2024: 463,
};

let fallos = 0;

function reportar(nombre: string, ok: boolean, detalle: string) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${nombre} — ${detalle}`);
  if (!ok) fallos++;
}

/** count(*) con un filtro opcional, sin traerse las filas. */
async function contar(filtro?: (q: any) => any): Promise<number> {
  let q = supabase.from('articulos').select('*', { count: 'exact', head: true });
  if (filtro) q = filtro(q);
  const { count, error } = await q;
  if (error) throw new Error(`Error consultando articulos: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log('Archivo Nexos — verificación de ingesta\n');

  // 1. Total contra X-WP-Total en vivo (±5: pueden publicarse artículos entre
  //    la ingesta y esta corrida).
  const probe = await fetchJson<unknown[]>(`${WP_BASE}/posts?per_page=1&_fields=id`);
  const totalRemoto = Number(probe.headers.get('x-wp-total'));
  const totalLocal = await contar();
  reportar(
    'Total de artículos',
    Math.abs(totalRemoto - totalLocal) <= 5,
    `remoto=${totalRemoto} local=${totalLocal} diff=${totalRemoto - totalLocal}`,
  );

  // 2. Conteos por año verificados a mano (±2)
  for (const [anioStr, esperado] of Object.entries(ANIOS_VERIFICADOS)) {
    const anio = Number(anioStr);
    const n = await contar((q) => q.eq('anio_pub', anio));
    reportar(`Conteo ${anio}`, Math.abs(n - esperado) <= 2, `esperado=${esperado} local=${n}`);
    await sleep(50);
  }

  // 3. Títulos limpios: ni entidades HTML sin decodificar ni etiquetas.
  //    El 14% de los títulos de Nexos traen <em>; si sobreviven, la ficha
  //    mostraría "<em>Audición</em>" literal.
  const conEntidades = await contar((q) => q.filter('titulo', 'match', '&[#a-zA-Z][a-zA-Z0-9]{1,10};'));
  reportar('Sin entidades HTML en títulos', conEntidades === 0, `${conEntidades} títulos con entidades`);

  const conEtiquetas = await contar((q) => q.filter('titulo', 'match', '<[^>]+>'));
  reportar('Sin etiquetas HTML en títulos', conEtiquetas === 0, `${conEtiquetas} títulos con etiquetas`);

  // 4. Rango de fechas: Nexos se fundó en 1978.
  const fechasMalas = await contar((q) => q.lt('fecha_pub', '1978-01-01'));
  reportar('Sin fecha_pub < 1978-01-01', fechasMalas === 0, `${fechasMalas} filas anteriores a 1978`);

  // 5. Autores: que se hayan resuelto de verdad. Si `coauthors` quedó sin
  //    resolver, TODO el archivo saldría sin autor y el sidebar vacío.
  const conAutor = await contar((q) => q.eq('autor_confianza', 'wp'));
  const pct = totalLocal > 0 ? Math.round((conAutor / totalLocal) * 100) : 0;
  reportar('Artículos con autor resuelto', conAutor > 0, `${conAutor}/${totalLocal} (${pct}%)`);

  // 6. Ningún autor guardado en forma slug: "carlos-monsivais" en vez de
  //    "Carlos Monsiváis" significa que se guardó el dato crudo de la API.
  const { data: muestraAutores } = await supabase.from('autores_conteo').select('autor').limit(2000);
  const comoSlug = (muestraAutores ?? [])
    .map((r: { autor: string }) => r.autor)
    .filter((a) => /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(a));
  reportar(
    'Ningún autor en forma slug',
    comoSlug.length === 0,
    comoSlug.length === 0 ? 'ninguno' : `${comoSlug.length}, p.ej. ${comoSlug.slice(0, 3).join(', ')}`,
  );

  // 7. sync_estado reconciliado
  const { data: estado, error: errEstado } = await supabase
    .from('sync_estado').select('*').eq('id', 1).maybeSingle();
  if (errEstado) throw new Error(`Error consultando sync_estado: ${errEstado.message}`);
  reportar(
    'sync_estado reconciliado',
    !!estado && estado.ultima_pagina > 0 && estado.ultima_pagina >= (estado.total_paginas ?? 0),
    estado
      ? `ultima_pagina=${estado.ultima_pagina}/${estado.total_paginas} sincronizados=${estado.total_sincronizados}`
      : 'sin fila en sync_estado — ¿corriste `npm run ingesta`?',
  );

  // 8. Seguridad (sección 6): la llave pública no debe poder leer el archivo.
  //    Solo es concluyente con datos cargados: con la tabla vacía, [] no
  //    distingue "RLS bloqueó" de "no hay filas".
  const llavePublica = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!llavePublica) {
    console.log('SKIP  Lectura con llave pública — define SUPABASE_PUBLISHABLE_KEY para probarlo');
  } else if (totalLocal === 0) {
    console.log('SKIP  Lectura con llave pública — sin datos cargados la prueba no concluye nada');
  } else {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/articulos?select=id&limit=5`, {
      headers: { apikey: llavePublica, Authorization: `Bearer ${llavePublica}` },
    });
    const filas = res.ok ? ((await res.json()) as unknown[]) : [];
    reportar(
      'Llave pública NO lee el archivo',
      !res.ok || filas.length === 0,
      `HTTP ${res.status}, ${filas.length} filas (con ${totalLocal} en la tabla)`,
    );
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} verificación(es) fallida(s)`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Error al verificar:', err);
  process.exit(1);
});
