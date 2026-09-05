/**
 * Keeps the vendored AdvantageScope NT4 client byte-identical to upstream.
 *
 * TypeScript 5.7 narrowed `BufferSource` to `ArrayBufferView<ArrayBuffer>`, so
 * `ws.send(someUint8Array)` in NT4.ts:460 no longer type-checks even though it
 * is correct at runtime (the array never comes from a SharedArrayBuffer).
 *
 * Widening the overload here rather than editing lib/nt4/NT4.ts means upstream
 * fixes can be re-pulled with a plain copy — see claude/webAppDesign.md §7.1.
 */
declare global {
  interface WebSocket {
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  }
}

export {};
