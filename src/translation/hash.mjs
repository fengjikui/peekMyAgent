import crypto from "node:crypto";
import { translationLookupKey } from "./blocks.mjs";

export function translationMaterialHash(kind, sourceText) {
  return sha256Text(translationLookupKey(kind, sourceText));
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
