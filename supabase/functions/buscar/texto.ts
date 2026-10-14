// Utilidades de texto puras (sin red, sin base de datos): normalización de
// nombres, lectura de años y décadas en la pregunta, y saneado de todo lo que
// devuelve un LLM. Están aisladas aquí para poder probarlas sin datos
// (`deno test supabase/functions/buscar/pruebas.test.ts`).

import { ANIO_MAX, ANIO_MIN } from './config.ts';

/**
 * Normaliza para comparar nombres: sin acentos, minúsculas, sin puntuación.
 * Los nombres de autor de la API de Nexos vienen sin acentos y los reales sí
 * los traen (CLAUDE.md sección 2), así que comparar sin acentos es obligatorio.
 */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  return normalizar(s).split(' ').filter((t) => t.length > 0);
}

/** Palabras vacías del español que no aportan al emparejamiento de nombres. */
const VACIAS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'que', 'sobre',
  'todo', 'toda', 'todos', 'todas', 'lo', 'un', 'una', 'unos', 'unas', 'por',
  'para', 'con', 'se', 'ha', 'han', 'su', 'sus', 'me', 'mi', 'nos', 'al',
  'articulos', 'articulo', 'textos', 'texto', 'nexos', 'revista', 'archivo',
  'publico', 'publicado', 'publicados', 'escrito', 'escribio', 'dame',
  'muestrame', 'lista', 'listado', 'quiero', 'ver', 'busca', 'buscar',
  // Verbos y muletillas de pregunta: sin esto, "¿qué ha dicho Mastretta sobre
  // comida?" buscaba también «dicho», que aparece en medio archivo.
  'dicho', 'dijo', 'hablado', 'hablo', 'habla', 'opinado', 'opina', 'piensa',
  'pensado', 'comentado', 'escribe', 'escriben', 'escribir', 'publica',
  'acerca', 'respecto', 'cosas', 'algo', 'hay', 'cual', 'cuales', 'como',
  'donde', 'cuando', 'sido', 'fue', 'era', 'tiene', 'tienen', 'mas', 'muy',
  'tema', 'temas', 'esta', 'este', 'estos', 'estas', 'puedes', 'podrias',
  // "¿Cuántos artículos ha escrito Mastretta?" es un conteo de su obra (el
  // resumen del catálogo ya trae la cifra), no una búsqueda de «cuántos».
  'cuantos', 'cuantas', 'numero', 'cantidad', 'total', 'escritos', 'obra',
  'obras', 'columnas', 'colaboraciones', 'publicaciones',
]);

export function esVacia(t: string): boolean {
  return VACIAS.has(t);
}

const DECADAS: Array<{ patron: RegExp; desde: number; hasta: number }> = [
  { patron: /\b(los\s+)?setentas?\b/, desde: 1970, hasta: 1979 },
  { patron: /\b(los\s+)?ochentas?\b/, desde: 1980, hasta: 1989 },
  { patron: /\b(los\s+)?noventas?\b/, desde: 1990, hasta: 1999 },
  { patron: /\b(los\s+)?(dos\s*miles?|2000s)\b/, desde: 2000, hasta: 2009 },
  { patron: /\bdecada\s+de\s+(los\s+)?setenta\b/, desde: 1970, hasta: 1979 },
  { patron: /\bdecada\s+de\s+(los\s+)?ochenta\b/, desde: 1980, hasta: 1989 },
  { patron: /\bdecada\s+de\s+(los\s+)?noventa\b/, desde: 1990, hasta: 1999 },
  { patron: /\b(los|anos)\s+(70|70s)\b/, desde: 1970, hasta: 1979 },
  { patron: /\b(los|anos)\s+(80|80s)\b/, desde: 1980, hasta: 1989 },
  { patron: /\b(los|anos)\s+(90|90s)\b/, desde: 1990, hasta: 1999 },
];

export interface RangoAnios {
  desde: number;
  hasta: number;
}

/** Años sueltos mencionados en la pregunta, acotados al rango real del archivo. */
export function aniosMencionados(pregunta: string): number[] {
  const encontrados = new Set<number>();
  for (const m of pregunta.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
    const n = Number.parseInt(m[1], 10);
    if (n >= ANIO_MIN && n <= ANIO_MAX) encontrados.add(n);
  }
  return [...encontrados].sort((a, b) => a - b);
}

const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

/**
 * "El 68", "del 85", "año 94": el año con dos cifras, como se dice en México.
 * Solo tras un artículo o "año", y nunca si sigue un mes ("el 10 de octubre"),
 * un porcentaje o una cantidad ("el 30 por ciento", "el 20 mil").
 */
const PATRON_ANIO_CORTO = new RegExp(
  `\\b(?:el|del|al|ano|anos|generacion del|movimiento del)\\s+(\\d{2})\\b` +
    `(?!\\s+(?:de\\s+(?:${MESES})|por ciento|porciento|mil|millones|anos|textos|articulos|paginas|veces|personas))`,
  'g',
);

/**
 * Años de los que HABLA un texto (`anios_referidos`), no de cuándo se publicó.
 * A diferencia de `aniosMencionados`, no empiezan en 1978: "¿qué se ha escrito
 * sobre el 68?" pregunta por 1968, y Nexos lo ha tratado muchas veces. Medido
 * (2026-10-14): "el 68" no se reconocía y la pregunta llegaba sin ningún
 * filtro; el modelo recibía 400 fichas al azar y respondía con textos que "no
 * son sobre el 68".
 */
export function aniosReferidosMencionados(pregunta: string): number[] {
  const encontrados = new Set<number>();
  for (const m of pregunta.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
    const n = Number.parseInt(m[1], 10);
    if (n >= 1800 && n <= ANIO_MAX) encontrados.add(n);
  }
  const corte = ANIO_MAX % 100;
  for (const m of normalizar(pregunta).matchAll(PATRON_ANIO_CORTO)) {
    const nn = Number.parseInt(m[1], 10);
    encontrados.add(nn > corte ? 1900 + nn : 2000 + nn);
  }
  return [...encontrados].sort((a, b) => a - b);
}

/** Como `rangoPublicacion`, pero con los años de los que trata el texto. */
export function rangoReferido(pregunta: string): RangoAnios | null {
  const candidatos: RangoAnios[] = [
    ...decadasMencionadas(pregunta),
    ...aniosReferidosMencionados(pregunta).map((a) => ({ desde: a, hasta: a })),
  ];
  if (candidatos.length === 0) return null;
  return {
    desde: Math.min(...candidatos.map((c) => c.desde)),
    hasta: Math.max(...candidatos.map((c) => c.hasta)),
  };
}

/**
 * Décadas escritas con palabras ("los noventa", "años 80").
 * Se evalúan sobre el texto normalizado (sin acentos), por eso los patrones
 * de arriba dicen `decada` y `anos`.
 */
export function decadasMencionadas(pregunta: string): RangoAnios[] {
  const texto = normalizar(pregunta);
  const rangos: RangoAnios[] = [];
  for (const d of DECADAS) {
    if (d.patron.test(texto) && !rangos.some((r) => r.desde === d.desde)) {
      rangos.push({ desde: d.desde, hasta: d.hasta });
    }
  }
  return rangos;
}

/**
 * Rango de años de publicación que se deduce de la pregunta.
 * Devuelve null si no hay ninguno: ante la duda NO se acota la publicación
 * (CLAUDE.md sección 4, "Dos nociones de año que NO son lo mismo").
 */
export function rangoPublicacion(pregunta: string): RangoAnios | null {
  const decadas = decadasMencionadas(pregunta);
  const anios = aniosMencionados(pregunta);
  const candidatos: RangoAnios[] = [
    ...decadas,
    ...anios.map((a) => ({ desde: a, hasta: a })),
  ];
  if (candidatos.length === 0) return null;
  return {
    desde: Math.min(...candidatos.map((c) => c.desde)),
    hasta: Math.max(...candidatos.map((c) => c.hasta)),
  };
}

/** Expande un rango a la lista de años (para `anios_referidos && '{...}'`). */
export function expandirRango(r: RangoAnios): number[] {
  const salida: number[] = [];
  for (let a = r.desde; a <= r.hasta && salida.length < 120; a++) salida.push(a);
  return salida;
}

/**
 * Quita de la pregunta lo que ya se convirtió en filtro duro (años, décadas,
 * nombre de autor, muletillas) y deja lo que puede servir como tema.
 */
export function temaResidual(pregunta: string, autores: string[]): string {
  let t = normalizar(pregunta);
  for (const autor of autores) {
    for (const tk of tokens(autor)) t = t.replaceAll(tk, ' ');
  }
  t = t.replace(/\b(1[89]\d{2}|20\d{2})\b/g, ' ');
  t = t.replace(PATRON_ANIO_CORTO, ' ');
  for (const d of DECADAS) t = t.replace(d.patron, ' ');
  const palabras = t.split(/\s+/).filter((p) => p.length > 2 && !esVacia(p));
  return palabras.join(' ').trim();
}

/**
 * Todo texto que devuelve un LLM pasa por aquí antes de salir a la UI:
 * sin etiquetas (nunca se renderiza HTML del modelo, CLAUDE.md sección 6),
 * sin caracteres de control, con largo acotado.
 */
export function sanearTextoModelo(s: unknown, maxLargo = 1_200): string {
  if (typeof s !== 'string') return '';
  const limpio = s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > maxLargo ? `${limpio.slice(0, maxLargo - 1).trimEnd()}…` : limpio;
}

/**
 * Señales baratas de que la pregunta depende de la anterior para entenderse
 * (pronombres, continuadores: "¿y en 2010?", "de esos, cuáles son de
 * mujeres", "también muéstrame los de economía"). Es una compuerta antes de
 * gastar una llamada a Gemini en reescribirla: la mayoría de las preguntas en
 * una conversación son NUEVAS e independientes, y pagar ese viaje en cada una
 * rompería la promesa de <100ms de catálogo (CLAUDE.md sección 4). Un falso
 * negativo (no detectar un seguimiento real) no es una regresión: hoy ninguna
 * pregunta usa contexto previo, así que como mucho se queda igual.
 */
const PATRON_SEGUIMIENTO = new RegExp(
  [
    // Arranques que solo tienen sentido continuando algo.
    '^(y|e|pero|entonces|bueno|tambien|ademas|ahora|igual|otros|otras)\\b',
    '^(de|sobre) (esos|esas|ese|esa|eso|estos|estas|ello)\\b',
    '^(lo mismo|mas de|mas sobre|solo (los|las|el|la)|nada mas (los|las))\\b',
    // Pedir más de lo que ya se respondió.
    '^(profundiza|amplia|resume|resumeme|explica|explicame|cuentame mas|dime mas|dame mas)\\b',
    '\\b(cual|cuales) de (ellos|ellas|esos|esas|estos|estas)\\b',
    '\\b(el|la) (primero|primera|segundo|segunda|tercero|tercera|ultimo|ultima)\\b',
    // Pronombres que apuntan a la respuesta anterior.
    '\\b(esos|esas|ellos|ellas|ella|aquello|aquellos|dichos)\\b',
  ].join('|'),
);

export function detectaSeguimiento(pregunta: string): boolean {
  const texto = normalizar(pregunta);
  return texto.length > 0 && PATRON_SEGUIMIENTO.test(texto);
}

/**
 * Como `sanearTextoModelo`, pero conserva los párrafos (doble salto de línea):
 * la interfaz corta la respuesta en párrafos por ahí (TextoRespuesta.tsx).
 */
export function sanearParrafos(s: unknown, maxLargo = 3_500): string {
  if (typeof s !== 'string') return '';
  const parrafos = s
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    // Se trunca una sola vez, abajo, sobre el total.
    .map((p) => sanearTextoModelo(p, Number.MAX_SAFE_INTEGER))
    .filter((p) => p !== '');
  let salida = parrafos.join('\n\n');
  if (salida.length > maxLargo) {
    // Sin dejar una marca de cita cortada a la mitad ("[id:12"), que la
    // interfaz pintaría como texto.
    salida = `${salida.slice(0, maxLargo - 1).replace(/\[[^\]]*$/, '').trimEnd()}…`;
  }
  return salida;
}

/** Un texto del modelo con URLs es sospechoso: el modelo no escribe ligas. */
export function contieneLiga(s: string): boolean {
  return /https?:\/\//i.test(s) || /www\./i.test(s) || /nexos\.com\.mx/i.test(s);
}

/**
 * Escapa el texto del archivo antes de meterlo en el prompt. El contenido del
 * archivo es DATO, nunca instrucción (CLAUDE.md sección 6): si un título
 * trajera algo que parezca una etiqueta, no debe poder cerrar el bloque.
 */
export function escaparParaPrompt(s: string): string {
  return s.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}

// --- Charla: lo que no es una búsqueda --------------------------------------
//
// "Hola" se buscaba como tema y encontraba artículos con "hola" en el título;
// "¿qué puedes hacer?" devolvía artículos aproximados. Un saludo, un gracias
// o una pregunta sobre el buscador se contestan como tal, sin tocar el archivo
// ni gastar el modelo.

export type Charla = 'saludo' | 'gracias' | 'ayuda';

const CHARLA: Array<{ tipo: Charla; patron: RegExp }> = [
  {
    tipo: 'saludo',
    patron:
      /^(hola|holi|hey|saludos|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|que onda)( (que tal|como estas|como vas|como te va|a todos))*$/,
  },
  {
    tipo: 'gracias',
    patron:
      /^((muchas|mil|muchisimas) )?gracias( (por todo|por la ayuda|eh|de nuevo))?$|^(perfecto|excelente|genial|ok|okay|vale|listo|muy bien|de acuerdo|entendido|super|sale|va|chido|padre)( gracias)?$/,
  },
  {
    tipo: 'ayuda',
    patron: new RegExp(
      '^(ayuda|help|instrucciones|' +
        'que (puedes|sabes) hacer|que haces|que eres|quien eres|que es esto|para que sirves|' +
        'como (funciona|funcionas|te uso|se usa|busco|pregunto|te pregunto)|' +
        'que (puedo|se puede) (preguntar|preguntarte|buscar|hacer)|que hay en el archivo|' +
        'cuantos (articulos|textos) (hay|tiene|tienes|tiene el archivo)( en el archivo)?)$',
    ),
  },
];

export function detectarCharla(pregunta: string): Charla | null {
  const t = normalizar(pregunta);
  if (t === '') return 'saludo';
  for (const c of CHARLA) if (c.patron.test(t)) return c.tipo;
  return null;
}

/**
 * Quita la cortesía del principio ("Hola, ¿me puedes decir qué escribió…"):
 * es natural escribirla y no es parte de lo que se busca. Sin esto, «hola» y
 * «decir» entraban como palabras del tema.
 */
export function quitarCortesia(pregunta: string): string {
  const CORTESIA =
    /^[\s¿¡,.;:!?]*(hola|holi|hey|buen[oa]s(\s+(d[ií]as|tardes|noches))?|buen\s+d[ií]a|oye|oiga|disculpa|disculpe|perd[oó]n|por\s+favor|gracias|qu[eé]\s+tal|me\s+(puedes|podr[ií]as|puede|podr[ií]a)\s+(decir|mostrar|dar|buscar|ense[nñ]ar|ayudar\s+a\s+encontrar)|(quisiera|quiero|necesito)\s+saber|ay[uú]dame\s+a\s+(encontrar|buscar))\b[\s,;:!.?]*/i;
  let actual = pregunta;
  for (let i = 0; i < 4; i++) {
    const siguiente = actual.replace(CORTESIA, '');
    if (siguiente === actual) break;
    actual = siguiente;
  }
  actual = actual.trim();
  // Si solo había cortesía, se conserva tal cual: eso lo resuelve la charla.
  return actual === '' ? pregunta.trim() : actual;
}
