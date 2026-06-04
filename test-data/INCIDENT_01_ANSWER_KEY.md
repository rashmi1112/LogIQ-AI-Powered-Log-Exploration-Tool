# Incident 01 Answer Key — Cache Deadlock on Large Workspace Builds

> ⚠️ Do not upload this file to LogIQ. It is the answer key for evaluating the LLM response.

---

## What Happened

Enterprise customers experienced intermittent build timeouts on CI jobs for large
repositories (workspace size > 2GB). Builds appeared to start normally and entered the
workspace preparation phase, but then hung for approximately 29 minutes before failing
with `CacheInvalidationTimeout`. Retrying the build sometimes succeeded.

## Root Cause

**Smart Cache v2 uses pessimistic shard-level locking for cache invalidation. When two
builds targeting large workspaces (> 2GB) are triggered concurrently for the same or
shard-adjacent projects, one build acquires the shard lock and the other waits. If the
lock-holding invalidation takes longer than 30,000ms (the lock timeout, with no retry),
the waiting build fails.**

Key chain of events:
1. `JOB-CC4F2A09` (atlas-backend/main, 2.85GB) and `JOB-CC4F2A10` (atlas-backend/feature-auth, 2.85GB) both triggered at 08:45 UTC.
2. Both projects' cache keys hash to the same shard (`atlas-backend-shard-A`) in the CacheManager.
3. `CM-Thread-05` acquired the shard lock for `JOB-CC4F2A09` and began large-workspace invalidation (estimated 24-32s).
4. `CM-Thread-06` (for `JOB-CC4F2A10`) blocked waiting for the shard lock.
5. A third request (`JOB-CC4F2A09-retry`) further increased the wait queue.
6. The invalidation for `JOB-CC4F2A09` stalled on large chunk eviction (`shard-lock-held-by-stalled-thread`), holding the shard lock for ~29 minutes instead of the expected 28s.
7. Both waiting threads timed out at 09:14 UTC (30,000ms after their lock attempts).
8. BuildExecutor received `LockTimeout` errors and marked both builds as `CacheInvalidationTimeout`.

## Why It Was Non-Obvious

- Build runner CPU, memory, and network all looked healthy — standard runbook checks all passed.
- The `cache_manager.log.csv` contained the smoking-gun lines (`lock_acquire_timeout`, `note=concurrent_invalidation_not_supported_v2.0_see_design_doc_sec4.3`) but these were buried in rows 32-33 among 40 rows of otherwise normal cache operations.
- The design doc's "Known Limitations" section (Section 4.1-4.2) described this exact scenario but required reading the full document.
- Customer case notes mentioned concurrent builds as a factor (m.chen@techinc.io email), but this observation was in a secondary message that could be overlooked.
- The runbook for build failures explicitly notes it does NOT cover cache subsystem issues — creating a gap that delayed investigation.

## Clues That Connect the Dots

| Clue | Source |
|------|--------|
| Both failing jobs have `WorkspaceSize=2847MB` and `CacheVersion=v2` | `build_executor.log.csv` rows 1, 3 |
| Failures only affect `atlas-backend` (same shard), not smaller repos | `build_executor.log.csv` rows 13-17 |
| `upstream_dependency=cache_manager` on timeout | `build_executor.log.csv` rows 25-26 |
| `shared_shard_lock_contention` and 29-min stall | `cache_manager.log.csv` rows 26, 30 |
| `note=concurrent_invalidation_not_supported_v2.0_see_design_doc_sec4.3` | `cache_manager.log.csv` row 32 |
| "concurrent invalidation not supported" / "deferred to v2.1" | `design_doc_smart_cache_v2.txt` Section 4.1-4.2 |
| Customer specifically mentions "both devs trigger builds at the same time" | `customer_case_notes.txt` — m.chen email |
| All affected customers have large workspaces (2.8-3.1 GB) | `customer_case_notes.txt` — all three accounts |
| Cache v2 deployed 2025-03-10, issue started shortly after | `jira_ticket_bldfy_2891.txt` |

## Fix

1. **Immediate mitigation**: Roll back to `SMART_CACHE_VERSION=v1` (full-clone mode) for enterprise-large queue to unblock customers.
2. **Short-term**: Add retry logic in BuildExecutor for `LockTimeout` errors (backoff + retry once after 5s).
3. **Root fix (v2.1)**: Implement per-key locking instead of shard-level locking so that concurrent invalidations of different keys don't contend. Tracked in BLDFY-2922.
4. Alert on `cache_manager.lock_timeout_total > 2/hour` to detect the condition earlier.
