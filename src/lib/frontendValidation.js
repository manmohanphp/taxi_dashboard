const E164_PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const OTP_CODE_PATTERN = /^[0-9]{4,10}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidE164Phone(value) {
  return typeof value === "string" && E164_PHONE_PATTERN.test(value.trim());
}

export function normalizeIndianPhone(value) {
  if (typeof value !== "string") return "";
  const phone = value.trim();
  if (/^[6-9]\d{9}$/.test(phone)) return `+91${phone}`;
  if (/^\+91[6-9]\d{9}$/.test(phone)) return phone;
  return "";
}

export function isValidOtpCode(value) {
  return typeof value === "string" && OTP_CODE_PATTERN.test(value);
}

export function settlementPolicyError(value) {
  const policy = value == null ? "" : String(value);
  if (!policy) return "";
  if (policy.length < 3 || policy.length > 255) {
    return "Settlement policy must be between 3 and 255 characters, or left blank.";
  }
  return "";
}

export function createUuidV4(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      const uuid = cryptoApi.randomUUID();
      if (UUID_V4_PATTERN.test(uuid)) return uuid;
    } catch {
      // Fall back to getRandomValues when randomUUID is unavailable in this context.
    }
  }

  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new Error("Secure message ID generation is unavailable in this browser.");
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_V4_PATTERN.test(uuid)) throw new Error("Could not generate a valid message ID.");
  return uuid;
}

export function createConversationMessagePayload(message, cryptoApi) {
  const body = String(message ?? "").trim();
  if (!body) throw new Error("Enter a message before sending.");
  if (body.length > 4000) throw new Error("Messages must be 4000 characters or fewer.");
  return { client_message_id: createUuidV4(cryptoApi), body };
}
