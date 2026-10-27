// Lee UN campo de texto de un objeto JSON mientras el modelo lo va
// escribiendo, para enseñar la respuesta conforme se redacta.
//
// La redacción llega como JSON con esquema (`{"texto": "…", "articulo_ids":
// […]}`), así que lo que se transmite son pedazos de JSON, no de texto: hay
// que encontrar la llave, quitar las comillas y deshacer los escapes (\n, \",
// á…), que pueden quedar partidos entre dos pedazos. Lo que no sea ese
// campo se ignora. La respuesta definitiva sigue saliendo del JSON completo y
// validado; esto es solo la vista previa.

export class LectorCampoJson {
  private buffer = '';
  private estado: 'buscando' | 'dentro' | 'fin' = 'buscando';
  private escape = '';
  private readonly llave: string;

  constructor(campo: string) {
    this.llave = `"${campo}"`;
  }

  /** Recibe el siguiente pedazo de JSON crudo; devuelve el texto nuevo del campo. */
  agregar(pedazo: string): string {
    if (this.estado === 'fin') return '';
    let entrada = pedazo;
    if (this.estado === 'buscando') {
      this.buffer += pedazo;
      const m = this.buffer.match(new RegExp(`${this.llave}\\s*:\\s*"`));
      if (!m || m.index === undefined) {
        // Basta conservar la cola por si la llave quedó partida.
        if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-256);
        return '';
      }
      entrada = this.buffer.slice(m.index + m[0].length);
      this.buffer = '';
      this.estado = 'dentro';
    }

    let salida = '';
    for (const ch of entrada) {
      if (this.escape) {
        this.escape += ch;
        if (this.escape.startsWith('\\u')) {
          if (this.escape.length < 6) continue;
          const codigo = Number.parseInt(this.escape.slice(2), 16);
          salida += Number.isNaN(codigo) ? '' : String.fromCharCode(codigo);
        } else {
          const mapa: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };
          salida += mapa[ch] ?? ch;
        }
        this.escape = '';
        continue;
      }
      if (ch === '\\') {
        this.escape = '\\';
        continue;
      }
      if (ch === '"') {
        this.estado = 'fin';
        break;
      }
      salida += ch;
    }
    return salida;
  }
}
