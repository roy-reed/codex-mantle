import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    digest.update(chunk as Buffer);
  }

  return digest.digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
