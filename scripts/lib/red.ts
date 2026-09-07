// El `fetch` global de Node (undici) no lee HTTP_PROXY/HTTPS_PROXY, a
// diferencia de curl. En entornos con proxy de salida obligatorio eso hace que
// todas las peticiones fallen con 403 sin explicación aparente.
//
// EnvHttpProxyAgent sí lee esas variables (y NO_PROXY). Si no hay proxy
// configurado, se comporta como el dispatcher normal, así que esto es
// inofensivo al correr en local.
//
// Importar este módulo antes de cualquier fetch.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new EnvHttpProxyAgent());

export const proxyConfigurado = Boolean(
  process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy,
);
