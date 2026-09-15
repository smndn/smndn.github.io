export async function onRequest(context) {
  const upstream = context.env.PARLIAMENTARY_WORKER_URL;
  if (!upstream) {
    return new Response("Parliamentary worker URL not configured", { status: 503 });
  }
  const url = new URL(context.request.url);
  const target = new URL(url.pathname + url.search, upstream);
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  return fetch(new Request(target, { method: context.request.method, headers, body: context.request.body, redirect: "follow" }));
}
