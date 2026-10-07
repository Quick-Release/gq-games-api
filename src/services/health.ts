import { Effect } from 'effect';

// Effect is the application boundary; infrastructure stays out of the runtime.
export const getHealth = Effect.sync(() => ({
  service: 'gq-games-api',
  status: 'ok',
  maturity: 'research',
}));
