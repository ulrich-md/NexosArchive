// Los 27 WordPress de Nexos.
//
// El archivo no vive en un solo sitio: además de www.nexos.com.mx hay 26
// subdominios, cada uno con su propia instalación y su propia API. Verificado
// el 2026-09-08: 19,145 + 14,479 = 33,624 artículos.
//
// Cada sitio tiene su propio espacio de ids de WordPress, así que la identidad
// de un artículo es (sitio, id_wp). Para no perder el vínculo con WordPress ni
// inventar ids opacos, el id de la base es `base + id_wp`: determinista,
// reversible y estable entre corridas, que es lo que necesita el upsert.
//
// A `www` le toca base 0, así que las filas ya cargadas conservan su id.

export interface Sitio {
  /** Subdominio, o 'www'. Es la mitad de la identidad del artículo. */
  clave: string;
  /** Se suma al id de WordPress. Múltiplo de mil millones: los ids de WP están muy por debajo. */
  base: number;
  /** Artículos que reportó X-WP-Total el 2026-09-08, para reconciliar. */
  esperados: number;
}

export const SITIOS: Sitio[] = [
  { clave: 'www', base: 0, esperados: 19145 },
  { clave: 'cultura', base: 1_000_000_000, esperados: 4216 },
  { clave: 'redaccion', base: 2_000_000_000, esperados: 2129 },
  { clave: 'eljuegodelacorte', base: 3_000_000_000, esperados: 2098 },
  { clave: 'poemas', base: 4_000_000_000, esperados: 996 },
  { clave: 'educacion', base: 5_000_000_000, esperados: 617 },
  { clave: 'jorgegcastaneda', base: 6_000_000_000, esperados: 563 },
  { clave: 'angelesmastretta', base: 7_000_000_000, esperados: 557 },
  { clave: 'economia', base: 8_000_000_000, esperados: 522 },
  { clave: 'seguridad', base: 9_000_000_000, esperados: 455 },
  { clave: 'josewoldenberg', base: 10_000_000_000, esperados: 449 },
  { clave: 'anticorrupcion', base: 11_000_000_000, esperados: 426 },
  { clave: 'aguilarcamin', base: 12_000_000_000, esperados: 342 },
  { clave: 'federalismo', base: 13_000_000_000, esperados: 331 },
  { clave: 'ciencia', base: 14_000_000_000, esperados: 262 },
  { clave: 'bioetica', base: 15_000_000_000, esperados: 183 },
  { clave: 'trejodelarbre', base: 16_000_000_000, esperados: 102 },
  { clave: 'soledadloaeza', base: 17_000_000_000, esperados: 55 },
  { clave: 'fernandoescalante', base: 18_000_000_000, esperados: 42 },
  { clave: 'rubenaguilar', base: 19_000_000_000, esperados: 40 },
  { clave: 'salud', base: 20_000_000_000, esperados: 25 },
  { clave: 'gomeztamez', base: 21_000_000_000, esperados: 18 },
  { clave: 'mariaamparocasar', base: 22_000_000_000, esperados: 18 },
  { clave: 'gastronomia', base: 23_000_000_000, esperados: 15 },
  { clave: 'eduardoguerrero', base: 24_000_000_000, esperados: 9 },
  { clave: 'historia', base: 25_000_000_000, esperados: 5 },
  { clave: 'ficcion', base: 26_000_000_000, esperados: 4 },
];

export const SUBDOMINIOS = SITIOS.filter((s) => s.clave !== 'www');

export function urlApi(sitio: Sitio): string {
  const host = sitio.clave === 'www' ? 'www.nexos.com.mx' : `${sitio.clave}.nexos.com.mx`;
  return `https://${host}/wp-json/wp/v2`;
}

export function idDeBase(sitio: Sitio, idWp: number): number {
  return sitio.base + idWp;
}

/**
 * Clave de deduplicación entre instalaciones distintas. Los ids no sirven
 * (cada WordPress tiene los suyos), así que se compara el título normalizado:
 * es lo único común. Los subdominios republican parte del sitio principal en
 * proporción muy desigual — angelesmastretta repite el 83%, aguilarcamin nada.
 */
export function claveTitulo(titulo: string): string {
  return titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
