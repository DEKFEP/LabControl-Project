const CABECERAS_SALTAR = new Set([
  "host",
  "content-length",
  "content-encoding",
  "set-cookie",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "cf-colo",
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-lc-client-ip",
  "x-lc-proxy-secret"
]);

function limpio(headers) {
  const salida = new Headers();
  for (const [clave, valor] of headers.entries()) {
    if (CABECERAS_SALTAR.has(clave.toLowerCase())) continue;
    salida.append(clave, valor);
  }
  return salida;
}

function ipReal(headers) {
  return headers.get("cf-connecting-ip") || "";
}

function copiarCookies(respuesta, destino) {
  const cookies = typeof respuesta.headers.getSetCookie === "function"
    ? respuesta.headers.getSetCookie()
    : (respuesta.headers.get("set-cookie") ? [respuesta.headers.get("set-cookie")] : []);
  for (const cookie of cookies) destino.append("set-cookie", cookie);
}

export async function onRequest(context) {
  const { request, env } = context;
  const origen = (env.API_ORIGIN || "").trim().replace(/\/+$/, "");

  if (!origen) {
    return new Response(
      JSON.stringify({ error: "API_ORIGIN no esta definido en este proyecto de Pages." }),
      { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  const url = new URL(request.url);
  const destino = `${origen}${url.pathname}${url.search}`;

  const cabecerasPeticion = limpio(request.headers);
  const ip = ipReal(request.headers);
  if (ip) cabecerasPeticion.set("x-forwarded-for", ip);
  const secreto = (env.LC_PROXY_SECRET || "").trim();
  if (ip && secreto) {
    cabecerasPeticion.set("x-lc-client-ip", ip);
    cabecerasPeticion.set("x-lc-proxy-secret", secreto);
  }
  cabecerasPeticion.set("x-forwarded-proto", url.protocol.replace(":", ""));

  let respuesta;
  try {
    respuesta = await fetch(destino, {
      method: request.method,
      headers: cabecerasPeticion,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual"
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "No se pudo contactar con el servidor de la API." }),
      { status: 502, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  const cabeceras = limpio(respuesta.headers);
  cabeceras.set("Cache-Control", respuesta.headers.get("Cache-Control") || "no-store");
  copiarCookies(respuesta, cabeceras);

  return new Response(respuesta.body, {
    status: respuesta.status,
    statusText: respuesta.statusText,
    headers: cabeceras
  });
}