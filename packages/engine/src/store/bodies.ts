import type { BodyCodec, BodyRecord, StoreReader } from './port';

/** Codec 0: the record's JSON as UTF-8, for tiny bodies and hosts without a compressor. */
const RAW: BodyCodec = {
  encode: data => ({ codec: 0, data }),
  decode: (codec, data) => {
    if (codec !== 0) throw new Error(`Body codec ${codec} needs the host's BodyCodec`);
    return data;
  },
};

export function encodeBody(body: BodyRecord, codec: BodyCodec = RAW) {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  return { rawSize: raw.byteLength, ...codec.encode(raw) };
}

/** A stored body record, decoded; undefined when absent or evicted. */
export function readBody(
  q: StoreReader,
  accountId: string,
  remoteId: string,
  codec: BodyCodec = RAW,
): BodyRecord | undefined {
  const row = q.get<{ codec: number; data: Uint8Array }>(
    'SELECT b.codec, b.data FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.account_id = ? AND m.remote_id = ?',
    accountId,
    remoteId,
  );
  if (!row) return undefined;
  return JSON.parse(new TextDecoder().decode(codec.decode(row.codec, row.data))) as BodyRecord;
}
