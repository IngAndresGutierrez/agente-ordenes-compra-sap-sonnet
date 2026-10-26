// Las mismas herramientas que usa la aplicación (re-export, no una copia).
// Cada export se registra como oc_<export>; execute(args, { directory, sessionId }) nunca lanza.
export * from "../../src/tools/oc.ts"
