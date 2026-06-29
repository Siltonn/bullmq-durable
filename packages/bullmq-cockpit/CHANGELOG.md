# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
It is versioned in lockstep with [`bullmq-durable`](../bullmq-durable).

## [0.1.2] - 2026-06-28

Initial release.

### Added

- Embeddable, framework-agnostic dashboard for any BullMQ deployment: **Overview**
  (four golden signals + a worst-first queue health grid), **Queues**, **Jobs**,
  **Flows**, **Schedulers**, **Metrics**, and **Alerts** (server-side evaluation
  with Slack / webhook notifications). Adapters for Express, Fastify, NestJS, Hono,
  and a standalone CLI; an `auth` hook with per-action permissions; and a
  `readonly` mode.
- **Durable inspector**, auto-detected from `bullmq-durable` state in Redis:
  per-status counts, an instance list, step timelines, sleep / retry / resume /
  cancel / delete controls, a synthesized event feed, and four-class stuck
  detection. It speaks the durable Redis protocol directly (the runtime is never
  imported) and reads the status index, so counts and lists never scan the
  keyspace. Reads are read-only and exact by expiry score; mutating actions are
  atomic (MULTI/EXEC) and keep the index consistent — delete also removes the
  pending resume tick, so a non-terminal instance can't be resurrected.
