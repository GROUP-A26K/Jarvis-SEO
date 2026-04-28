import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { handleFetch } from "./handler.ts";
import type { GA4Client } from "../_shared/ga4-client.ts";
import type { MetricsPersister } from "../_shared/metrics-persister.ts";
import type {
  GA4FetchResponse,
  OverallMetrics,
  PageMetrics,
} from "../_shared/schema.ts";

// Test fixture — explicit, NOT the real A26K UUID per spec §5.
const TEST_CLIENT_ID = "test-uuid-fixture-1234";
const VALID_PERIOD = {
  start: "2026-04-01T00:00:00Z",
  end: "2026-04-30T23:59:59Z",
};

// 5 property IDs from sites/ga4-properties.json (used by mock partial scenarios).
const PROPERTY_RG = "483368599"; // small site
const PROPERTY_IG = "510195526"; // medium site

// --- Mock factories ---

function makeOverall(propertyId: string): OverallMetrics {
  // Stable per-property values for determinism.
  const tail = parseInt(propertyId.slice(-2), 10);
  return {
    sessions: 1000 + tail,
    users: 800 + tail,
    engagement_rate: 0.6,
    key_events: 10,
  };
}

function makePerPage(): PageMetrics[] {
  return [
    {
      page_path: "/",
      sessions: 500,
      users: 400,
      engagement_rate: 0.65,
      key_events: 5,
      threshold_match: "both",
    },
  ];
}

function mockGa4ClientOk(): GA4Client {
  return {
    fetchOverall(propertyId) {
      return Promise.resolve(makeOverall(propertyId));
    },
    fetchPerPage(_propertyId, _overallSessions) {
      return Promise.resolve(makePerPage());
    },
  };
}

function mockGa4ClientPartial(throwingPropertyIds: string[]): GA4Client {
  const isThrowing = (propId: string) => throwingPropertyIds.includes(propId);
  return {
    fetchOverall(propertyId) {
      return isThrowing(propertyId)
        ? Promise.reject(
          new Error(`simulated GA4 quota for ${propertyId}`),
        )
        : Promise.resolve(makeOverall(propertyId));
    },
    fetchPerPage(propertyId, _overallSessions) {
      return isThrowing(propertyId)
        ? Promise.reject(
          new Error(`simulated GA4 quota for ${propertyId}`),
        )
        : Promise.resolve(makePerPage());
    },
  };
}

function mockGa4ClientError(): GA4Client {
  return {
    fetchOverall(propertyId) {
      return Promise.reject(
        new Error(`simulated total failure for ${propertyId}`),
      );
    },
    fetchPerPage(propertyId, _overallSessions) {
      return Promise.reject(
        new Error(`simulated total failure for ${propertyId}`),
      );
    },
  };
}

function mockPersisterOk(): MetricsPersister {
  return {
    persist(payload) {
      const overallRows =
        payload.sites.filter((s) => s.overall !== null).length;
      const pageRows = payload.sites.reduce(
        (sum, s) => sum + s.per_page.length,
        0,
      );
      return Promise.resolve({
        ok: true,
        rows_persisted: overallRows + pageRows,
        errors: [],
      });
    },
  };
}

// --- Helpers ---

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/ga4-fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withClientIdEnv<T>(
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  Deno.env.set("A26K_CLIENT_ID", value);
  try {
    return await fn();
  } finally {
    Deno.env.delete("A26K_CLIENT_ID");
  }
}

// --- Required tests (spec §5) ---

Deno.test("status ok when all sites return data", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = makePostRequest({ period: VALID_PERIOD });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientOk(),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "ok");
    assertEquals(body.data.sites.length, 5);
    assertEquals(body.errors.length, 0);
    assertEquals(body.data.aggregates.sites_with_data, 5);
    assertEquals(body.data.aggregates.sites_with_errors, 0);
    assertEquals(body.meta.client_id, TEST_CLIENT_ID);
  });
});

Deno.test("status partial when some sites throw", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = makePostRequest({ period: VALID_PERIOD });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientPartial([PROPERTY_RG, PROPERTY_IG]),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "partial");
    assertEquals(body.data.sites.length, 5);
    assertEquals(
      body.data.sites.filter((s) => s.overall === null).length,
      2,
    );
    assertEquals(body.errors.length, 2);
    for (const err of body.errors) {
      assertEquals(err.scope, "unknown");
      assertExists(err.site_slug);
    }
    assertEquals(body.data.aggregates.sites_with_data, 3);
    assertEquals(body.data.aggregates.sites_with_errors, 2);
  });
});

Deno.test("status error when all sites throw", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = makePostRequest({ period: VALID_PERIOD });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientError(),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 500);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "error");
    assertEquals(body.data.sites.length, 5);
    assertEquals(
      body.data.sites.filter((s) => s.overall === null).length,
      5,
    );
    assertEquals(body.errors.length, 5);
  });
});

Deno.test("returns error response when A26K_CLIENT_ID env undefined", async () => {
  Deno.env.delete("A26K_CLIENT_ID"); // ensure clean
  const req = makePostRequest({ period: VALID_PERIOD });
  const res = await handleFetch(req, {
    ga4Client: mockGa4ClientOk(),
    persister: mockPersisterOk(),
  });
  assertEquals(res.status, 500);
  const body = (await res.json()) as GA4FetchResponse;
  assertEquals(body.status, "error");
  assertEquals(body.errors.length, 1);
  assertEquals(body.errors[0].scope, "unknown");
  assertStringIncludes(body.errors[0].message, "A26K_CLIENT_ID");
  assertEquals(body.meta.client_id, "");
});

// --- Bonus tests (spec §5 recommandés non-obligatoires) ---

Deno.test("returns 405 when method is not POST", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = new Request("http://localhost/ga4-fetch", { method: "GET" });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientOk(),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 405);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "error");
    assertEquals(body.errors[0].scope, "schema");
    assertStringIncludes(body.errors[0].message, "GET");
  });
});

Deno.test("returns 400 when request body is invalid JSON", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = new Request("http://localhost/ga4-fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientOk(),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 400);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "error");
    assertEquals(body.errors[0].scope, "schema");
    assertStringIncludes(body.errors[0].message, "Invalid JSON body");
  });
});

Deno.test("returns 400 when request schema is invalid", async () => {
  await withClientIdEnv(TEST_CLIENT_ID, async () => {
    const req = makePostRequest({ period: { start: "X", end: "Y" } });
    const res = await handleFetch(req, {
      ga4Client: mockGa4ClientOk(),
      persister: mockPersisterOk(),
    });
    assertEquals(res.status, 400);
    const body = (await res.json()) as GA4FetchResponse;
    assertEquals(body.status, "error");
    assertEquals(body.errors[0].scope, "schema");
    assertStringIncludes(body.errors[0].message, "Invalid request");
  });
});
