import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Elysia } from "elysia";
import { fileTypeFromBuffer } from "file-type";
import Redis from "ioredis";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_REQUEST_SIZE = MAX_FILE_SIZE + 512 * 1024;
const IMAGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const IP_LIMIT_PER_MINUTE = 120;
const GLOBAL_LIMIT_PER_MINUTE = 2_000;
const RATE_WINDOW_SECONDS = 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/vnd.microsoft.icon",
  "image/webp",
]);

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");

const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
});
redis.on("error", (error) => console.error("Redis:", error.message));

const rateLimitScript = `
  local ipCount = redis.call("INCR", KEYS[1])
  if ipCount == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end

  local globalCount = redis.call("INCR", KEYS[2])
  if globalCount == 1 then redis.call("EXPIRE", KEYS[2], ARGV[1]) end

  if ipCount > tonumber(ARGV[2]) or globalCount > tonumber(ARGV[3]) then
    return {0, ipCount, globalCount}
  end

  return {1, ipCount, globalCount}
`;

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function publicUrl(request: Request, path: string): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost && (forwardedProto === "http" || forwardedProto === "https")) {
    return `${forwardedProto}://${forwardedHost}${path}`;
  }
  return new URL(path, request.url).toString();
}

function jsonError(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers });
}

const publicDir = resolve(import.meta.dir, "../public");

const app = new Elysia({
  serve: { maxRequestBodySize: MAX_REQUEST_SIZE },
})
  .get("/", () =>
    new Response(Bun.file(resolve(publicDir, "index.html")), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    }),
  )
  .get("/styles.css", () =>
    new Response(Bun.file(resolve(publicDir, "styles.css")), {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
    }),
  )
  .get("/app.js", () =>
    new Response(Bun.file(resolve(publicDir, "app.js")), {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    }),
  )
  .get("/favicon.ico", () => new Response(null, { status: 204 }))
  .get("/health", async () => {
    try {
      return Response.json({ status: (await redis.ping()) === "PONG" ? "ok" : "degraded" });
    } catch {
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
  })
  .post(
    "/upload",
    async ({ request }) => {
      const ipHash = createHash("sha256")
        .update(clientIp(request))
        .digest("base64url")
        .slice(0, 22);

      let allowed: number;
      let ipCount: number;
      try {
        const result = (await redis.eval(
          rateLimitScript,
          2,
          `rate:upload:ip:${ipHash}`,
          "rate:upload:global",
          RATE_WINDOW_SECONDS,
          IP_LIMIT_PER_MINUTE,
          GLOBAL_LIMIT_PER_MINUTE,
        )) as Array<number | string>;
        allowed = Number(result[0]);
        ipCount = Number(result[1]);
      } catch {
        return jsonError("Storage unavailable", 503);
      }

      if (!allowed) {
        return jsonError("Rate limit exceeded", 429, {
          "Retry-After": String(RATE_WINDOW_SECONDS),
          "X-RateLimit-Limit": String(IP_LIMIT_PER_MINUTE),
          "X-RateLimit-Remaining": "0",
        });
      }

      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
        return jsonError("File is too large", 413);
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return jsonError("Invalid multipart body", 400);
      }

      const file = form.get("file");
      if (!(file instanceof File)) return jsonError('Field "file" is required', 400);
      if (file.size === 0 || file.size > MAX_FILE_SIZE) {
        return jsonError("Image must be between 1 byte and 5 MB", 413);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const detected = await fileTypeFromBuffer(bytes);
      if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
        return jsonError("Unsupported or invalid image", 415);
      }

      const mime = Buffer.from(detected.mime, "utf8");
      const image = Buffer.from(bytes);
      const packed = Buffer.concat([Buffer.from([mime.length]), mime, image]);
      const id = randomBytes(12).toString("base64url");

      try {
        await redis.set(`image:${id}`, packed, "EX", IMAGE_TTL_SECONDS);
      } catch {
        return jsonError("Storage unavailable", 503);
      }

      const path = `/sh/${id}`;
      return Response.json(
        { id, url: publicUrl(request, path) },
        {
          status: 201,
          headers: {
            "Cache-Control": "no-store",
            "X-RateLimit-Limit": String(IP_LIMIT_PER_MINUTE),
            "X-RateLimit-Remaining": String(Math.max(0, IP_LIMIT_PER_MINUTE - ipCount)),
          },
        },
      );
    },
    { parse: "none" },
  )
  .get("/sh/:id", async ({ params: { id }, request }) => {
    if (!ID_PATTERN.test(id)) return new Response("Not found", { status: 404 });

    const etag = `"${id}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    let packed: Buffer | null;
    try {
      packed = await redis.getBuffer(`image:${id}`);
    } catch {
      return new Response("Storage unavailable", { status: 503 });
    }

    if (!packed || packed.length < 2) return new Response("Not found", { status: 404 });

    const mimeEnd = 1 + packed[0];
    if (mimeEnd >= packed.length) return new Response("Corrupted image", { status: 500 });

    const contentType = packed.subarray(1, mimeEnd).toString("utf8");
    const image = packed.subarray(mimeEnd);

    return new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(image.length),
        "Cache-Control": `public, max-age=${IMAGE_TTL_SECONDS}, immutable`,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
      },
    });
  })
  .onError(({ code, error }) => {
    if (code === "NOT_FOUND") return jsonError("Not found", 404);
    console.error(code, error instanceof Error ? error.message : error);
    return jsonError("Internal server error", 500);
  });

await redis.ping();
app.listen({ hostname: "0.0.0.0", port: PORT });
console.log(`LANESH listening on :${PORT}`);

async function shutdown() {
  await redis.quit().catch(() => undefined);
  await app.stop();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
