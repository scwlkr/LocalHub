// PROTOTYPE ONLY — local, read-only design fixture for issue "Prototype First Run Setup and reversible updates".
const port = 4320;
const html = Bun.file(new URL("./index.html", import.meta.url));

Bun.serve({
  port,
  routes: {
    "/": new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  },
});

console.log(`First Run prototype: http://127.0.0.1:${port}/?variant=A&scenario=setup`);
