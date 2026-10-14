// Panorama sobre una lista de catálogo: "Todo lo que publicó Ángeles
// Mastretta" ya no abre con una sola frase de conteo, sino con un panorama de
// lo que hay —temas recurrentes, cómo cambian con los años, textos que lo
// representan—. Pedido del dueño.
//
// La lista sigue saliendo del WHERE de catálogo, sin modelo y paginada; esto
// solo agrega el texto de arriba. Cuidado con los créditos:
//   - Solo en la página 1 de una lista con al menos 3 textos.
//   - Se guarda en `sintesis_guardadas` (migración 0010) por los filtros que
//     lo produjeron y se reutiliza 30 días: repetir el clic cuesta cero.
//   - Lo que no está guardado cuenta contra el límite de 30 por hora; si ya
//     se llegó, se responde con la frase calculada de siempre.
//   - Una muestra de hasta PERFIL_MUESTRA fichas repartidas por todo el
//     periodo, no la obra completa.
//   - Si algo falla (modelo, tabla sin migrar), se queda la frase calculada:
//     la lista nunca depende del modelo.

import { PERFIL_MUESTRA } from '../config.ts';
import { bd } from '../bd.ts';
import { armarFichas } from '../fichas.ts';
import { hayModelo } from '../llm.ts';
import { COLUMNAS_ARTICULO, type FilaArticulo } from '../tipos.ts';
import { buscarArticulos, type FiltrosConsulta, type ResultadoCarril } from './comun.ts';
import { redactar } from './redaccion.ts';

const VIGENCIA_MS = 30 * 24 * 60 * 60 * 1000;
// Cambiar la versión invalida lo guardado (p. ej. al cambiar el prompt).
const VERSION = 'perfil:v3';

function claveDe(f: FiltrosConsulta): string {
  return `${VERSION}:${JSON.stringify({
    autores: [...f.autores].sort(),
    seccion: f.seccion ?? null,
    rango_pub: f.rango_pub ?? null,
    anios_referidos: [...f.anios_referidos].sort(),
    texto: f.texto?.trim().toLowerCase() || null,
  })}`;
}

/** Fichas repartidas por todo el periodo: la lista va de la más nueva a la
 *  más vieja, así que se toman tramos a lo largo de ella. */
async function muestra(f: FiltrosConsulta, total: number): Promise<FilaArticulo[]> {
  if (total <= PERFIL_MUESTRA) {
    return (await buscarArticulos(f, { limite: total, conTotal: false })).filas;
  }
  const tramos = 6;
  const porTramo = Math.floor(PERFIL_MUESTRA / tramos);
  const paso = Math.floor(total / tramos);
  const partes = await Promise.all(
    Array.from({ length: tramos }, (_, i) =>
      buscarArticulos(f, { desde: i * paso, limite: porTramo, conTotal: false }).then((r) => r.filas)
    ),
  );
  return partes.flat();
}

async function fichasPorId(ids: number[]): Promise<FilaArticulo[]> {
  if (ids.length === 0) return [];
  const { data, error } = await bd().from('articulos').select(COLUMNAS_ARTICULO).in('id', ids);
  if (error) throw error;
  const porId = new Map((data as FilaArticulo[]).map((f) => [Number(f.id), f]));
  return ids.map((id) => porId.get(id)).filter((f): f is FilaArticulo => Boolean(f));
}

export interface ResultadoConPerfil {
  resultado: ResultadoCarril;
  /** true si se llamó al modelo (no estaba guardado): cuenta para el límite. */
  usoModelo: boolean;
}

export async function conPerfil(
  res: ResultadoCarril,
  verificarLimite: () => Promise<void>,
): Promise<ResultadoConPerfil> {
  const sinCambio = { resultado: res, usoModelo: false };
  if (res.modo !== 'catalogo' || res.pagina !== 1 || res.aproximados || res.total < 3 || !res.sintesis) {
    return sinCambio;
  }
  const f = res.filtros;
  const clave = claveDe(f);
  const t0 = performance.now();
  const frase = res.sintesis.texto;

  // 1. ¿Ya estaba redactado?
  try {
    const { data } = await bd()
      .from('sintesis_guardadas')
      .select('texto,articulo_ids,modelo,creada_en')
      .eq('clave', clave)
      .maybeSingle();
    const g = data as { texto: string; articulo_ids: number[]; modelo: string; creada_en: string } | null;
    if (g && Date.now() - Date.parse(g.creada_en) < VIGENCIA_MS) {
      const citadas = armarFichas(await fichasPorId(g.articulo_ids.map(Number)));
      return {
        usoModelo: false,
        resultado: {
          ...res,
          sintesis: { ...res.sintesis, texto: g.texto, modelo: g.modelo },
          citadas,
          pasos: [...res.pasos, {
            paso: 'sintesis',
            titulo: 'Usó el panorama que ya había redactado',
            detalle: `${g.modelo} · guardado el ${g.creada_en.slice(0, 10)} · sin costo`,
            ms: Math.round(performance.now() - t0),
          }],
        },
      };
    }
  } catch {
    // Sin la tabla (0010 sin aplicar) se redacta igual, solo que sin guardar.
  }

  if (!hayModelo()) return sinCambio;
  try {
    await verificarLimite();
  } catch {
    return sinCambio; // límite alcanzado: la frase calculada basta
  }

  // 2. Redactarlo.
  try {
    const filas = await muestra(f, res.total);
    // Sin decirle que es una muestra: lo repetía en la respuesta ("la muestra
    // de 240…"), y al editor eso no le sirve. La cifra real va en la frase.
    const pregunta = `Panorama de este conjunto del archivo. Cifra y periodo reales, ya calculados: ${frase}`;
    const r = await redactar('perfil', pregunta, filas, 12);
    if (r.articulo_ids.length === 0) return sinCambio;

    const texto = r.texto;
    void bd().from('sintesis_guardadas')
      .upsert({ clave, texto, articulo_ids: r.articulo_ids, modelo: r.modelo, creada_en: new Date().toISOString() })
      .then(({ error }) => error && console.warn('[perfil] no se guardó el panorama:', error.message));

    const porId = new Map(filas.map((x) => [Number(x.id), x]));
    const citadas = armarFichas(
      r.articulo_ids.map((id) => porId.get(id)).filter((x): x is FilaArticulo => Boolean(x)),
    );
    return {
      usoModelo: true,
      resultado: {
        ...res,
        sintesis: { ...res.sintesis, texto, modelo: r.modelo, fichas_consideradas: filas.length },
        citadas,
        pasos: [...res.pasos, {
          paso: 'sintesis',
          titulo: `Leyó ${filas.length} fichas y redactó un panorama`,
          detalle: `${r.modelo} · una sola llamada · se guarda 30 días`,
          ms: Math.round(performance.now() - t0),
        }],
      },
    };
  } catch (e) {
    return {
      usoModelo: true,
      resultado: {
        ...res,
        pasos: [...res.pasos, {
          paso: 'sintesis',
          titulo: 'No se pudo redactar el panorama; se muestra el resumen calculado',
          detalle: e instanceof Error ? e.message : String(e),
          ms: Math.round(performance.now() - t0),
        }],
      },
    };
  }
}
