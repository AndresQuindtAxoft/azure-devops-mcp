// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PolicyEvaluationRecord, PolicyEvaluationStatus } from "azure-devops-node-api/interfaces/PolicyInterfaces.js";
import { BUILD_POLICY_TYPE_ID, buildPullRequestArtifactId, isBuildPolicyEvaluation, isProtectedStatus, selectBuildPolicyEvaluationsToRequeue } from "../../src/shared/policy-requeue";

const OTHER_POLICY_TYPE_ID = "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd"; // Minimum number of reviewers

function buildEvaluation(overrides: Partial<PolicyEvaluationRecord> = {}): PolicyEvaluationRecord {
  return {
    evaluationId: "eval-1",
    status: PolicyEvaluationStatus.Rejected,
    configuration: {
      isBlocking: true,
      isEnabled: true,
      settings: {},
      type: { id: BUILD_POLICY_TYPE_ID },
    },
    ...overrides,
  };
}

describe("policy-requeue helpers", () => {
  describe("isBuildPolicyEvaluation", () => {
    it("returns true for build policy evaluations", () => {
      expect(isBuildPolicyEvaluation(buildEvaluation())).toBe(true);
    });

    it("returns false for non-build policy evaluations", () => {
      expect(isBuildPolicyEvaluation(buildEvaluation({ configuration: { isBlocking: true, isEnabled: true, settings: {}, type: { id: OTHER_POLICY_TYPE_ID } } }))).toBe(false);
    });

    it("returns false when configuration/type is missing", () => {
      expect(isBuildPolicyEvaluation(buildEvaluation({ configuration: undefined }))).toBe(false);
    });
  });

  describe("isProtectedStatus", () => {
    it.each([PolicyEvaluationStatus.Approved, PolicyEvaluationStatus.Queued, PolicyEvaluationStatus.Running])("treats %s as protected", (status) => {
      expect(isProtectedStatus(status)).toBe(true);
    });

    it.each([PolicyEvaluationStatus.Rejected, PolicyEvaluationStatus.NotApplicable, PolicyEvaluationStatus.Broken, undefined])("does not protect %s", (status) => {
      expect(isProtectedStatus(status)).toBe(false);
    });
  });

  describe("buildPullRequestArtifactId", () => {
    it("formats the vstfs artifact id", () => {
      expect(buildPullRequestArtifactId("11111111-1111-1111-1111-111111111111", 42)).toBe("vstfs:///CodeReview/CodeReviewId/11111111-1111-1111-1111-111111111111/42");
    });
  });

  describe("selectBuildPolicyEvaluationsToRequeue - selection", () => {
    it("selects a failed/rejected build policy by default", () => {
      const evaluation = buildEvaluation({ evaluationId: "eval-1", status: PolicyEvaluationStatus.Rejected });
      const result = selectBuildPolicyEvaluationsToRequeue([evaluation]);

      expect(result.toRequeue).toEqual([evaluation]);
      expect(result.skipped).toEqual([]);
    });

    it("filters out evaluations that are not build policies", () => {
      const evaluation = buildEvaluation({
        evaluationId: "eval-2",
        configuration: { isBlocking: true, isEnabled: true, settings: {}, type: { id: OTHER_POLICY_TYPE_ID } },
      });

      const result = selectBuildPolicyEvaluationsToRequeue([evaluation]);

      expect(result.toRequeue).toEqual([]);
      expect(result.skipped).toEqual([{ evaluationId: "eval-2", reason: "not-a-build-policy", status: evaluation.status }]);
    });

    it("skips evaluations missing an evaluationId", () => {
      const evaluation = buildEvaluation({ evaluationId: undefined });

      const result = selectBuildPolicyEvaluationsToRequeue([evaluation]);

      expect(result.toRequeue).toEqual([]);
      expect(result.skipped).toEqual([{ evaluationId: "<unknown>", reason: "missing-evaluation-id" }]);
    });
  });

  describe("selectBuildPolicyEvaluationsToRequeue - protection of active states", () => {
    it.each([PolicyEvaluationStatus.Approved, PolicyEvaluationStatus.Queued, PolicyEvaluationStatus.Running])("skips a build policy in status %s by default", (status) => {
      const evaluation = buildEvaluation({ evaluationId: "eval-3", status });

      const result = selectBuildPolicyEvaluationsToRequeue([evaluation]);

      expect(result.toRequeue).toEqual([]);
      expect(result.skipped).toEqual([{ evaluationId: "eval-3", reason: "protected-status", status }]);
    });

    it("does not protect a Rejected or Broken evaluation", () => {
      const rejected = buildEvaluation({ evaluationId: "eval-4", status: PolicyEvaluationStatus.Rejected });
      const broken = buildEvaluation({ evaluationId: "eval-5", status: PolicyEvaluationStatus.Broken });

      const result = selectBuildPolicyEvaluationsToRequeue([rejected, broken]);

      expect(result.toRequeue).toEqual([rejected, broken]);
      expect(result.skipped).toEqual([]);
    });

    it("bypasses protection for an explicitly selected evaluationId", () => {
      const approved = buildEvaluation({ evaluationId: "eval-6", status: PolicyEvaluationStatus.Approved });

      const result = selectBuildPolicyEvaluationsToRequeue([approved], { evaluationIds: ["eval-6"] });

      expect(result.toRequeue).toEqual([approved]);
      expect(result.skipped).toEqual([]);
    });

    it("excludes build policies not present in an explicit selection, even if not protected", () => {
      const rejected = buildEvaluation({ evaluationId: "eval-7", status: PolicyEvaluationStatus.Rejected });
      const other = buildEvaluation({ evaluationId: "eval-8", status: PolicyEvaluationStatus.Rejected });

      const result = selectBuildPolicyEvaluationsToRequeue([rejected, other], { evaluationIds: ["eval-7"] });

      expect(result.toRequeue).toEqual([rejected]);
      expect(result.skipped).toEqual([{ evaluationId: "eval-8", reason: "not-selected", status: other.status }]);
    });

    it("bypasses protection for every build policy when force is true", () => {
      const running = buildEvaluation({ evaluationId: "eval-9", status: PolicyEvaluationStatus.Running });
      const approved = buildEvaluation({ evaluationId: "eval-10", status: PolicyEvaluationStatus.Approved });

      const result = selectBuildPolicyEvaluationsToRequeue([running, approved], { force: true });

      expect(result.toRequeue).toEqual([running, approved]);
      expect(result.skipped).toEqual([]);
    });

    it("still filters out non-build policies even when force is true", () => {
      const nonBuild = buildEvaluation({
        evaluationId: "eval-11",
        status: PolicyEvaluationStatus.Approved,
        configuration: { isBlocking: true, isEnabled: true, settings: {}, type: { id: OTHER_POLICY_TYPE_ID } },
      });

      const result = selectBuildPolicyEvaluationsToRequeue([nonBuild], { force: true });

      expect(result.toRequeue).toEqual([]);
      expect(result.skipped).toEqual([{ evaluationId: "eval-11", reason: "not-a-build-policy", status: nonBuild.status }]);
    });
  });
});
