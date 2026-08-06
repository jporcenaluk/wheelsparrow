import { negotiate } from "@fastify/accept-negotiator";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

const reservedPrefixes = ["/health", "/ready", "/api"];
const assetLikePath = /\/[^/]+\.[^/]+$/;

export async function registerWeb(
  app: FastifyInstance,
  root: string,
): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    wildcard: true,
    index: ["index.html"],
  });

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const acceptsHtml =
      negotiate(request.headers.accept?.toLowerCase() ?? "", ["text/html"]) ===
      "text/html";
    const isReserved = reservedPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (
      request.method === "GET" &&
      acceptsHtml &&
      !isReserved &&
      !assetLikePath.test(pathname)
    ) {
      return reply.sendFile("index.html", { maxAge: 0 });
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
