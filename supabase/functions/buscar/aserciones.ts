// Las tres aserciones que usan las pruebas, sobre `node:assert` de Deno.
//
// Antes venían de `jsr:@std/assert`, que hay que descargar. Una suite que no
// corre sin red no se corre: en este proyecto jsr.io está bloqueado por política
// de salida y `deno test` fallaba antes de ejecutar una sola prueba. `node:assert`
// viene dentro de Deno, así que las pruebas corren en cualquier parte y sin
// bajar nada.
import { deepStrictEqual, ok, throws } from 'node:assert';

export function assert(condicion: unknown, mensaje?: string): asserts condicion {
  ok(condicion, mensaje);
}

export function assertEquals<T>(real: T, esperado: T, mensaje?: string): void {
  deepStrictEqual(real, esperado, mensaje);
}

export function assertThrows(fn: () => unknown, mensaje?: string): void {
  throws(fn, mensaje);
}
