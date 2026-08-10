/**
 * `@jobmonitor/telemetry-schema` — the contract between the desktop client and the ingest receiver.
 *
 * Everything that both sides must agree on lives here and nowhere else: the wire format, the id
 * registries, every size limit, the encryption, and the transport envelope. The alternative — a copy on
 * each side — fails silently rather than loudly, because the receiver *drops* records carrying ids
 * it does not recognise and *rejects* payloads outside limits it does not share. A dashboard that
 * quietly reads low is a much worse failure than a build that goes red.
 */

// Wire format
export {
  TelemetryBatchSchema,
  FeatureUsageSchema,
  OperationUsageSchema,
  FailureCountSchema,
  UsageSummarySchema,
  CrashRecordSchema,
  Platform,
  Arch,
  CrashSource,
  file_jobmonitor_telemetry_v1_telemetry,
} from './gen/jobmonitor/telemetry/v1/telemetry_pb';

export type {
  TelemetryBatch,
  FeatureUsage,
  OperationUsage,
  FailureCount,
  UsageSummary,
  CrashRecord,
} from './gen/jobmonitor/telemetry/v1/telemetry_pb';

// Codec
export { encodeBatch, decodeBatch } from './codec';

// Encryption
export {
  conversationKey,
  encrypt,
  encryptWithNonce,
  decrypt,
  messageKeys,
  calcPaddedLen,
  bytesToBase64,
  base64ToBytes,
} from './nip44';
export type { MessageKeys } from './nip44';

// Transport envelope (Ably pub/sub)
export {
  TELEMETRY_CHANNEL,
  TELEMETRY_MESSAGE_NAME,
  ENVELOPE_VERSION,
  ABLY_PUBLISH_KEY,
  RECEIVER_PUBKEY_HEX,
  DEPLOYMENT_ID_HEX,
  assertConfigured,
  sealBatch,
  openBatch,
} from './channel';
export type { TelemetryMessage } from './channel';

// Registries
export { Feature, Features, FEATURE_DEFS } from './registry/features';
export { Operation, Operations, OPERATION_DEFS } from './registry/operations';
export { ErrorCategory, ErrorCategories, ERROR_CATEGORY_DEFS } from './registry/errorCategories';
export { buildRegistry, idEnum } from './registry/registry';
export type { Def, Registry, IdOf } from './registry/registry';

// Limits
export * from './limits';
