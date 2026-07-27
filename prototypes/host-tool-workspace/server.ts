const root = new URL("./", import.meta.url);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4178),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      return new Response("Not found", { status: 404 });
    }

    return new Response(Bun.file(new URL("index.html", root)), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Host Tool Workspace prototype: http://127.0.0.1:${server.port}/?variant=A`);
