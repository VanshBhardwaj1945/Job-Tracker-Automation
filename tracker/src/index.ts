import { Hono } from "hono";
import type { Env } from "./types";
import { ensureSchema } from "./db";
import { verifyAccessJwt } from "./auth";
import { api } from "./api";
import ui from "./ui.html";
import JSZIP_SRC from "./vendor/jszip.min.txt";
import DOCX_PREVIEW_SRC from "./vendor/docx-preview.min.txt";
import { ICON_SVG_ROUND, ICON_SVG_FULL, APPLE_180, MANIFEST, pngResponse } from "./icons";

const app = new Hono<{ Bindings: Env }>();

// Public app-icon / PWA assets (registered before auth; Access still fronts the
// domain, but a logged-in session's cookie carries them through).
const svg = (s: string) =>
  new Response(s, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
app.get("/favicon.svg", () => svg(ICON_SVG_ROUND));
app.get("/icon.svg", () => svg(ICON_SVG_FULL));
app.get("/apple-touch-icon.png", () => pngResponse(APPLE_180));
app.get("/manifest.webmanifest", () =>
  new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" } }));

// Auth: everything (UI + API) requires a valid Access JWT. Access sits in
// front of the custom domain; service tokens also arrive as JWTs. DEV_MODE=1
// (wrangler dev only) bypasses this.
app.use("*", async (c, next) => {
  if (c.env.DEV_MODE === "1") return next();
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.text("Forbidden: no Access token", 403);
  const identity = await verifyAccessJwt(token, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
  if (!identity) return c.text("Forbidden: invalid Access token", 403);
  // Defense-in-depth: independently enforce the owner email, so even a widened
  // Access policy can't let another human in. Service tokens carry no email
  // (common_name only) and are gated by the non_identity policy → allowed.
  const allowed = c.env.ACCESS_ALLOWED_EMAIL;
  if (allowed && identity.email && identity.email.toLowerCase() !== allowed.toLowerCase()) {
    return c.text("Forbidden: not authorized", 403);
  }
  return next();
});

app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  return next();
});

app.use("*", async (c, next) => {
  await next();
  // The artifact file stream must be frameable by our own UI (the in-app PDF
  // viewer is a same-origin <iframe>); everything else stays unframeable.
  const frameable = /^\/api\/artifacts\/[^/]+\/file$/.test(c.req.path);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", frameable ? "SAMEORIGIN" : "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; " +
    `frame-ancestors ${frameable ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`
  );
});

// Vendored client libs (self-hosted — CSP allows same-origin scripts only).
// jszip + docx-preview power the raw in-app DOCX rendering in the view modal.
const vendorJs = (src: string) =>
  new Response(src, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
app.get("/vendor/jszip.js", () => vendorJs(JSZIP_SRC));
app.get("/vendor/docx-preview.js", () => vendorJs(DOCX_PREVIEW_SRC));

app.route("/api", api);

app.get("/", (c) => c.html(ui));

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("unhandled:", err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
