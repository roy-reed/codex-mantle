# ADR 0001: Local control plane with a capability adapter

- Status: accepted
- Date: 2026-08-15

## Context

Codex desktop enhancements can be built by modifying renderer internals, proxying model traffic, or
placing a stable layer around public configuration and process interfaces. The first two approaches
offer fast feature breadth but bind safety and compatibility to private implementation details.

## Decision

Build a local-first control plane whose core owns declarative plans, snapshots, path boundaries, and
transactions. Access Codex only through an adapter over public files and CLI capabilities. Unknown
capabilities are read-only. Keep model routing and external providers out of the runtime.

## Consequences

The first release has fewer features than a full desktop client, but it remains useful and recoverable
during Codex changes. Future app-server, OpenCodex, desktop-shell, or task-dispatch integrations can be
added without granting them direct write authority.
