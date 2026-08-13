/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS admin
   script, run with plain `node`, like everything else in scripts/. */
//
// ============================================================================
// LOCAL VERIFICATION ONLY. THIS IS NOT A PRODUCTION PATH.
// ============================================================================
//
// A stand-in for the HubSpot v3 API, big enough to drive app/lib/hubspot.ts end
// to end. It exists because we cannot get a portal token yet (private apps need
// a Super Admin in portal 2410150 and the ask is out), which would otherwise
// leave the entire integration unverified against anything at all.
//
// It implements ONLY what our own client actually calls — read
// app/lib/hubspot.ts and the search shapes in hubspotSync.ts before extending
// it. State is in memory: restart and it's gone. Nothing here is ever deployed,
// and no product code imports it.
//
// Usage:
//   node scripts/hubspot-mock-server.js                 # port 4300
//   node scripts/hubspot-mock-server.js --port 4399
//   HUBSPOT_MOCK_TOKEN=xyz node scripts/hubspot-mock-server.js
//
// Then point the real client at it:
//   HUBSPOT_BASE_URL=http://127.0.0.1:4300 HUBSPOT_ACCESS_TOKEN=mock-token ...
//
// scripts/hubspot-e2e.js boots this automatically; you only run it by hand when
// you want to poke at the store yourself.
const http = require("http");

const DEFAULT_PORT = 4300;
/** The bearer the /crm/** routes demand, so the auth path is exercised too. */
const TOKEN = process.env.HUBSPOT_MOCK_TOKEN || "mock-token";

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** email (lowercased) → { id, properties }. Email is the dedupe key, exactly as
 *  it is in the real portal and in our client. */
const contacts = new Map();
/** HubSpot object ids are opaque numeric strings. */
let nextId = 1001;

/** name → { name, label } */
const groups = new Map();
/** name → { ...definition, archived } */
const properties = new Map();

function contactByIdOrNull(id) {
  for (const contact of contacts.values()) {
    if (contact.id === String(id)) return contact;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function send(res, status, body) {
  const json = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * HubSpot's error envelope. Our client reads `category` and `correlationId` out
 * of this and deliberately throws away `message`, so the message here is
 * intentionally the sort of value-echoing text the real API sends — it proves
 * the client isn't leaking it.
 */
function sendError(res, status, category, message) {
  send(res, status, {
    status: "error",
    message,
    category,
    correlationId: `mock-${Date.now().toString(36)}`,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // A runaway body is a bug, not a payload.
      if (raw.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Only the requested properties, mirroring HubSpot's projection. */
function project(contact, wanted) {
  if (!wanted || !wanted.length) return { ...contact.properties };
  const out = {};
  for (const name of wanted) {
    if (contact.properties[name] !== undefined) out[name] = contact.properties[name];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

/**
 * The operators pullDecisions() actually sends are IN, EQ and
 * NOT_HAS_PROPERTY. NEQ / NOT_IN / HAS_PROPERTY are implemented too because
 * they are one line each and the next filter someone writes will need them.
 *
 * Note the NEQ semantics: in the real API a property with NO value does not
 * match NEQ, which is exactly why pullDecisions needs its second filter group.
 * Getting that wrong here would make the mock lie about the thing it is most
 * needed to prove.
 */
function matchesFilter(contact, filter) {
  const value = contact.properties[filter.propertyName];
  const has = value !== undefined && value !== "";

  switch (filter.operator) {
    case "EQ":
      return has && value === filter.value;
    case "NEQ":
      return has && value !== filter.value;
    case "IN":
      return has && (filter.values ?? []).includes(value);
    case "NOT_IN":
      return has && !(filter.values ?? []).includes(value);
    case "HAS_PROPERTY":
      return has;
    case "NOT_HAS_PROPERTY":
      return !has;
    default:
      throw new Error(`mock: unsupported search operator ${filter.operator}`);
  }
}

/** Filters within a group are AND'd; groups are OR'd. */
function matchesGroups(contact, filterGroups) {
  if (!filterGroups || !filterGroups.length) return true;
  return filterGroups.some((group) =>
    (group.filters ?? []).every((filter) => matchesFilter(contact, filter))
  );
}

function handleSearch(res, body) {
  const limit = Math.min(Number(body.limit) || 100, 200);
  const offset = Number(body.after) || 0;

  let matched;
  try {
    matched = [...contacts.values()]
      // Deterministic order, so `after` is a stable cursor.
      .sort((a, b) => Number(a.id) - Number(b.id))
      .filter((contact) => matchesGroups(contact, body.filterGroups));
  } catch (err) {
    return sendError(res, 400, "VALIDATION_ERROR", err.message);
  }

  const page = matched.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  send(res, 200, {
    total: matched.length,
    results: page.map((contact) => ({
      id: contact.id,
      properties: project(contact, body.properties),
    })),
    ...(nextOffset < matched.length
      ? { paging: { next: { after: String(nextOffset) } } }
      : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

function upsertProperties(contact, incoming) {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    // HubSpot stores everything as a string and treats "" as "cleared".
    contact.properties[key] = value === null ? "" : String(value);
  }
}

function createContact(properties_) {
  const email = normalizeEmail(properties_?.email);
  const contact = { id: String(nextId++), properties: {} };
  upsertProperties(contact, properties_);
  contact.properties.email = email;
  contacts.set(email, contact);
  return contact;
}

/** PATCH /crm/v3/objects/contacts/{email}?idProperty=email — or by object id. */
function handlePatch(res, key, byEmail, body) {
  const contact = byEmail ? contacts.get(normalizeEmail(key)) : contactByIdOrNull(key);
  if (!contact) {
    return sendError(
      res,
      404,
      "OBJECT_NOT_FOUND",
      `No contact matching ${byEmail ? "email" : "id"} ${key}`
    );
  }

  const previousEmail = contact.properties.email;
  upsertProperties(contact, body.properties);

  // A PATCH that changes the email re-keys the store, as the real API would.
  const nextEmail = normalizeEmail(contact.properties.email) || previousEmail;
  contact.properties.email = nextEmail;
  if (nextEmail !== previousEmail) {
    contacts.delete(previousEmail);
    contacts.set(nextEmail, contact);
  }

  send(res, 200, { id: contact.id, properties: { ...contact.properties } });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function route(req, res) {
  const url = new URL(req.url, "http://mock.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  /* ---------- control surface: NOT part of the real HubSpot API ---------- */
  // Deliberately unauthenticated and deliberately namespaced under __control so
  // it can never be mistaken for something the client is allowed to call.
  if (path.startsWith("/__control")) {
    if (method === "GET" && path === "/__control/health") {
      return send(res, 200, { ok: true, contacts: contacts.size });
    }

    if (method === "GET" && path === "/__control/contacts") {
      return send(res, 200, {
        count: contacts.size,
        contacts: [...contacts.values()].map((c) => ({
          id: c.id,
          email: c.properties.email,
          properties: { ...c.properties },
        })),
      });
    }

    const body = await readBody(req);

    // Seed a contact directly, without going through the client.
    if (method === "POST" && path === "/__control/contacts") {
      const email = normalizeEmail(body.email ?? body.properties?.email);
      if (!email) return sendError(res, 400, "VALIDATION_ERROR", "email required");
      const existing = contacts.get(email);
      if (existing) {
        upsertProperties(existing, body.properties);
        return send(res, 200, { id: existing.id, created: false });
      }
      const created = createContact({ ...body.properties, email });
      return send(res, 201, { id: created.id, created: true });
    }

    /**
     * Simulate a staff member making a decision in the HubSpot UI. It sets
     * exactly the fields a human clicking there would set — the status, and
     * optionally the role and the decline reason — and NOTHING else. In
     * particular it does not touch ha_decision_synced, because a human doesn't
     * either; that is the whole point of the marker.
     *
     * `resetSynced: true` mirrors the one documented case where staff DO edit
     * it: "to re-run a decision, set Decision Synced → Pending".
     */
    if (method === "POST" && path === "/__control/decide") {
      const email = normalizeEmail(body.email);
      const status = String(body.status ?? "");
      if (!["approved", "declined"].includes(status)) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "status must be 'approved' or 'declined'"
        );
      }
      const contact = contacts.get(email);
      if (!contact) {
        return sendError(res, 404, "OBJECT_NOT_FOUND", `No contact for ${email}`);
      }

      contact.properties.ha_application_status = status;
      if (body.role) contact.properties.ha_member_role = String(body.role);
      if (body.declineReason) {
        contact.properties.ha_decline_reason = String(body.declineReason);
      }
      if (body.resetSynced) contact.properties.ha_decision_synced = "pending";

      return send(res, 200, {
        id: contact.id,
        properties: { ...contact.properties },
      });
    }

    /**
     * Archive a property. This is how the 409-on-create path gets exercised for
     * real: an archived property still owns its name in HubSpot but disappears
     * from the `archived=false` listing, so ensureProperties() will try to
     * create it and must treat the conflict as "already exists".
     */
    if (method === "POST" && path === "/__control/archive-property") {
      const name = String(body.name ?? "");
      const prop = properties.get(name);
      if (!prop) return sendError(res, 404, "OBJECT_NOT_FOUND", `No property ${name}`);
      prop.archived = true;
      return send(res, 200, { name, archived: true });
    }

    if (method === "POST" && path === "/__control/reset") {
      contacts.clear();
      nextId = 1001;
      if (body.schema) {
        groups.clear();
        properties.clear();
      }
      return send(res, 200, { ok: true });
    }

    return sendError(res, 404, "OBJECT_NOT_FOUND", `No control route ${method} ${path}`);
  }

  /* ---------- everything below stands in for the real API ---------- */

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return sendError(
      res,
      401,
      "INVALID_AUTHENTICATION",
      "Authentication credentials not found"
    );
  }

  const body =
    method === "GET" || method === "DELETE" ? {} : await readBody(req);

  // --- property groups ---
  if (path === "/crm/v3/properties/contacts/groups") {
    if (method === "GET") {
      return send(res, 200, { results: [...groups.values()] });
    }
    if (method === "POST") {
      const name = String(body.name ?? "");
      if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name required");
      if (groups.has(name)) {
        return sendError(
          res,
          409,
          "CONFLICT",
          `A property group with the name '${name}' already exists`
        );
      }
      groups.set(name, { name, label: String(body.label ?? name) });
      return send(res, 201, { name, label: body.label });
    }
  }

  // --- properties ---
  if (path === "/crm/v3/properties/contacts") {
    if (method === "GET") {
      const wantArchived = url.searchParams.get("archived") === "true";
      return send(res, 200, {
        results: [...properties.values()]
          .filter((p) => Boolean(p.archived) === wantArchived)
          // The archived flag is our bookkeeping, not part of the API shape.
          .map((p) => {
            const def = { ...p };
            delete def.archived;
            return def;
          }),
      });
    }
    if (method === "POST") {
      const name = String(body.name ?? "");
      if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name required");
      // Archived properties still own their name — this is the conflict that
      // makes the 409 path load-bearing rather than theoretical.
      if (properties.has(name)) {
        return sendError(
          res,
          409,
          "CONFLICT",
          `Property with name '${name}' already exists`
        );
      }
      if (body.groupName && !groups.has(String(body.groupName))) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          `Property group '${body.groupName}' does not exist`
        );
      }
      properties.set(name, { ...body, name, archived: false });
      return send(res, 201, { ...body, name });
    }
  }

  // --- contact search ---
  if (path === "/crm/v3/objects/contacts/search" && method === "POST") {
    return handleSearch(res, body);
  }

  // --- contact create ---
  if (path === "/crm/v3/objects/contacts" && method === "POST") {
    const email = normalizeEmail(body.properties?.email);
    if (!email) {
      return sendError(res, 400, "VALIDATION_ERROR", "property 'email' is required");
    }
    if (contacts.has(email)) {
      return sendError(
        res,
        409,
        "CONFLICT",
        `Contact already exists. Existing ID: ${contacts.get(email).id}`
      );
    }
    const created = createContact(body.properties);
    return send(res, 201, {
      id: created.id,
      properties: { ...created.properties },
    });
  }

  // --- single contact by email or id ---
  const single = path.match(/^\/crm\/v3\/objects\/contacts\/(.+)$/);
  if (single) {
    const key = decodeURIComponent(single[1]);
    const byEmail = url.searchParams.get("idProperty") === "email";

    if (method === "GET") {
      const contact = byEmail
        ? contacts.get(normalizeEmail(key))
        : contactByIdOrNull(key);
      if (!contact) {
        return sendError(res, 404, "OBJECT_NOT_FOUND", `No contact for ${key}`);
      }
      const wanted = (url.searchParams.get("properties") ?? "")
        .split(",")
        .filter(Boolean);
      return send(res, 200, {
        id: contact.id,
        properties: project(contact, wanted),
      });
    }

    if (method === "PATCH") {
      return handlePatch(res, key, byEmail, body);
    }
  }

  // Anything unimplemented is loud, not silently empty: a 404 that our client
  // reads as "absent" would turn a missing route into a wrong test result.
  return sendError(
    res,
    501,
    "NOT_IMPLEMENTED",
    `mock: no route for ${method} ${path} — add it to scripts/hubspot-mock-server.js`
  );
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    sendError(res, 400, "VALIDATION_ERROR", `mock: ${err.message}`);
  });
});

function parsePort() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--port");
  if (index !== -1 && argv[index + 1]) return Number(argv[index + 1]);
  const inline = argv.find((a) => a.startsWith("--port="));
  if (inline) return Number(inline.split("=")[1]);
  return Number(process.env.HUBSPOT_MOCK_PORT) || DEFAULT_PORT;
}

const port = parsePort();
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`error: invalid --port ${port}`);
  process.exit(1);
}

server.listen(port, "127.0.0.1", () => {
  // hubspot-e2e.js waits for this exact line, so don't reword it casually.
  console.log(`hubspot mock listening on http://127.0.0.1:${port}`);
  console.log(`  bearer token: ${TOKEN}`);
  console.log(`  point the client at it with:`);
  console.log(
    `    HUBSPOT_BASE_URL=http://127.0.0.1:${port} HUBSPOT_ACCESS_TOKEN=${TOKEN}`
  );
});

server.on("error", (err) => {
  console.error(`error: mock server failed to listen on ${port}: ${err.message}`);
  process.exit(1);
});

// Exit cleanly when the e2e harness (or a Ctrl-C) asks.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
