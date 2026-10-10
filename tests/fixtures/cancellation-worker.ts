// Copyright (C) 2026 gq-games-api contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See LICENSE in the repository root.

import { createApp } from '../../src/app';
import type { WorkerEnv } from '../../src/env';
import type { CatalogHttpOptions } from '../../src/http/catalog';
import {
  createCancellationGates,
  waitForResultRelease,
} from './cancellation-gates';

// Bundled only by the local-only cancellation stack, never production.
const gates = createCancellationGates();

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const control = gates.control(request);
    if (control) return control;
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ready');
    const inspection = /^\/fixture\/inspect\/([1-9][0-9]{0,9})$/.exec(
      url.pathname,
    );
    if (inspection) {
      // Narrow independent persisted-state evidence, through the original D1.
      const row = await env.DB.prepare(
        'select state from steam_application_publication where steam_app_id = ?',
      )
        .bind(Number(inspection[1]))
        .first<{ state: string }>();
      return Response.json({ state: row?.state ?? null });
    }
    const snapshot = /^\/fixture\/snapshot\/(91[0-9]{2})$/.exec(url.pathname);
    if (snapshot) {
      const row = await env.DB.prepare(
        "select json_extract(event_id, '$') as eventId, observed_at as observedAt from steam_application_snapshot where steam_app_id = ?",
      )
        .bind(Number(snapshot[1]))
        .first<{ eventId: string; observedAt: number }>();
      return Response.json({ snapshot: row });
    }
    const controls = gates.claim(request);
    const observeAbort = () => {
      controls.physicalAborts++;
    };
    request.signal.addEventListener('abort', observeAbort, { once: true });
    const controlled =
      request.headers.get('X-Fixture-Controlled-Abort') === '1';
    const controller = new AbortController();
    const poll = controlled
      ? setInterval(() => {
          if (controls.abort) controller.abort();
        }, 5)
      : undefined;
    const target = controlled
      ? new Request(request, { signal: controller.signal })
      : request;
    const wrapRead = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(original, property) {
          if (property === 'bind')
            return (...values: unknown[]) => wrapRead(original.bind(...values));
          const value: unknown = Reflect.get(original, property, original);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (!['raw', 'all', 'run', 'first'].includes(String(property)))
              return Reflect.apply(value, original, args);
            controls.reads++;
            // Invoke the actual statement immediately; withhold only its result.
            const pending: Promise<unknown> = Reflect.apply(
              value,
              original,
              args,
            );
            const held = pending.then(
              async (result) => {
                controls.settled++;
                controls.succeeded++;
                await waitForResultRelease(controls);
                controls.forwarded++;
                return result;
              },
              (error: unknown) => {
                controls.settled++;
                controls.failed++;
                throw error;
              },
            );
            // Fixture-only host allowance for the already-started producer, NOT
            // a second Effect runner. Keep the late-result control executable
            // after the connected read has reported its interrupted Exit.
            if (controlled) ctx.waitUntil(held);
            return held;
          };
        },
      });
    const binding = {
      prepare: (query: string) =>
        controls.kind === 'read'
          ? wrapRead(env.DB.prepare(query))
          : env.DB.prepare(query),
      batch<T = unknown>(statements: D1PreparedStatement[]) {
        controls.batches++;
        // No asynchronous gap before the REAL binding invocation.
        const pending = env.DB.batch<T>(
          controls.kind === 'sql-failure'
            ? [
                ...statements,
                env.DB.prepare(
                  'select * from cancellation_fixture_missing_table',
                ),
              ]
            : statements,
        );
        return pending.then(
          async (result) => {
            controls.settled++;
            controls.succeeded++;
            if (controls.kind === 'batch') await waitForResultRelease(controls);
            // Fault only the post-commit payload consumed by the real decoder;
            // the original binding has already succeeded. No rollback fiction.
            return controls.kind === 'decode-failure'
              ? result.map((entry) => ({ ...entry, results: [] }))
              : result;
          },
          async (error: unknown) => {
            controls.settled++;
            controls.failed++;
            if (controls.kind === 'batch') await waitForResultRelease(controls);
            throw error;
          },
        );
      },
      exec: env.DB.exec.bind(env.DB),
      dump: env.DB.dump.bind(env.DB),
      withSession: env.DB.withSession.bind(env.DB),
    } satisfies D1Database;
    let requestId: string | undefined;
    const options = {
      allowInsecureLocalTest: true,
      beforeMutation: gates.beforeMutation(controls),
      observeLifecycle: (event) => {
        requestId ??= event.requestId;
        controls.correlated &&=
          requestId === event.requestId &&
          /^[A-Za-z0-9_-]{1,64}$/.test(event.requestId);
        switch (event.event) {
          case 'request_aborted':
            controls.request_aborted++;
            if (event.phase === 'before_dispatch')
              controls.abortBeforeDispatch++;
            else controls.abortAfterDispatch++;
            break;
          case 'write_dispatched':
            controls.write_dispatched++;
            break;
          case 'write_succeeded':
            controls.write_succeeded++;
            if (event.phase === 'outcome_observed') controls.observedOutcomes++;
            break;
          case 'write_failed':
            controls.write_failed++;
            if (event.phase === 'outcome_observed') controls.observedOutcomes++;
            break;
          case 'effect_exit':
            controls.effect_exit++;
            break;
          case 'body_reader_acquired':
            controls.body_reader_acquired++;
            controls.readerLocked ||= target.body?.locked === true;
            break;
          case 'body_reader_released':
            controls.body_reader_released++;
            // Observe actual native stream ownership, not just a label that
            // could have fired at the start of a release attempt.
            controls.readerUnlocked ||= target.body?.locked === false;
            break;
          case 'cleanup_complete':
            controls.cleanup_complete++;
            break;
        }
        if (event.event !== 'effect_exit') return;
        switch (event.outcome) {
          case 'interrupted':
            controls.interrupted++;
            break;
          case 'success':
            controls.success++;
            break;
          case 'failure':
            controls.failure++;
            break;
          case 'defect':
            controls.defect++;
            break;
        }
      },
    } satisfies CatalogHttpOptions;
    try {
      const response = await createApp(options).fetch(
        target,
        { ...env, DB: binding },
        ctx,
      );
      controls.headers++;
      controls.correlated &&=
        response.headers.get('X-Request-ID') === requestId;
      return response;
    } finally {
      request.signal.removeEventListener('abort', observeAbort);
      if (poll !== undefined) clearInterval(poll);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
