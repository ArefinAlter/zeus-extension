// A scripted fetch for the in-browser fetch proxy and the refetch refresh method. Responses are
// real `Response` objects with a streamed body, so the code under test exercises the same reader
// API it uses in a browser. It records every request (URL, init) for assertions.

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Final URL after redirects (Response.url). Defaults to the request URL. */
  url?: string;
  redirected?: boolean;
  /** Body delivered as these pieces, in order (each piece one reader.read()). */
  body?: Uint8Array[];
  /** Never close the body after the last piece (a stalled server). */
  hang?: boolean;
  /** Reject fetch() itself with this error (network failure). */
  fail?: Error;
  /** Delay before the response headers resolve, in ms of (fake) time. */
  delayMs?: number;
}

export interface RecordedRequest {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

type Handler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private handler: Handler = () => ({ status: 404 });
  /** Number of response bodies cancelled by the consumer. */
  cancelledBodies = 0;
  /** Body pieces the stream was asked to produce (pull calls): shows whether the consumer applies backpressure. */
  piecesPulled = 0;

  respondWith(handler: Handler | FakeResponse): void {
    this.handler = typeof handler === 'function' ? handler : () => handler;
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const record: RecordedRequest = { url, init, headers };
    this.requests.push(record);
    const spec = await this.handler(record);
    const signal = init.signal ?? undefined;
    if (spec.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, spec.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(abortError());
        });
      });
    }
    if (signal?.aborted) throw abortError();
    if (spec.fail) throw spec.fail;
    if (spec.redirected && init.redirect === 'error') throw new TypeError('Redirect refused');
    const pieces = spec.body ?? [];
    let index = 0;
    const countPull = (): void => {
      this.piecesPulled += 1;
    };
    const countCancel = (): void => {
      this.cancelledBodies += 1;
    };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(abortError());
          return;
        }
        const piece = pieces[index++];
        if (piece !== undefined) {
          countPull();
          controller.enqueue(piece);
        } else if (spec.hang) {
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(abortError());
            });
          });
        } else {
          controller.close();
        }
        return undefined;
      },
      cancel() {
        countCancel();
      },
    });
    const status = spec.status ?? 200;
    const nullBody = status === 204 || status === 205 || status === 304;
    const res = new Response(nullBody ? null : stream, { status, headers: spec.headers ?? {} });
    Object.defineProperty(res, 'url', { value: spec.url ?? url });
    Object.defineProperty(res, 'redirected', { value: spec.redirected ?? false });
    return res;
  };
}

/** `n` bytes of a repeating pattern starting at `offset`, so tests can verify content and position. */
export function pattern(offset: number, n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (offset + i) % 251);
}

/** Split bytes into pieces of the given size (the last may be shorter). */
export function splitPieces(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}
