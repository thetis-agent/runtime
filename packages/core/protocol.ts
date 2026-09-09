/** Negotiate only control and completion metadata across the monitor channel; ADR 0019, ADR 0027. */
export const capabilities = ['health.probe', 'session.list', 'session.create', 'session.submit', 'session.cancel', 'run.stop', 'env.updated'];
