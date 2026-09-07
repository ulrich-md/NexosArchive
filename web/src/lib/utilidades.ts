import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...entradas: ClassValue[]) {
  return twMerge(clsx(entradas));
}

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** `1988-01-15` → `15 enero 1988`. Si la fecha viene rara, se devuelve tal cual. */
export function formatearFecha(iso: string): string {
  const [anio, mes, dia] = iso.split('-');
  const nombreMes = MESES[Number(mes) - 1];
  if (!anio || !mes || !dia || !nombreMes) return iso;
  return `${Number(dia)} ${nombreMes} ${anio}`;
}

/** Saludo según la hora local (sección 3). */
export function saludo(fecha = new Date()): string {
  const h = fecha.getHours();
  if (h < 12) return 'Buenos días';
  if (h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Miles con coma, como el subtítulo de la referencia: `19,145`. */
export function conMiles(n: number): string {
  return n.toLocaleString('en-US');
}

/** Búsqueda de esa misma pregunta en el sitio público, como escape honesto. */
export function urlBusquedaNexos(termino: string): string {
  return `https://www.nexos.com.mx/?s=${encodeURIComponent(termino)}`;
}
