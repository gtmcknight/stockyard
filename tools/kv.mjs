/**
 * The Worker's KV binding, reimplemented against Cloudflare's REST API so the
 * same crawl runs unchanged off-platform. Only get and put are used, and only
 * with string values, so that is all this is.
 */
const API = "https://api.cloudflare.com/client/v4";

export function kv({ accountId, namespaceId, token }) {
  const base = `${API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
  const auth = { Authorization: `Bearer ${token}` };

  return {
    async get(key) {
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`KV get ${key}: ${r.status} ${await r.text()}`);
      return await r.text();
    },
    // expirationTtl is passed by the caller for the dated snapshots; the REST
    // API takes it as a query parameter rather than an option object
    async put(key, value, opts = {}) {
      const q = opts.expirationTtl ? `?expiration_ttl=${opts.expirationTtl}` : "";
      const body = new FormData();
      body.set("value", String(value));
      body.set("metadata", "{}");
      const r = await fetch(`${base}/values/${encodeURIComponent(key)}${q}`,
        { method: "PUT", headers: auth, body });
      if (!r.ok) throw new Error(`KV put ${key}: ${r.status} ${await r.text()}`);
    },
  };
}
