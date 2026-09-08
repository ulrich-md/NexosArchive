// npm run verificar — contrasta la ingesta contra la API en vivo y falla
// ruidosamente si no cuadra. Ver CLAUDE.md secciones 1 y 9.
import './lib/red.js';
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { WP_BASE, fetchJson, sleep } from './lib/wp.js';
import { SITIOS, SUBDOMINIOS, urlApi } from './lib/sitios.js';
import { existsSync, readFileSync } from 'node:fs';

const supabase = clienteSupabase();
const RUTA_AVANCE = 'datos/avance-subdominios.json';
const RUTA_FIRMAS = 'datos/firmas-institucionales.json';

/**
 * Conteo remoto de un año, preguntándole a la API en vivo.
 *
 * OJO con los límites: `after` y `before` de WordPress son EXCLUSIVOS. Usar
 * `after=YYYY-01-01T00:00:00` descarta en silencio todo artículo fechado
 * exactamente a medianoche del 1 de enero, que es justo como quedó migrado el
 * archivo impreso viejo (45 artículos solo en 1988). Los números "verificados"
 * del spec original salieron de esa consulta y por eso venían cortos; los años
 * modernos coincidían porque sus posts traen hora real, no medianoche exacta.
 *
 * La ventana correcta para el año Y va del último instante de Y-1 al primero
 * de Y+1.
 */
async function conteoRemotoDelAnio(anio: number): Promise<number> {
  const desde = `${anio - 1}-12-31T23:59:59`;
  const hasta = `${anio + 1}-01-01T00:00:00`;
  const url = `${WP_BASE}/posts?per_page=1&_fields=id&after=${desde}&before=${hasta}`;
  const { headers } = await fetchJson<unknown[]>(url);
  return Number(headers.get('x-wp-total'));
}

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

  // 1. Cobertura sitio por sitio contra X-WP-Total en vivo.
  //
  //    El archivo vive en 27 WordPress (CLAUDE.md sección 2), así que un solo
  //    total no dice nada: los subdominios republican parte del sitio principal
  //    y la ingesta los deduplica por título, de modo que el conteo local de un
  //    subdominio es MENOR que su X-WP-Total y eso está bien.
  //
  //    Lo que sí hay que probar es que ningún artículo se perdió en silencio,
  //    que es exactamente como falló la versión de Lovable. La igualdad que
  //    importa es `insertados + duplicados == X-WP-Total`: prueba que la
  //    ingesta VIO todos los artículos remotos, haya guardado o descartado cada
  //    uno. Los insertados/duplicados salen del avance de la ingesta.
  interface EstadoAvance {
    insertados: number;
    duplicados: number;
    sin_indexar?: number;
    descartados?: Record<string, number>;
  }
  const avance: Record<string, EstadoAvance> =
    existsSync(RUTA_AVANCE) ? JSON.parse(readFileSync(RUTA_AVANCE, 'utf8')) : {};
  const descartadosDe = (e?: EstadoAvance) =>
    Object.values(e?.descartados ?? {}).reduce((n, v) => n + v, 0);

  const totalLocal = await contar();
  const huecos: string[] = [];
  let totalRemotoTodos = 0;
  let totalRemoto = 0; // solo www, se usa más abajo

  for (const sitio of SITIOS) {
    const probe = await fetchJson<unknown[]>(`${urlApi(sitio)}/posts?per_page=1&_fields=id`);
    const remoto = Number(probe.headers.get('x-wp-total'));
    totalRemotoTodos += remoto;
    if (sitio.clave === 'www') totalRemoto = remoto;

    const local = await contar((q) => q.eq('sitio', sitio.clave));
    const est = avance[sitio.clave];
    // www no deduplica (es la fuente); los subdominios sí.
    // Un artículo remoto puede acabar en tres lugares y los tres cuentan como
    // visto: insertado, descartado por repetido, o descartado por el filtro
    // (sin título, fecha imposible). Lo que no puede es desaparecer sin dejar
    // rastro en ninguno de los tres.
    const vistos =
      sitio.clave === 'www'
        ? local
        : (est?.insertados ?? local) + (est?.duplicados ?? 0) + descartadosDe(est);

    if (Math.abs(remoto - vistos) > 5) {
      huecos.push(`${sitio.clave}: remoto=${remoto} vistos=${vistos} (local=${local})`);
    }
    await sleep(300);
  }

  reportar(
    `Cobertura de los ${SITIOS.length} sitios`,
    huecos.length === 0,
    huecos.length === 0
      ? `${totalRemotoTodos} artículos remotos, todos vistos; ${totalLocal} en la base tras deduplicar`
      : huecos.join(' · '),
  );

  // 2. Conteos por año contra la API en vivo, TODOS los años del archivo (±2).
  //    Se comparan contra la API y no contra constantes: una constante mal
  //    obtenida se vuelve un criterio de aceptación equivocado, y "arreglar"
  //    los datos para que cuadren con ella habría borrado artículos reales.
  //    Se cuenta año por año en la base: traerse las filas y agrupar en
  //    memoria no sirve, porque PostgREST corta la respuesta a 1000 filas.
  //    Se comparan solo los artículos de `www`, porque conteoRemotoDelAnio le
  //    pregunta a www: mezclar los subdominios haría que el local sobre siempre.
  const extremo = async (asc: boolean): Promise<number> => {
    const { data, error } = await supabase
      .from('articulos').select('anio_pub').eq('sitio', 'www')
      .order('anio_pub', { ascending: asc }).limit(1).single();
    if (error) throw new Error(`Error obteniendo el rango de años: ${error.message}`);
    return (data as { anio_pub: number }).anio_pub;
  };
  const anioMin = await extremo(true);
  const anioMax = await extremo(false);

  const desajustes: string[] = [];
  let aniosRevisados = 0;
  for (let anio = anioMin; anio <= anioMax; anio++) {
    const local = await contar((q) => q.eq('anio_pub', anio).eq('sitio', 'www'));
    const remoto = await conteoRemotoDelAnio(anio);
    aniosRevisados++;
    if (Math.abs(local - remoto) > 2) desajustes.push(`${anio}: local=${local} remoto=${remoto}`);
    await sleep(300);
  }
  reportar(
    `Conteos por año de www (${anioMin}–${anioMax}, ${aniosRevisados} años)`,
    desajustes.length === 0,
    desajustes.length === 0 ? 'todos cuadran con la API (±2)' : desajustes.join(' · '),
  );

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
  const deWp = await contar((q) => q.eq('autor_confianza', 'wp'));
  const extraidos = await contar((q) => q.eq('autor_confianza', 'extraido'));
  const conAutor = deWp + extraidos;
  const pct = totalLocal > 0 ? Math.round((conAutor / totalLocal) * 100) : 0;
  reportar(
    'Artículos con autor',
    conAutor > 0,
    `${conAutor}/${totalLocal} (${pct}%) · ${deWp} de WordPress + ${extraidos} extraídos de la página`,
  );

  // 6. Ningún autor guardado en forma slug: "carlos-monsivais" en vez de
  //    "Carlos Monsiváis" significa que se guardó el dato crudo de la API.
  // Se paginan TODOS: PostgREST corta a 1000 y la vista viene ordenada por
  // volumen, así que revisar solo el primer tramo dejaría fuera la cola larga,
  // que es justo donde se escondería un nombre mal guardado.
  const filas: { autor: string }[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data } = await supabase
      .from('autores_conteo').select('autor').order('autor').range(desde, desde + 999);
    if (!data?.length) break;
    filas.push(...(data as { autor: string }[]));
    if (data.length < 1000) break;
  }
  if (filas.length === 0) {
    // Una vista vacía haría pasar esta prueba sin comprobar nada, que es peor
    // que no tenerla. Además el sidebar carga de aquí: vacía, carga en blanco.
    reportar(
      'Ningún autor en forma slug',
      false,
      'autores_conteo está VACÍA — falta aplicar supabase/migrations/0002 y refrescarla; el sidebar cargaría en blanco',
    );
  } else {
    const comoSlug = filas
      .map((r: { autor: string }) => r.autor)
      .filter((a) => /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(a));
    reportar(
      'Ningún autor en forma slug',
      comoSlug.length === 0,
      comoSlug.length === 0 ? `ninguno de ${filas.length} autores` : `${comoSlug.length}, p.ej. ${comoSlug.slice(0, 3).join(', ')}`,
    );
  }

  // 6b. El cuerpo de los subdominios se indexó (y NO se almacenó).
  //     Es la única prueba de que el buscador puede encontrar un artículo por
  //     lo que dice adentro; sin ella `ts` traería solo título y autores.
  const deSubdominios = await contar((q) => q.neq('sitio', 'www'));
  if (deSubdominios === 0) {
    console.log('SKIP  Índice de cuerpo — todavía no hay artículos de subdominios');
  } else {
    const sinIndice = await contar((q) => q.neq('sitio', 'www').is('ts', null));
    const sinCuerpo = Object.values(avance).reduce((n, e) => n + (e.sin_indexar ?? 0), 0);
    reportar(
      'Subdominios indexados',
      sinIndice === 0,
      `${deSubdominios - sinIndice}/${deSubdominios} con tsvector` +
        (sinCuerpo > 0 ? ` · ${sinCuerpo} sin cuerpo por JSON inválido del servidor` : ''),
    );

    // El cuerpo NO debe quedar legible en la base (CLAUDE.md sección 6).
    const conCuerpo = await contar((q) => q.not('cuerpo', 'is', null));
    reportar(
      'El cuerpo no se almacena',
      conCuerpo === 0,
      `${conCuerpo} artículos con la columna cuerpo llena`,
    );
  }

  // 6c. Ningún autor puede ser la cuenta del propio blog, ni dos firmas unidas
  //     en una sola. Las dos cosas pasaron de verdad: la primera pasada de
  //     recuperación sobre los subdominios guardó "Cultura Nexos" como si fuera
  //     una persona y creó una llamada "Sofia Marquez and Cultura Nexos".
  //     Un autor inventado es un incidente de credibilidad para Nexos
  //     (CLAUDE.md §7), así que se comprueba, no se confía.
  const nombresAutores = filas.map((r) => r.autor);
  if (nombresAutores.length > 0) {
    const institucionales = new Set<string>();
    if (existsSync(RUTA_FIRMAS)) {
      const bruto = JSON.parse(readFileSync(RUTA_FIRMAS, 'utf8')) as Record<string, { nombre: string }[]>;
      for (const cuentas of Object.values(bruto)) for (const c of cuentas) institucionales.add(c.nombre);
    }
    const colados = nombresAutores.filter((a) => institucionales.has(a));
    reportar(
      'Ninguna cuenta de blog como autor',
      colados.length === 0,
      institucionales.size === 0
        ? `sin ${RUTA_FIRMAS}: corre \`npm run firmas-sitio\``
        : colados.length === 0
          ? `ninguna de las ${institucionales.size} conocidas`
          : colados.join(', '),
    );

    // " and " en español no une dos firmas: si aparece, el bloque de autoría se
    // decodificó entero en vez de leer cada enlace por separado.
    const unidos = nombresAutores.filter((a) => /\s+and\s+/i.test(a));
    reportar(
      'Ningún autor con dos firmas unidas',
      unidos.length === 0,
      unidos.length === 0 ? 'ninguno' : `${unidos.length}, p.ej. ${unidos.slice(0, 3).join(' · ')}`,
    );
  }

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
