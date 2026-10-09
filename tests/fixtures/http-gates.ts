// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

// Local fixture coordination only. The registry retains signals and counters,
// never requests, SQL, parameters, results, source content, or credentials.
const signal = () => {
  let done = false;
  return {
    isDone: () => done,
    resolve: () => {
      done = true;
    },
  };
};

const wait = async (condition: ReturnType<typeof signal>) => {
  // Each waiting request owns its timer I/O. Do not share pending promises
  // created in a completed request's workerd I/O context. Polling only observes
  // explicit coordination signals: time passing NEVER releases a database call
  // or establishes its commit order. The deadline fails rather than releases.
  const deadline = Date.now() + 12_000;
  while (!condition.isDone()) {
    if (Date.now() >= deadline) throw new Error('Local fixture gate timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const gate = (kind: 'batch' | 'read') => ({
  kind,
  claims: 0,
  executions: 0,
  arrived: signal(),
  release: signal(),
  committed: signal(),
  respond: signal(),
});

const safeKey = (key: string) => /^[A-Za-z0-9_-]{1,64}$/.test(key);
const success = () => Response.json({ gate: true });
const failure = (error: string, status: number) =>
  Response.json({ error }, { status });

const gatedBinding = (
  binding: D1Database,
  controls: ReturnType<typeof gate>,
) => {
  const execute = async <T>(operation: () => Promise<T>) => {
    // One matching binding operation per request/key. Subsequent operations
    // remain real, uncoordinated calls (not fabricated or cached results).
    if (controls.executions++ !== 0) return await operation();
    controls.arrived.resolve();
    await wait(controls.release);
    try {
      // The captured value lives only in this invocation's stack, NOT the map.
      return await operation();
    } finally {
      // Completion includes rejection/rollback. Forward the original rejection
      // too, but only after the harness permits the HTTP response to proceed.
      controls.committed.resolve();
      await wait(controls.respond);
    }
  };

  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          ['raw', 'all', 'run', 'first'].includes(String(property))
            ? execute(async () => Reflect.apply(value, target, args))
            : Reflect.apply(value, target, args);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };

  return {
    prepare: (query: string) =>
      controls.kind === 'read'
        ? wrap(binding.prepare(query))
        : binding.prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => {
      // D1 must receive the exact original prepared/bound statements, not
      // proxies. A read gate does NOT intercept statements executed in a batch.
      const original = statements.map(
        (statement) => originals.get(statement) ?? statement,
      );
      return controls.kind === 'batch'
        ? execute(() => binding.batch<T>(original))
        : binding.batch<T>(original);
    },
    exec: binding.exec.bind(binding),
    dump: binding.dump.bind(binding),
    withSession: binding.withSession.bind(binding),
  } satisfies D1Database;
};

export const createHttpGates = () => {
  const gates = new Map<string, ReturnType<typeof gate>>();

  const control = async (request: Request) => {
    const url = new URL(request.url);
    if (
      url.pathname !== '/fixture/http-gates' &&
      !url.pathname.startsWith('/fixture/http-gates/')
    ) {
      return;
    }
    const match = /^\/fixture\/http-gates\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    const key = match?.[1];
    const action = match?.[2];
    if (!key || !action || !safeKey(key)) return failure('INVALID_GATE', 400);
    if (
      !['arm', 'release', 'respond', 'arrived', 'committed'].includes(action)
    ) {
      return failure('UNKNOWN_GATE_ACTION', 404);
    }
    const method = ['arrived', 'committed'].includes(action) ? 'GET' : 'POST';
    if (request.method !== method) return failure('METHOD_NOT_ALLOWED', 405);
    if (action === 'arm') {
      const kind = url.searchParams.get('kind');
      if (kind !== 'batch' && kind !== 'read')
        return failure('INVALID_KIND', 400);
      if (gates.has(key)) return failure('GATE_ALREADY_ARMED', 409);
      gates.set(key, gate(kind));
      return success();
    }
    const controls = gates.get(key);
    if (!controls) return failure('GATE_NOT_FOUND', 404);
    switch (action) {
      case 'release':
        controls.release.resolve();
        break;
      case 'respond':
        controls.respond.resolve();
        break;
      case 'arrived':
        await wait(controls.arrived);
        break;
      case 'committed':
        await wait(controls.committed);
        break;
    }
    return success();
  };

  const run = async (
    request: Request,
    binding: D1Database,
    next: (db: D1Database) => Response | Promise<Response>,
  ) => {
    const key = request.headers.get('X-Fixture-Gate');
    if (key === null) return await next(binding);
    if (!safeKey(key)) return failure('INVALID_GATE', 400);
    const controls = gates.get(key);
    if (!controls) return failure('GATE_NOT_FOUND', 404);
    if (controls.claims !== 0) return failure('GATE_ALREADY_CLAIMED', 409);
    controls.claims++;
    try {
      return await next(gatedBinding(binding, controls));
    } finally {
      // Also clean up when Hono rejects before reaching D1. Waits are bounded
      // by the external test harness, rather than sleeps or fixture timers.
      gates.delete(key);
    }
  };

  return { control, run };
};
