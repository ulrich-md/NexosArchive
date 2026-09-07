// npm run verificar — compara la ingesta contra la API en vivo y falla
// ruidosamente si no cuadra. Ver CLAUDE.md secciones 1 y 9.
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { WP_BASE, fetchJson, sleep } from './lib/wp.js';

const supabase = clienteSupabase();

// Verificados a mano el 2026-09-07 contra la API (ver CLAUDE.md sección 1).
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

async function main() {
  console.log('Archivo Nexos — verificación de ingesta\n');

  // 1. Total contra X-WP-Total en vivo (±5, por artículos publicados entre la
  //    ingesta y esta corrida).
  const probe = await fetchJson<unknown[]>(`${WP_BASE}/posts?per_page=1&_fields=id`);
  const totalRemoto = Number(probe.headers.get('x-wp-total'));
  const { count: totalLocal, error: errorTotal } = await supabase
    .from('articulos')
    .select('*', { count: 'exact', head: true });
  if (errorTotal) throw new Error(`Error consultando articulos: ${errorTotal.message}`);

  reportar(
    'Total de artículos',
    Math.abs(totalRemoto - (totalLocal ?? 0)) <= 5,
    `remoto=${totalRemoto} local=${totalLocal} diff=${totalRemoto - (totalLocal ?? 0)}`,
  );

  // 2. Conteos por año verificados a mano (±2)
  for (const [anioStr, esperado] of Object.entries(ANIOS_VERIFICADOS)) {
    const anio = Number(anioStr);
    const { count, error } = await supabase
      .from('articulos')
      .select('*', { count: 'exact', head: true })
      .eq('anio_pub', anio);
    if (error) throw new Error(`Error consultando conteo de ${anio}: ${error.message}`);
    reportar(`Conteo ${anio}`, Math.abs((count ?? 0) - esperado) <= 2, `esperado=${esperado} local=${count}`);
    await sleep(50);
  }

  // 3. Sin entidades HTML sin decodificar en los títulos (&#8211; &amp; &#8220; ...)
  const { data: conEntidades, count: countEntidades, error: errorEntidades } = await supabase
    .from('articulos')
    .select('id,titulo', { count: 'exact' })
    .filter('titulo', 'match', '&[#a-zA-Z][a-zA-Z0-9]{1,10};')
    .limit(5);
  if (errorEntidades) throw new Error(`Error buscando entidades HTML: ${errorEntidades.message}`);
  reportar(
    'Sin entidades HTML en títulos',
    (countEntidades ?? 0) === 0,
    (countEntidades ?? 0) === 0
      ? 'ninguna encontrada'
      : `${countEntidades} títulos con entidades. Ejemplos: ${(conEntidades ?? []).map((r) => r.titulo).join(' | ')}`,
  );

  // 4. Sin fecha_pub anterior a la fundación de Nexos
  const { count: fechasMalas, error: errorFechas } = await supabase
    .from('articulos')
    .select('*', { count: 'exact', head: true })
    .lt('fecha_pub', '1978-01-01');
  if (errorFechas) throw new Error(`Error consultando fechas: ${errorFechas.message}`);
  reportar('Sin fecha_pub < 1978-01-01', (fechasMalas ?? 0) === 0, `${fechasMalas ?? 0} filas con fecha anterior a 1978`);

  // 5. sync_estado presente y reconciliado
  const { data: estado, error: errorEstado } = await supabase.from('sync_estado').select('*').eq('id', 1).maybeSingle();
  if (errorEstado) throw new Error(`Error consultando sync_estado: ${errorEstado.message}`);
  reportar(
    'sync_estado reconciliado',
    !!estado && estado.ultima_pagina > 0 && estado.ultima_pagina === estado.total_paginas,
    estado
      ? `ultima_pagina=${estado.ultima_pagina}/${estado.total_paginas} total_sincronizados=${estado.total_sincronizados}`
      : 'sin fila en sync_estado — ¿corriste `npm run ingesta`?',
  );

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} verificación(es) fallida(s)`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Error al verificar:', err);
  process.exit(1);
});
