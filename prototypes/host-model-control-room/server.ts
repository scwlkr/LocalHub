// PROTOTYPE ONLY — local, read-only design fixture for issue "Prototype the Host model control room".
const port = 4318;
const html = Bun.file(new URL("./index.html", import.meta.url));

Bun.serve({
  port,
  routes: {
    "/": new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  },
});

console.log(`Host control room prototype: http://127.0.0.1:${port}/?variant=A`);
