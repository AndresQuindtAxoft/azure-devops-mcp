// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PolicyEvaluationRecord, PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces.js";

/**
 * Policy type ID for the built-in "Build" (build validation) policy, constant across
 * Azure DevOps Services and on-premises Azure DevOps Server / TFS.
 */
export const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

/**
 * Evaluation statuses considered "active" and protected from an accidental requeue by default:
 * a policy that already succeeded, is queued, or is currently running should not be disturbed
 * unless the caller explicitly selects it or opts in via `force`.
 */
export const PROTECTED_STATUSES: ReadonlySet<PolicyEvaluationStatus> = new Set([PolicyEvaluationStatus.Approved, PolicyEvaluationStatus.Queued, PolicyEvaluationStatus.Running]);

export function isBuildPolicyEvaluation(evaluation: PolicyEvaluationRecord): boolean {
  return evaluation.configuration?.type?.id === BUILD_POLICY_TYPE_ID;
}

export function isProtectedStatus(status: PolicyEvaluationStatus | undefined): boolean {
  return status !== undefined && PROTECTED_STATUSES.has(status);
}

export interface RequeueSelectionOptions {
  /** Explicit set of evaluation IDs to requeue, bypassing the active-state protection for those IDs only. */
  evaluationIds?: string[];
  /** Bypass the active-state protection for every build policy evaluation on the PR. */
  force?: boolean;
}

export interface SkippedEvaluation {
  evaluationId: string;
  reason: "not-a-build-policy" | "not-selected" | "protected-status" | "missing-evaluation-id";
  status?: PolicyEvaluationStatus;
}

export interface RequeueSelectionResult {
  toRequeue: PolicyEvaluationRecord[];
  skipped: SkippedEvaluation[];
}

/**
 * Selects which build-policy evaluation records on a pull request should be requeued.
 *
 * Non build-policy evaluations are always skipped. Among build-policy evaluations, anything
 * in an Approved/Queued/Running state is skipped unless the caller explicitly listed its
 * evaluationId in `evaluationIds`, or passed `force: true`.
 */
export function selectBuildPolicyEvaluationsToRequeue(evaluations: PolicyEvaluationRecord[], options: RequeueSelectionOptions = {}): RequeueSelectionResult {
  const { force = false } = options;
  const explicitSelection = options.evaluationIds && options.evaluationIds.length > 0 ? new Set(options.evaluationIds) : null;

  const toRequeue: PolicyEvaluationRecord[] = [];
  const skipped: SkippedEvaluation[] = [];

  for (const evaluation of evaluations) {
    const evaluationId = evaluation.evaluationId;
    if (!evaluationId) {
      skipped.push({ evaluationId: "<unknown>", reason: "missing-evaluation-id" });
      continue;
    }

    if (!isBuildPolicyEvaluation(evaluation)) {
      skipped.push({ evaluationId, reason: "not-a-build-policy", status: evaluation.status });
      continue;
    }

    if (explicitSelection && !explicitSelection.has(evaluationId)) {
      skipped.push({ evaluationId, reason: "not-selected", status: evaluation.status });
      continue;
    }

    const bypassProtection = force || explicitSelection !== null;
    if (isProtectedStatus(evaluation.status) && !bypassProtection) {
      skipped.push({ evaluationId, reason: "protected-status", status: evaluation.status });
      continue;
    }

    toRequeue.push(evaluation);
  }

  return { toRequeue, skipped };
}

/**
 * Builds the artifactId used by the Policy Evaluations API to identify a pull request:
 * `vstfs:///CodeReview/CodeReviewId/{projectId}/{pullRequestId}`.
 */
export function buildPullRequestArtifactId(projectId: string, pullRequestId: number): string {
  return `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
}
