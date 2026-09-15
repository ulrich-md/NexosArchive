// npm run indexar-impreso — mete al índice de búsqueda el texto de los
// artículos cuyo cuerpo tenemos en las exportaciones WXR.
//
// Por qué hace falta: la ingesta de subdominios manda el cuerpo a
// `indexar_articulos` y lo descarta, así que esos artículos se encuentran por
// lo que dicen adentro. El enriquecimiento no hacía eso: leía el cuerpo, sacaba
// el resumen y lo tiraba sin indexar. Resultado medido — el artículo de 1994
// cuyo resumen dice "trayectoria literaria de Sergio Pitol" devolvía 0
// resultados al buscar "Sergio Pitol".
//
// Pega justo donde más importa: los artículos que el paywall tapa no tienen
// cuerpo en el índice, y sin sesión el carril `catalogo` —el que usa ese
// índice— es el único disponible.
//
// Al índice va el cuerpo MÁS el resumen y los temas, porque el resumen nombra
// cosas que el texto puede no decir con esas palabras. El cuerpo sigue sin
// almacenarse: entra a la función, se convierte en lexemas y muere ahí
// (CLAUDE.md §6).
import './lib/red.js';
import 'dotenv/config';
import { clienteSupabase } from './lib/supabase.js';
import { cargarCuerposXml } from './lib/cuerpos-xml.js';

const LOTE = 50;
const SECO = process.argv.includes('--seco');

const sb = clienteSupabase();
// Sin recorte: al índice va el artículo entero, no los 3,000 caracteres que
// alcanzan para un resumen.
const cuerpos = cargarCuerposXml('datos/exports', 200_000);
console.log(`Cuerpos disponibles en los XML: ${cuerpos.size}\n`);

let indexados = 0;
let sinCuerpo = 0;
for (let desde = 0; ; desde += 1000) {
  const { data, error } = await sb
    .from('articulos').select('id,id_wp,resumen_linea,temas')
    .eq('sitio', 'www').order('id').range(desde, desde + 999);
  if (error) throw new Error(error.message);
  if (!data?.length) break;

  const filas: { id: number; cuerpo: string }[] = [];
  for (const a of data as { id: number; id_wp: number; resumen_linea: string | null; temas: string[] }[]) {
    const cuerpo = cuerpos.get(a.id_wp);
    if (!cuerpo) { sinCuerpo++; continue; }
    filas.push({
      id: a.id,
      cuerpo: `${cuerpo} ${a.resumen_linea ?? ''} ${(a.temas ?? []).join(' ')}`,
    });
  }

  if (!SECO) {
    for (let i = 0; i < filas.length; i += LOTE) {
      const { error: e } = await sb.rpc('indexar_articulos', { p_filas: filas.slice(i, i + LOTE) });
      if (e) throw new Error(`indexando: ${e.message}`);
    }
  }
  indexados += filas.length;
  if (data.length < 1000) break;
  process.stdout.write(`\r  indexados ${indexados}...`);
}

console.log(`\n\nIndexados con su texto completo: ${indexados}`);
console.log(`Sin cuerpo en los XML (siguen solo con título): ${sinCuerpo}`);
