import type { BatchState, DeliveryCheckpoint, ExecutionMode, RemoteDeliveryState, StoredBatch, UserBatchStatus } from './types.js';

/**
 * The user-facing lifecycle is intentionally derived from the existing
 * recovery rules.  It does not add another persisted state machine.
 */
export interface BatchLifecycleSnapshot {
  state: BatchState;
  executionMode: ExecutionMode | null;
  baseCommit: string | null;
  validation: unknown | null;
  errorCode: string | null;
  delivery: Pick<RemoteDeliveryState, 'checkpoint' | 'branch' | 'commitSha' | 'pullRequest'>;
}

const postPushRetryableErrorCodes = new Set([
  'GIT_COMMAND_FAILED',
  'GIT_COMMAND_TIMEOUT',
  'GITHUB_API_REQUEST_FAILED',
  'GITHUB_API_RESPONSE_INVALID',
  'GITHUB_API_TIMEOUT',
  'WORKER_INTERRUPTED',
]);

const prePushRetryableErrorCodes = new Set([
  'GIT_COMMAND_FAILED',
  'GIT_COMMAND_TIMEOUT',
  'ICON_BATCH_COMMAND_TIMEOUT',
  'ICON_BATCH_DEPENDENCY_INSTALL_TIMEOUT',
  'WORKER_INTERRUPTED',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationIsInvalid(value: unknown): boolean {
  return isObject(value) && value.valid === false;
}

function validationErrorCodes(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.errors)) return [];
  return value.errors.flatMap((error) => isObject(error) && typeof error.code === 'string' ? [error.code] : []);
}

// These are request/SVG/selected-target rules a designer can correct in the
// editor. Repository, catalog, supply-chain and platform diagnostics are not
// presented as a designer-editable failure.
const designerCorrectableValidationErrorCodes = new Set([
  'REQUEST_SCHEMA_INVALID',
  'DUPLICATE_ITEM_ID',
  'BATCH_ACTION_CONFLICT',
  'SOURCE_FILE_MISSING',
  'SVG_INVALID_XML',
  'SVG_MISSING_VIEWBOX',
  'SVG_SCRIPT',
  'SVG_EXTERNAL_RESOURCE',
  'SVG_EMBEDDED_BITMAP',
  'SVG_GRADIENT',
  'SVG_STYLE_ELEMENT',
  'SVG_MULTIPLE_COLORS',
  'SVG_LITERAL_COLOR',
  'ADD_NAME_COLLISION',
  'TARGET_NOT_FOUND',
  'DELETE_TARGET_IS_ALIAS',
  'REPLACE_CONTENT_UNCHANGED',
]);

export function hasDesignerCorrectableValidation(batch: Pick<BatchLifecycleSnapshot, 'validation' | 'delivery'>): boolean {
  if (batch.delivery.checkpoint !== 'NONE' || !validationIsInvalid(batch.validation)) return false;
  const errorCodes = validationErrorCodes(batch.validation);
  return errorCodes.length > 0 && errorCodes.every((code) => designerCorrectableValidationErrorCodes.has(code));
}

export function isFinalValidationFailure(batch: Pick<BatchLifecycleSnapshot, 'state' | 'validation' | 'delivery'>): boolean {
  return batch.state === 'FAILED'
    && hasDesignerCorrectableValidation(batch);
}

export function hasRetainedDesignerCorrectableValidation(batch: Pick<BatchLifecycleSnapshot, 'state' | 'validation' | 'delivery'>): boolean {
  return (batch.state === 'FAILED' || batch.state === 'DRAFT')
    && hasDesignerCorrectableValidation(batch);
}

export function hasPostPushPullRequestRecoveryEvidence(batch: Pick<BatchLifecycleSnapshot, 'executionMode' | 'baseCommit' | 'delivery'>): boolean {
  return batch.executionMode === 'remote'
    && Boolean(batch.baseCommit?.trim())
    && Boolean(batch.delivery.branch?.trim())
    && Boolean(batch.delivery.commitSha?.trim())
    && batch.delivery.pullRequest === null;
}

export function isRetryablePostPushInfrastructureFailure(errorCode: string | null | undefined): boolean {
  return errorCode !== null && errorCode !== undefined && postPushRetryableErrorCodes.has(errorCode);
}

export function canResumeDraftPullRequest(batch: BatchLifecycleSnapshot): boolean {
  return batch.state === 'FAILED'
    && (batch.delivery.checkpoint === 'BRANCH_PUSHED' || batch.delivery.checkpoint === 'PR_CREATING')
    && isRetryablePostPushInfrastructureFailure(batch.errorCode)
    && hasPostPushPullRequestRecoveryEvidence(batch);
}

export function canRetryBatch(batch: BatchLifecycleSnapshot): boolean {
  if (batch.state !== 'FAILED') return false;
  if (isFinalValidationFailure(batch)) return false;
  if (batch.delivery.checkpoint === 'NONE' || batch.delivery.checkpoint === 'COMMIT_PREPARED') {
    return batch.errorCode !== null && prePushRetryableErrorCodes.has(batch.errorCode);
  }
  return canResumeDraftPullRequest(batch);
}

export function isActiveBatch(batch: BatchLifecycleSnapshot): boolean {
  if (batch.state === 'DRAFT') return true;
  if (batch.state !== 'FAILED' && batch.state !== 'PR_CREATED' && batch.state !== 'LOCAL_DIFF_READY') return true;
  return isFinalValidationFailure(batch) || canRetryBatch(batch);
}

export function userStatusForBatch(batch: BatchLifecycleSnapshot): UserBatchStatus {
  if (batch.state === 'PR_CREATED') return 'submitted_review';
  if (batch.state === 'LOCAL_DIFF_READY') return 'local_complete';
  if (hasRetainedDesignerCorrectableValidation(batch)) return 'needs_changes';
  if (batch.state === 'DRAFT') return 'draft';
  if (batch.state !== 'FAILED') return 'processing';
  if (isFinalValidationFailure(batch)) return 'needs_changes';
  if (canRetryBatch(batch)) return 'delivery_retryable';
  return 'developer_attention';
}

export function lifecycleSnapshot(batch: Pick<StoredBatch, 'state' | 'executionMode' | 'baseCommit' | 'validation' | 'error' | 'delivery'>): BatchLifecycleSnapshot {
  return {
    state: batch.state,
    executionMode: batch.executionMode,
    baseCommit: batch.baseCommit,
    validation: batch.validation,
    errorCode: batch.error?.code ?? null,
    delivery: batch.delivery,
  };
}

export function isPostPushCheckpoint(checkpoint: DeliveryCheckpoint): boolean {
  return checkpoint === 'BRANCH_PUSHED' || checkpoint === 'PR_CREATING';
}
