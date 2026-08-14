export const RELEASE_COMMIT_BINDING = "bound to the immutable tag target by the release workflow";

export const REQUIRED_PREPUBLICATION_GATES = [
  "`pnpm check`",
  "`Test-ProfileAcceptance.ps1` with the actual Codex CLI",
  "stale profile plan",
  "approved profile apply",
  "restore after unreviewed drift",
  "re-inspected restore",
  "full Windows `SafeCopy` acceptance",
  "full Windows `GitArchive` acceptance",
];

const METADATA_FIELDS = [
  "Status",
  "Candidate date",
  "Release commit",
  "Host",
  "PowerShell",
  "Node.js",
  "pnpm",
  "Codex CLI",
  "Tested Codex allowlist",
];

const RESULT_VALUES = new Set(["pending", "passed", "failed"]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function countExactLines(lines, expected) {
  return lines.filter((line) => line === expected).length;
}

function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMetadata(lines, start, end, errors) {
  const values = new Map();
  for (const line of lines.slice(start, end)) {
    if (line.trim() === "") continue;
    const match = /^- ([^:]+): (\S(?:.*\S)?)$/u.exec(line);
    if (!match) {
      errors.push(`release attestation metadata line is invalid: ${line}`);
      continue;
    }
    const [, key, value] = match;
    if (!METADATA_FIELDS.includes(key)) {
      errors.push(`release attestation metadata field is unknown: ${key}`);
      continue;
    }
    if (values.has(key)) {
      errors.push(`release attestation metadata field is duplicated: ${key}`);
      continue;
    }
    values.set(key, value);
  }
  for (const field of METADATA_FIELDS) {
    if (!values.has(field)) errors.push(`release attestation ${field}=missing`);
  }
  return values;
}

function parseEvidenceTable(lines, start, end, errors) {
  const rows = new Map();
  let headerSeen = false;
  let separatorSeen = false;
  for (const line of lines.slice(start, end)) {
    if (!line.trimStart().startsWith("|")) continue;
    const match = /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/u.exec(line);
    if (!match) {
      errors.push(`release attestation evidence row is invalid: ${line}`);
      continue;
    }
    const gate = match[1].trim();
    const outcome = match[2].trim();
    if (gate === "Gate" && outcome === "Outcome") {
      if (headerSeen) errors.push("release attestation evidence header is duplicated");
      headerSeen = true;
      continue;
    }
    if (/^-{3,}$/u.test(gate) && /^-{3,}$/u.test(outcome)) {
      if (separatorSeen) errors.push("release attestation evidence separator is duplicated");
      separatorSeen = true;
      continue;
    }
    if (rows.has(gate)) {
      errors.push(`release attestation evidence gate is duplicated: ${gate}`);
      continue;
    }
    if (!RESULT_VALUES.has(outcome)) {
      errors.push(
        `release attestation evidence outcome for ${gate} must be pending, passed, or failed`,
      );
    }
    rows.set(gate, outcome);
  }
  if (!headerSeen || !separatorSeen) {
    errors.push("release attestation evidence table header is missing or invalid");
  }
  for (const gate of REQUIRED_PREPUBLICATION_GATES) {
    if (!rows.has(gate)) errors.push(`release attestation evidence gate is missing: ${gate}`);
  }
  return rows;
}

export function validateReleaseAttestation(markdown, { version, release = false }) {
  const errors = [];
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const expectedHeading = `# v${version} release attestation`;
  if (lines[0] !== expectedHeading) {
    errors.push(`release attestation heading=${expectedHeading} missing`);
  }
  if (lines.some((line) => /^\s*(?:```|~~~)/u.test(line))) {
    errors.push("release attestation must not contain fenced code blocks");
  }

  const sections = [
    "## Pre-publication evidence",
    "## Post-publication evidence",
    "## Known limitations",
  ];
  for (const section of sections) {
    if (countExactLines(lines, section) !== 1) {
      errors.push(`release attestation section must appear exactly once: ${section}`);
    }
  }
  const preIndex = lines.indexOf(sections[0]);
  const postIndex = lines.indexOf(sections[1]);
  const limitationsIndex = lines.indexOf(sections[2]);
  if (!(preIndex > 0 && postIndex > preIndex && limitationsIndex > postIndex)) {
    errors.push("release attestation sections are missing or out of order");
    return errors;
  }

  const metadata = parseMetadata(lines, 1, preIndex, errors);
  const status = metadata.get("Status");
  if (!new Set(["draft candidate", "release candidate", "published"]).has(status)) {
    errors.push("release attestation Status is invalid");
  }
  if (!isRealIsoDate(metadata.get("Candidate date") ?? "")) {
    errors.push("release attestation Candidate date is not a real ISO date");
  }
  if (!/^\S(?:.*\S)?$/u.test(metadata.get("Host") ?? "")) {
    errors.push("release attestation Host is invalid");
  }
  for (const field of ["PowerShell", "Node.js", "pnpm", "Codex CLI"]) {
    if (!VERSION_PATTERN.test(metadata.get(field) ?? "")) {
      errors.push(`release attestation ${field} version is invalid`);
    }
  }
  if (!/^\d+\.\d+\.x$/u.test(metadata.get("Tested Codex allowlist") ?? "")) {
    errors.push("release attestation Tested Codex allowlist is invalid");
  }

  const rows = parseEvidenceTable(lines, preIndex + 1, postIndex, errors);
  if (release) {
    if (status !== "release candidate") {
      errors.push("release attestation status must be release candidate");
    }
    if (metadata.get("Release commit") !== RELEASE_COMMIT_BINDING) {
      errors.push("release attestation release commit must use the workflow binding");
    }
    for (const gate of REQUIRED_PREPUBLICATION_GATES) {
      if (rows.get(gate) !== "passed") {
        errors.push(`release attestation gate must be passed: ${gate}`);
      }
    }
  }
  return errors;
}
