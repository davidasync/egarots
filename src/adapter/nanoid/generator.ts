import { customAlphabet } from "nanoid";

import { GENERATED_ID_LEN } from "../../core/storage/entity";
import type { IdGenerator } from "../../core/storage/ports";

/**
 * Alphanumerics only. nanoid's default alphabet includes `-` and `_`, which
 * would emit ids outside the /^[A-Za-z0-9]{6,16}$/ that the dpaste client
 * extracts with. customAlphabet keeps the distribution uniform over a
 * non-power-of-two alphabet by rejection sampling, and draws from
 * crypto.getRandomValues, which Workers provides.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newGenerator(): IdGenerator {
  const nanoid = customAlphabet(ALPHABET, GENERATED_ID_LEN);
  return { next: () => nanoid() };
}
