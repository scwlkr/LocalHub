// PROTOTYPE ONLY — local design fixture for issue "Prototype the Member Browser Chat experience".
const port = 4319;
const html = Bun.file(new URL("./index.html", import.meta.url));

Bun.serve({
  port,
  routes: {
    "/": new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  },
});

console.log(`Member Browser Chat prototype: http://127.0.0.1:${port}/?variant=A&scenario=active`);
