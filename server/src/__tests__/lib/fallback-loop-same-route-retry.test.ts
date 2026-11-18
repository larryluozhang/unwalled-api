import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// v1.2.13: same-route transient retry. A single-candidate chain (cc-main
// pinned to one paid key) used to bench its only key for 90s on the first
// transient blip, so the client's own retries all hit the bench ("Repeated
// 529"). Transient transport failures (fetch failed / timeout / 5xx) must be
// retried WITHOUT failure bookkeeping — no cooldown, no skip, no penalty —
// while rate-limit/quota/auth failures and client aborts never take this path.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  sameRouteTransientMax,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 700;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: 424000 + n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

function hooksSkeleton(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

const fetchFailed = () => new Error('fetch failed');

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  // Keep the backoffs negligible; each test restores via afterEach.
  process.env.FALLBACK_SAME_ROUTE_TRANSIENT_BASE_MS = '5';
  process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES = '2';
});

afterEach(() => {
  delete process.env.FALLBACK_SAME_ROUTE_TRANSIENT_BASE_MS;
  delete process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES;
});

describe('same-route transient retry (v1.2.13)', () => {
  it('absorbs transient blips without benching or skipping the key', async () => {
    const route = fakeRoute();
    let dispatches = 0;
    const onExhausted = vi.fn();
    const onRoutingExhausted = vi.fn();
    const hooks = hooksSkeleton({
      sameRouteTransientRetry: true,
      route: () => route,
      onExhausted,
      onRoutingExhausted,
      dispatch: async () => {
        dispatches++;
        if (dispatches <= 2) throw fetchFailed();
        return 'done';
      },
    });
    await runFallbackLoop(hooks);
    expect(dispatches).toBe(3);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onRoutingExhausted).not.toHaveBeenCalled();
    // The absorbed blips recorded NO failure bookkeeping.
    expect(hooks.state.skipKeys.size).toBe(0);
    expect(hooks.state.skipModels.size).toBe(0);
  });

  it('benches the key only after the retry budget is spent', async () => {
    const route = fakeRoute();
    let routeCalls = 0;
    let dispatches = 0;
    const onRoutingExhausted = vi.fn();
    const hooks = hooksSkeleton({
      sameRouteTransientRetry: true,
      route: () => {
        routeCalls++;
        if (routeCalls > 3) throw new Error('no candidates left');
        return route;
      },
      onRoutingExhausted,
      dispatch: async () => { dispatches++; throw fetchFailed(); },
    });
    await runFallbackLoop(hooks);
    expect(dispatches).toBe(3); // 1 + 2 same-route retries
    // The final failure took the normal path: request-scoped skip recorded,
    // next route() found nothing, exhaustion rendered honestly.
    expect(hooks.state.skipKeys.size).toBe(1);
    expect(onRoutingExhausted).toHaveBeenCalledTimes(1);
    const exhaustion = onRoutingExhausted.mock.calls[0][2];
    expect(exhaustion.status).toBe(502);
  });

  it('stays off for multi-candidate chains (flag unset, #788 semantics intact)', async () => {
    const route = fakeRoute();
    let dispatches = 0;
    let routeCalls = 0;
    const onRoutingExhausted = vi.fn();
    const hooks = hooksSkeleton({
      // sameRouteTransientRetry deliberately NOT set — multi-candidate chain.
      route: () => {
        routeCalls++;
        if (routeCalls > 1) throw new Error('no candidates left');
        return route;
      },
      onRoutingExhausted,
      dispatch: async () => { dispatches++; throw fetchFailed(); },
    });
    await runFallbackLoop(hooks);
    expect(dispatches).toBe(1); // no penalty-free retry: straight to benching
    expect(hooks.state.skipKeys.size).toBe(1);
    expect(onRoutingExhausted).toHaveBeenCalledTimes(1);
  });

  it('never same-route retries rate-limit failures', async () => {
    const route = fakeRoute();
    let dispatches = 0;
    let routeCalls = 0;
    const onRoutingExhausted = vi.fn();
    const hooks = hooksSkeleton({
      route: () => {
        routeCalls++;
        if (routeCalls > 1) throw new Error('no candidates left');
        return route;
      },
      onRoutingExhausted,
      dispatch: async () => {
        dispatches++;
        const e: any = new Error('429 too many requests');
        e.status = 429;
        throw e;
      },
    });
    await runFallbackLoop(hooks);
    expect(dispatches).toBe(1);
    expect(onRoutingExhausted).toHaveBeenCalledTimes(1);
  });

  it('never same-route retries after the client disconnected', async () => {
    const route = fakeRoute();
    let dispatches = 0;
    let routeCalls = 0;
    const onRoutingExhausted = vi.fn();
    const hooks = hooksSkeleton({
      sameRouteTransientRetry: true,
      clientGone: () => true,
      route: () => {
        routeCalls++;
        if (routeCalls > 1) throw new Error('no candidates left');
        return route;
      },
      onRoutingExhausted,
      dispatch: async () => { dispatches++; throw fetchFailed(); },
    });
    await runFallbackLoop(hooks);
    expect(dispatches).toBe(1);
    // No same-route retry: the failure went straight to recordRetryableFailure
    // (skip recorded), and the loop-top clientGone stop renders no exhaustion
    // body — there is no socket left to write it to.
    expect(hooks.state.skipKeys.size).toBe(1);
    expect(onRoutingExhausted).not.toHaveBeenCalled();
  });

  it('caps the retry budget at the configured maximum', () => {    process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES = '4';
    expect(sameRouteTransientMax()).toBe(4);
    process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES = '99';
    expect(sameRouteTransientMax()).toBe(5); // hard cap
    process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES = '0';
    expect(sameRouteTransientMax()).toBe(0);
    delete process.env.FALLBACK_SAME_ROUTE_TRANSIENT_RETRIES;
    expect(sameRouteTransientMax()).toBe(2); // default
  });
});
