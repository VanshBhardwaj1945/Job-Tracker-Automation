// Cloudflare Access JWT verification.
//
// Every request that reaches the worker through Access carries a
// Cf-Access-Jwt-Assertion header — both interactive logins and service-token
// clients (Access mints a JWT for service tokens too), so this single check
// covers the UI and GitHub Actions. Requests that somehow bypass Access
// (direct workers.dev hit, misconfigured route) fail verification and get 403.

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson<T>(b64url: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url))) as T;
}

export interface AccessIdentity {
  email?: string;
  common_name?: string; // set for service-token auth
}

/** Returns the token identity if valid, null otherwise. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string
): Promise<AccessIdentity | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeJson<{ alg: string; kid: string }>(parts[0]);
    if (header.alg !== "RS256") return null;

    const payload = decodeJson<{
      aud: string | string[];
      exp: number;
      iss?: string;
      email?: string;
      common_name?: string;
    }>(parts[1]);

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(aud)) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;

    let keys = await getJwks(teamDomain);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      jwksCache = null; // key rotation — refetch once
      keys = await getJwks(teamDomain);
      jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return null;
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    return { email: payload.email, common_name: payload.common_name };
  } catch {
    return null;
  }
}
