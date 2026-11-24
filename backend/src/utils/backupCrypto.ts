import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { appendFile, open, stat } from "fs/promises";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

// ── Backup encryption ────────────────────────────────────────────────────────
// Every artefact is encrypted on the host before it touches disk or the network,
// with AES-256-GCM and a per-file random salt/IV. The GCM tag proves the file was
// not modified; the plaintext SHA-256 in the manifest additionally proves the
// restored dump is byte-for-byte the one that was taken. The same key encrypts
// the manifest, so table names and row counts are not exposed by a stolen disk.
//
// File layout:
//   magic "CRMBKP01" (8) | HKDF salt (16) | IV (12) | ciphertext | GCM tag (16)

const MAGIC = Buffer.from("CRMBKP01", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;

export interface EncryptedFileInfo {
  sha256: string;
  plaintextBytes: number;
  ciphertextBytes: number;
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  // The key is a high-entropy operator secret, so HKDF is appropriate and cheap;
  // scrypt would add cost to every file for no security gain here.
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "utf8"), salt, Buffer.from("crm-backup-v1"), 32));
}

export async function encryptFile(
  sourcePath: string,
  destinationPath: string,
  masterKey: string
): Promise<EncryptedFileInfo> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey, salt), iv, { authTagLength: TAG_BYTES });
  const hash = createHash("sha256");
  let plaintextBytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      plaintextBytes += chunk.length;
      callback(null, chunk);
    },
  });

  const output = createWriteStream(destinationPath, { mode: 0o600 });
  output.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(sourcePath), meter, cipher, output);
  await appendFile(destinationPath, cipher.getAuthTag());

  const info = await stat(destinationPath);
  return {
    sha256: hash.digest("hex"),
    plaintextBytes,
    ciphertextBytes: info.size,
  };
}

export async function readEncryptionHeader(path: string): Promise<{ headerBytes: number; tag: Buffer; size: number }> {
  const info = await stat(path);
  if (info.size < HEADER_BYTES + TAG_BYTES) throw new Error("encrypted file is truncated");

  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("not a CRM backup file (bad magic)");
    }
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES);
    return { headerBytes: HEADER_BYTES, tag, size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Decrypts `sourcePath` to `destinationPath` and returns the plaintext SHA-256.
 * A wrong key or a tampered byte makes GCM authentication fail before the caller
 * can use the dump.
 */
export async function decryptFile(
  sourcePath: string,
  destinationPath: string,
  masterKey: string
): Promise<{ sha256: string; plaintextBytes: number }> {
  const { headerBytes, tag, size } = await readEncryptionHeader(sourcePath);

  const handle = await open(sourcePath, "r");
  let salt: Buffer;
  let iv: Buffer;
  try {
    const header = Buffer.alloc(headerBytes);
    await handle.read(header, 0, headerBytes, 0);
    salt = Buffer.from(header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES));
    iv = Buffer.from(header.subarray(MAGIC.length + SALT_BYTES, headerBytes));
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey, salt), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);

  const hash = createHash("sha256");
  let plaintextBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      plaintextBytes += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(
    createReadStream(sourcePath, { start: headerBytes, end: size - TAG_BYTES - 1 }),
    decipher,
    meter,
    createWriteStream(destinationPath, { mode: 0o600 })
  );

  return { sha256: hash.digest("hex"), plaintextBytes };
}
