import type { Autumn } from "autumn-js";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import {
  disabledBillingCheck,
  disabledBillingCustomer,
  isBillingDisabled,
} from "@/server/billing/billing-disabled";

let autumnPromise: Promise<Autumn> | undefined;

// Lazy: keeps the ~450 kB autumn-js SDK out of the eager isolate startup
// graph (self-hosted deployments never load it at all); resolves instantly
// after the first call.
function loadAutumn(): Promise<Autumn> {
  return (autumnPromise ??= import("autumn-js").then(
    ({ Autumn }) =>
      new Autumn({
        secretKey: () => getRequiredEnvValue("AUTUMN_SECRET_KEY"),
        // Without this client-wide value the SDK aborts check/track after
        // 5s; a per-call timeoutMs cannot raise it. A timed-out call fails
        // open: track then never charges the usage, and check returns no
        // balance.
        timeoutMs: 10_000,
        // Retries 429/500/502/503/504 (per-operation retryCodes) plus
        // connection errors. Cloudflare 52x statuses are not in the SDK's
        // retry list, so those still surface immediately.
        //
        // These reads/gates (customers.getOrCreate, check) sit on the request
        // hot path, so keep the total retry window short: when Autumn is
        // rate-limiting or slow, an 8s backoff window held the isolate open
        // for seconds on every request and cascaded into region-wide
        // congestion (incident 2026-07-06). Fail fast instead — a caller that
        // can't gate surfaces an error rather than hanging.
        retryConfig: {
          strategy: "backoff",
          backoff: {
            initialInterval: 250,
            maxInterval: 1000,
            exponent: 1.5,
            maxElapsedTime: 2500,
          },
          retryConnectionErrors: true,
        },
      }),
  ));
}

/** Shape-preserving lazy facade over the SDK client: call sites keep the
 *  plain `autumn.check(...)` form. Covers only the methods we use — add a
 *  line here when adopting a new one.
 *
 *  Fork patch (ypsum): with OPENSEO_DISABLE_BILLING=1 every method answers
 *  locally (unlimited, nothing metered) and the SDK is never loaded. */
export const autumn = {
  check: async (...args: Parameters<Autumn["check"]>) =>
    (await isBillingDisabled())
      ? (disabledBillingCheck(args[0]) as unknown as Awaited<
          ReturnType<Autumn["check"]>
        >)
      : loadAutumn().then((client) => client.check(...args)),
  track: async (...args: Parameters<Autumn["track"]>) =>
    (await isBillingDisabled())
      ? ({} as Awaited<ReturnType<Autumn["track"]>>)
      : loadAutumn().then((client) => client.track(...args)),
  customers: {
    getOrCreate: async (
      ...args: Parameters<Autumn["customers"]["getOrCreate"]>
    ) =>
      (await isBillingDisabled())
        ? (disabledBillingCustomer(args[0].customerId) as unknown as Awaited<
            ReturnType<Autumn["customers"]["getOrCreate"]>
          >)
        : loadAutumn().then((client) => client.customers.getOrCreate(...args)),
    get: async (...args: Parameters<Autumn["customers"]["get"]>) =>
      (await isBillingDisabled())
        ? (disabledBillingCustomer(args[0].customerId) as unknown as Awaited<
            ReturnType<Autumn["customers"]["get"]>
          >)
        : loadAutumn().then((client) => client.customers.get(...args)),
  },
  balances: {
    // Confirms or releases a hold taken by `check({ lock })`. Not in the
    // SDK's fail-open set, so a lost deduction surfaces as an error.
    finalize: async (...args: Parameters<Autumn["balances"]["finalize"]>) =>
      (await isBillingDisabled())
        ? ({ success: true } as Awaited<
            ReturnType<Autumn["balances"]["finalize"]>
          >)
        : loadAutumn().then((client) => client.balances.finalize(...args)),
  },
};

// track() has no idempotency key, so replaying a deduction Autumn already
// processed (5xx after a successful write, dropped connection) would
// double-charge. Retry only 429s, which are rejected before processing.
// Lock checks and balances.finalize() use the same options: a replayed lock
// check surfaces 409 lock_already_exists, and a replayed finalize surfaces
// "Lock not found", on the caller's first attempt, where neither can be told
// apart from a real failure. None sets a per-call timeoutMs, so all get the
// client-wide 10s; finalize does not fail open, so a shorter deadline would
// drop deductions that Autumn completes in 5-10s.
export const AUTUMN_TRACK_RETRY_OPTIONS: Parameters<Autumn["track"]>[1] = {
  retryCodes: ["429"],
  retries: {
    strategy: "backoff",
    backoff: {
      initialInterval: 250,
      maxInterval: 2000,
      exponent: 1.5,
      maxElapsedTime: 8000,
    },
    retryConnectionErrors: false,
  },
};
