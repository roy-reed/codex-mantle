# Roadmap

The roadmap is ordered by safety and interoperability, not feature count.

## v0.1 alpha — strong thin layer

- environment doctor and Codex capability probe;
- exact snapshots, drift-checked plans, managed instruction blocks, guarded restore;
- strict data-only plugin manifests;
- loopback-only read-only dashboard;
- Windows snapshot ACL hardening, source installer, CI, heuristic repository scan, and provenance
  documentation.

## v0.2 — durable local control plane

- crash-recovery journal and explicit recovery tooling;
- signed portable archive with checksums and a standard CycloneDX SBOM;
- app-server stdio status adapter using generated per-version contracts;
- transaction history and reviewed dashboard mutations;
- project discovery without scanning outside explicit roots.

## v0.3 — extensions

- versioned JSON-RPC stdio extension host;
- explicit capability grants and process isolation;
- optional OpenCodex health adapter;
- extension conformance suite and migration tooling.

## Later candidates

- desktop shell, automatic update metadata, and package-manager distribution;
- shared policy registries with signatures and provenance;
- external task-dispatch extensions.

Model routing, provider proxies, account pools, DOM injection, private Codex database changes, LAN
control, and automatic credential discovery are not planned core features.
