/**
 * Executes fetch and consumes its response body under a single end-to-end
 * AbortController deadline so stalled response streams abort reliably.
 */
export async function withFetchTimeout<T>(
  input: RequestInfo | URL,
  consume: (response: Response) => Promise<T>,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<T> {
  const controller = new AbortController();
  const external = init.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Prevent unhandled rejection if fetch/consume settles normally before timeout.
  abortPromise.catch(() => {});
  const abortNow = () => {
    controller.abort();
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    rejectAbort?.(err);
  };
  timer = setTimeout(abortNow, timeoutMs);
  const onExternalAbort = () => abortNow();
  if (external) {
    if (external.aborted) abortNow();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const response = await Promise.race([fetch(input, { ...init, signal: controller.signal }), abortPromise]);
    return await Promise.race([consume(response), abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}
