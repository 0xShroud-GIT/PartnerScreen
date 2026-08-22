export type PeerTransportDisposition = 'connected' | 'disconnected' | 'failed' | 'pending';

export function peerTransportDisposition(
  connectionState: string | undefined,
  iceConnectionState: string | undefined,
): PeerTransportDisposition {
  if (connectionState === 'failed' || iceConnectionState === 'failed') return 'failed';
  if (connectionState === 'disconnected' || iceConnectionState === 'disconnected') return 'disconnected';
  if (
    connectionState === 'connected' &&
    (iceConnectionState === 'connected' || iceConnectionState === 'completed')
  ) return 'connected';
  return 'pending';
}

export type TimedPromiseResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

/**
 * Settles a promise without allowing a late rejection to become unhandled. The timeout is cleared
 * as soon as the source promise settles. If timeout wins, the source promise remains observed so a
 * caller can separately clean up a late fulfillment when the underlying platform cannot be cancelled.
 */
export function settlePromiseWithTimeout<T>(
  source: Promise<T>,
  timeoutMs: number,
): Promise<TimedPromiseResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: TimedPromiseResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(result);
    };

    timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    source.then(
      (value) => finish({ status: 'fulfilled', value }),
      (error) => finish({ status: 'rejected', error }),
    );
  });
}
