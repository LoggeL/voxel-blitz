export function abortError(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

export function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(abortError(signal, 'operation aborted'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(null), ms);
    const onAbort = () => finish(abortError(signal, 'operation aborted'));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectSleep(error);
      else resolveSleep();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function withTimeout(promise, ms, label, signal) {
  return new Promise((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(abortError(signal, label));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(new Error(label)), ms);
    const onAbort = () => finish(abortError(signal, label));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectWait(error);
      else resolveWait(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(null, value),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
