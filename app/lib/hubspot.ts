/**
 * HubSpot CRM v3 client — server-only, dependency-free.
 *
 * No SDK on purpose: we need four endpoints, `fetch` is built in, and an SDK
 * would be another package to keep current for no benefit.
 *
 * THE HARD RULE OF THIS MODULE: HubSpot being unconfigured is a normal state,
 * not an error. We do not have a portal token yet (private apps need a Super
 * Admin, and the ask is out). Until `HUBSPOT_ACCESS_TOKEN` is set, every caller
 * must be able to no-op cleanly — nothing in the product may 500, block, or
 * even slow down because the CRM isn't wired. Callers check
 * `hubspotConfigured()` first; the request helper throws a plain
 * `HubSpotNotConfiguredError` if one forgets.
 *
 * SECRET/PII HYGIENE: thrown errors carry the method, path, HTTP status and
 * HubSpot's own error *category* only. Never the token, and never the response
 * body — a 400 from HubSpot echoes the offending property values back, which
 * for us means a minor's application answers.
 *
 * Every request is built from `hubspotBaseUrl()`, so pointing the whole
 * integration at the local stand-in is one env var. See
 * docs/hubspot-integration.md → "Local verification".
 *
 * NEVER import this from a client component.
 */
import {
  HA_GROUP_LABEL,
  HA_GROUP_NAME,
  type HubSpotPropertyDef,
} from "./hubspotSchema";

/** The real API. The ONLY place this string appears in the codebase. */
export const DEFAULT_BASE_URL = "https://api.hubapi.com";

/**
 * Where requests go. Overridable with `HUBSPOT_BASE_URL` so the whole client
 * can be pointed at the local stand-in (scripts/hubspot-mock-server.js) and
 * driven end to end without a portal token — which is the only way any of this
 * is verifiable until a Super Admin grants one.
 *
 * Read at call time, not at module load, so a script can set the env var after
 * importing this module. A trailing slash is stripped because every path here
 * starts with one.
 */
export function hubspotBaseUrl(): string {
  const raw = process.env.HUBSPOT_BASE_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Per-attempt ceiling. HubSpot is normally <500ms; anything near this is a
 *  provider problem and we would rather fail the record than hold a Vercel
 *  function open. */
const TIMEOUT_MS = 15_000;
/** One retry only. The cron runs every 5 minutes, so a transient failure costs
 *  us minutes, not correctness — every operation is idempotent. */
const RETRY_DELAY_MS = 1_500;

export function hubspotConfigured(): boolean {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
}

export class HubSpotNotConfiguredError extends Error {
  constructor() {
    super("HUBSPOT_ACCESS_TOKEN is not set");
    this.name = "HubSpotNotConfiguredError";
  }
}

export class HubSpotError extends Error {
  readonly status: number;
  readonly category: string;
  constructor(method: string, path: string, status: number, category: string) {
    super(
      `HubSpot ${method} ${path} failed: ${status}${category ? ` (${category})` : ""}`
    );
    this.name = "HubSpotError";
    this.status = status;
    this.category = category;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull only the safe, non-echoing fields out of an error body. HubSpot returns
 * `{ status, message, correlationId, category }` where `message` frequently
 * quotes the submitted value — so `message` is exactly what we must not keep.
 */
async function safeErrorCategory(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { category?: unknown; correlationId?: unknown };
    const parts: string[] = [];
    if (typeof body.category === "string") parts.push(body.category);
    if (typeof body.correlationId === "string") {
      parts.push(`correlationId=${body.correlationId}`);
    }
    return parts.join(" ");
  } catch {
    return "";
  }
}

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Honour Retry-After when HubSpot sends it, else a flat backoff. */
function retryDelay(res: Response | null): number {
  const header = res?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  return RETRY_DELAY_MS;
}

interface RawResult {
  res: Response;
  path: string;
  method: string;
}

/**
 * One authenticated attempt + at most one retry. Returns the raw Response so
 * callers can treat a 404 as "absent" rather than an error.
 */
async function rawRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<RawResult> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new HubSpotNotConfiguredError();

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  let lastRes: Response | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(retryDelay(lastRes));
    try {
      const res = await fetch(`${hubspotBaseUrl()}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (attempt === 0 && retryable(res.status)) {
        lastRes = res;
        // Release the socket: an unread body keeps the connection pinned.
        void res.body?.cancel().catch(() => {});
        continue;
      }
      return { res, path, method };
    } catch (err) {
      // Network failure or timeout. AbortError included — one retry, then out.
      lastNetworkError = err;
      lastRes = null;
    }
  }

  if (lastRes) return { res: lastRes, path, method };
  // Deliberately does not interpolate the original error: an undici cause
  // chain can carry the request headers, and those carry the token.
  throw new HubSpotError(
    method,
    path,
    0,
    lastNetworkError instanceof Error ? lastNetworkError.name : "network"
  );
}

/** Request that treats any non-2xx as an error. */
async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { res } = await rawRequest(method, path, body);
  if (!res.ok) {
    throw new HubSpotError(method, path, res.status, await safeErrorCategory(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

export type ContactProperties = Record<string, string>;

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

/**
 * Fetch a contact by email, or null when there is no such contact.
 * `idProperty=email` lets us address contacts by their natural key instead of
 * keeping HubSpot ids anywhere.
 */
export async function getContactByEmail(
  email: string,
  properties: string[]
): Promise<HubSpotContact | null> {
  const query = new URLSearchParams({
    idProperty: "email",
    properties: properties.join(","),
  });
  const { res } = await rawRequest(
    "GET",
    `/crm/v3/objects/contacts/${encodeURIComponent(email)}?${query}`
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new HubSpotError(
      "GET",
      "/crm/v3/objects/contacts/{email}",
      res.status,
      await safeErrorCategory(res)
    );
  }
  return (await res.json()) as HubSpotContact;
}

/**
 * Upsert by email — email is the dedupe key for everything we do, so we never
 * create a second contact for someone who applied twice.
 *
 * PATCH-by-idProperty first (the common case: the contact exists, or is about
 * to be created once and then updated forever), falling back to a create on
 * 404. A 409 on the create means someone else won the race; we PATCH again.
 */
export async function upsertContactByEmail(
  email: string,
  props: ContactProperties
): Promise<string> {
  const properties = { ...props, email };
  const query = new URLSearchParams({ idProperty: "email" });
  const patchPath = `/crm/v3/objects/contacts/${encodeURIComponent(
    email
  )}?${query}`;

  const patched = await rawRequest("PATCH", patchPath, { properties });
  if (patched.res.ok) {
    const json = (await patched.res.json()) as { id: string };
    return json.id;
  }
  if (patched.res.status !== 404) {
    throw new HubSpotError(
      "PATCH",
      "/crm/v3/objects/contacts/{email}",
      patched.res.status,
      await safeErrorCategory(patched.res)
    );
  }

  const created = await rawRequest("POST", "/crm/v3/objects/contacts", {
    properties,
  });
  if (created.res.ok) {
    const json = (await created.res.json()) as { id: string };
    return json.id;
  }
  if (created.res.status === 409) {
    // Lost a create race — the contact exists now, so the PATCH will land.
    const retry = await request<{ id: string }>("PATCH", patchPath, { properties });
    return retry.id;
  }
  throw new HubSpotError(
    "POST",
    "/crm/v3/objects/contacts",
    created.res.status,
    await safeErrorCategory(created.res)
  );
}

/**
 * Patch by HubSpot object id. Only for the one case where we have a contact but
 * no usable email to key on — email is the key everywhere else.
 */
export async function patchContactById(
  contactId: string,
  props: ContactProperties
): Promise<void> {
  await request(
    "PATCH",
    `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
    { properties: props }
  );
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

export interface SearchFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}

export interface SearchFilterGroup {
  filters: SearchFilter[];
}

export interface SearchPage {
  results: HubSpotContact[];
  /** Cursor for the next page, absent on the last one. */
  after?: string;
  total: number;
}

/** One page of `POST /crm/v3/objects/contacts/search`. */
export async function searchContacts(params: {
  filterGroups: SearchFilterGroup[];
  properties: string[];
  after?: string;
  limit?: number;
}): Promise<SearchPage> {
  const { filterGroups, properties, after, limit = 100 } = params;
  const json = await request<{
    total?: number;
    results?: HubSpotContact[];
    paging?: { next?: { after?: string } };
  }>("POST", "/crm/v3/objects/contacts/search", {
    filterGroups,
    properties,
    limit,
    ...(after ? { after } : {}),
  });
  return {
    results: json.results ?? [],
    ...(json.paging?.next?.after ? { after: json.paging.next.after } : {}),
    total: json.total ?? 0,
  };
}

/**
 * Every page of a search, flattened. Bounded by `maxPages` so a filter that
 * accidentally matches the whole portal can't turn one cron tick into a
 * thousand API calls.
 */
export async function searchAllContacts(params: {
  filterGroups: SearchFilterGroup[];
  properties: string[];
  maxPages?: number;
}): Promise<{ contacts: HubSpotContact[]; truncated: boolean }> {
  const { filterGroups, properties, maxPages = 10 } = params;
  const contacts: HubSpotContact[] = [];
  let after: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await searchContacts({ filterGroups, properties, after });
    contacts.push(...res.results);
    if (!res.after) return { contacts, truncated: false };
    after = res.after;
  }
  return { contacts, truncated: true };
}

/* ------------------------------------------------------------------ */
/* Property provisioning                                              */
/* ------------------------------------------------------------------ */

export interface EnsureResult {
  createdGroup: boolean;
  created: string[];
  skipped: string[];
}

/** Is the High Agency property group already in the portal? */
export async function hasPropertyGroup(): Promise<boolean> {
  const existing = await request<{ results?: { name?: string }[] }>(
    "GET",
    "/crm/v3/properties/contacts/groups"
  );
  return (existing.results ?? []).some((g) => g.name === HA_GROUP_NAME);
}

/** Every non-archived contact property name in the portal (~287 of them, most
 *  of them nothing to do with us — which is why every field we own is
 *  `ha_`-prefixed). Exported so the setup script can plan a dry run. */
export async function listContactPropertyNames(): Promise<Set<string>> {
  const all = await request<{ results?: { name?: string }[] }>(
    "GET",
    "/crm/v3/properties/contacts?archived=false"
  );
  return new Set(
    (all.results ?? [])
      .map((p) => p.name)
      .filter((n): n is string => typeof n === "string")
  );
}

/**
 * Create the property group if it isn't there. Idempotent, and treats a 409 as
 * success — see the note on `ensureProperties` about why the pre-check alone
 * isn't enough.
 */
async function ensureGroup(): Promise<boolean> {
  if (await hasPropertyGroup()) return false;
  const { res } = await rawRequest("POST", "/crm/v3/properties/contacts/groups", {
    name: HA_GROUP_NAME,
    label: HA_GROUP_LABEL,
  });
  if (res.ok) return true;
  if (res.status === 409) return false;
  throw new HubSpotError(
    "POST",
    "/crm/v3/properties/contacts/groups",
    res.status,
    await safeErrorCategory(res)
  );
}

/**
 * Provision the group and every property in `defs`, skipping any that already
 * exist. Deliberately never PATCHes an existing property: if a human has
 * widened a picklist or relabelled a field in the portal, that is their call,
 * not something a deploy should quietly revert.
 *
 * The name check is a pre-filter, not the safety net. A 409 on create still has
 * to mean "already exists, skip it" for two real reasons: an ARCHIVED property
 * still owns its name in HubSpot but is absent from the `archived=false` listing
 * above, and two people (or a deploy and a person) can provision at the same
 * time. Aborting the whole run on either would leave the schema half-created.
 */
export async function ensureProperties(
  defs: HubSpotPropertyDef[]
): Promise<EnsureResult> {
  const createdGroup = await ensureGroup();
  const present = await listContactPropertyNames();

  const created: string[] = [];
  const skipped: string[] = [];

  for (const def of defs) {
    if (present.has(def.name)) {
      skipped.push(def.name);
      continue;
    }
    const { res } = await rawRequest("POST", "/crm/v3/properties/contacts", {
      name: def.name,
      label: def.label,
      type: def.type,
      fieldType: def.fieldType,
      groupName: HA_GROUP_NAME,
      description: def.description,
      ...(def.options
        ? {
            options: def.options.map((o, i) => ({
              label: o.label,
              value: o.value,
              displayOrder: i,
              hidden: false,
            })),
          }
        : {}),
    });
    if (res.ok) {
      created.push(def.name);
      continue;
    }
    if (res.status === 409) {
      skipped.push(def.name);
      continue;
    }
    throw new HubSpotError(
      "POST",
      "/crm/v3/properties/contacts",
      res.status,
      await safeErrorCategory(res)
    );
  }

  return { createdGroup, created, skipped };
}
