export const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function validateReleaseCommit({ head, expected }) {
  const errors = [];
  const normalizedHead = head?.trim().toLowerCase() ?? "";
  const normalizedExpected = expected?.trim().toLowerCase();

  if (!FULL_COMMIT_PATTERN.test(normalizedHead)) {
    errors.push("release checkout HEAD must be a full 40-character commit SHA");
  }
  if (normalizedExpected !== undefined) {
    if (!FULL_COMMIT_PATTERN.test(normalizedExpected)) {
      errors.push("expected release commit must be a full 40-character commit SHA");
    } else if (normalizedHead !== normalizedExpected) {
      errors.push("release checkout HEAD does not match the expected tag target commit");
    }
  }

  return errors;
}
