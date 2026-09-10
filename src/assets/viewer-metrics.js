// Bounded, session-only diagnostics. Nothing is transmitted or persisted.
export function createLoadingMetrics(clock = () => performance.now()) {
  let generation = 0;
  let started = clock();
  let entries = [];
  return {
    reset() { generation += 1; started = clock(); entries = []; },
    start(name, details = {}) {
      const token = generation;
      const begin = clock();
      let done = false;
      return (status = 'ok') => {
        if (done || token !== generation) return;
        done = true;
        entries.push({ name, ...details, status, startMs: Math.round(begin - started), durationMs: Math.round(clock() - begin) });
        if (entries.length > 100) entries.shift();
      };
    },
    async measure(name, action) {
      const finish = this.start(name);
      try { const value = await action(); finish(); return value; }
      catch (error) { finish(error?.name === 'AbortError' ? 'cancelled' : 'error'); throw error; }
    },
    snapshot() { return entries.map(entry => ({ ...entry })); },
  };
}
