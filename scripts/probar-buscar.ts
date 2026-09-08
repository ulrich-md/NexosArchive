// npm run probar-buscar — prueba de aceptación contra la Edge Function
// DESPLEGADA, con los datos reales. Comprueba lo que las pruebas unitarias de
// Deno no pueden: que el carril elegido sea el correcto, que los resultados
// sean del autor que se pidió, y el criterio de la sección 1 de CLAUDE.md —las
// consultas de ejemplo de la home responden en menos de 5 s—.
//
// Se lee a ojo a propósito: no falla ni pasa, imprime lo que devolvió el
// archivo para que alguien lo mire. Un buscador editorial se juzga leyendo los
// resultados, no contando filas.
import './lib/red.js';
import 'dotenv/config';

const URL = `${process.env.SUPABASE_URL}/functions/v1/buscar`;
const LLAVE = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

const CONSULTAS: { pregunta: string; modo?: string }[] = [
  { pregunta: 'Todo lo que publicó Ángeles Mastretta en los noventa' },
  { pregunta: 'Artículos de 1988 sobre fraude electoral' },
  { pregunta: '¿Qué se ha escrito en Nexos sobre el 2006?' },
  { pregunta: 'Todo lo de Aguilar Camín en los noventa' },
  { pregunta: 'Aguilar Camín' },
];

for (const c of CONSULTAS) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: LLAVE, Authorization: `Bearer ${LLAVE}` },
    body: JSON.stringify(c),
  }).catch((e) => { console.log('RED:', e.message); return null; });
  const ms = Date.now() - t0;
  if (!res) continue;

  const cuerpo = await res.json().catch(() => null) as any;
  console.log(`\n=== ${c.pregunta}${c.modo ? `  [modo ${c.modo}]` : ''}`);
  console.log(`HTTP ${res.status} · ${ms} ms`);
  if (!res.ok || cuerpo?.error) {
    console.log('  error:', JSON.stringify(cuerpo).slice(0, 400));
    continue;
  }
  console.log(`  modo=${cuerpo.modo} total=${cuerpo.total} resultados=${cuerpo.resultados?.length ?? 0} aproximados=${cuerpo.aproximados ?? false}`);
  if (cuerpo.sugerencia) console.log(`  sugerencia: ${JSON.stringify(cuerpo.sugerencia)}`);
  if (cuerpo.degradado) console.log(`  degradado: ${JSON.stringify(cuerpo.degradado)}`);
  for (const a of (cuerpo.avisos ?? [])) console.log(`  aviso: ${a.codigo ?? a}`);
  if (cuerpo.sintesis?.texto) console.log(`  síntesis: ${cuerpo.sintesis.texto.slice(0, 200)}`);
  for (const f of (cuerpo.resultados ?? []).slice(0, 3)) {
    console.log(`  - ${f.titulo}  · ${f.autor_etiqueta} · ${f.fecha_pub}`);
  }
}
