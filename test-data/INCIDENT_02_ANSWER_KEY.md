# Incident 02 Answer Key — Shard Router Stale Cache Causes Write Misdirection

> ⚠️ Do not upload this file to LogIQ. It is the answer key for evaluating the LLM response.

---

## What Happened

Multiple customers reported that writes made between 03:00 and 03:05 UTC on 2025-02-07
returned HTTP 200 (success) but subsequent reads returned stale or missing data. All
affected user IDs fell in the range USR-8800 to USR-9050. Data written before 03:00
and after 03:05 was unaffected.

## Root Cause

**A performance optimization ticket (DVSYNC-1098, merged 2025-01-24) increased the
shard router's cache TTL from 60 seconds to 300 seconds. On 2025-02-07 at 03:02 UTC,
a scheduled shard rebalance moved user range USR-8800-to-USR-8950 from shard-07 to
shard-08. However, because the router's cached shard map (v14) did not expire until
03:04:44 UTC (162 seconds after the rebalance completed), writes for that user range
continued to be routed to shard-07 for ~2 minutes and 44 seconds after the rebalance.**

**Reads, by contrast, used the updated shard map v15 immediately after the rebalance
(the read path appears to have loaded v15 earlier in the test case). The result: writes
went to shard-07, reads came from shard-08 — returning empty or stale data.**

Key chain of events:
1. Shard rebalance `REB-20250207-0300` started at 03:00 UTC, completed at 03:02:14 UTC.
2. New shard map v15 published: user range USR-8800-to-USR-8950 now owned by shard-08.
3. ShardRouter received the new map but scheduled cache refresh after TTL expiry (TTLRemainingMs=42,586ms at time of rebalance completion).
4. Writes from 03:02:14 to 03:04:44 were sent to shard-07 (old map), returning 200 OK.
5. Reads during the same window used shard-08 (new map), finding no data for those keys.
6. At 03:04:44 UTC, router refreshed to v15; subsequent writes correctly targeted shard-08.
7. All writes that landed on shard-07 during the gap remain there permanently, unrecoverable without manual data migration.

## Why It Was Non-Obvious

- Writes returned HTTP 200 with no errors — nothing in normal monitoring would alert.
- The 5-minute data gap is narrow and only affects a specific user ID range.
- The shard router logs showed `CacheAge` values growing past 200,000ms, but this is not an error condition in itself.
- The connection between DVSYNC-1098 (a closed P3 perf ticket from 2 weeks earlier) and the data loss required reading both the Jira ticket and the design document's "failure modes" section.
- The nightly rebalance schedule (03:00 UTC) is documented in the design doc but not referenced in the runbook or the router logs explicitly.

## Clues That Connect the Dots

| Clue | Source |
|------|--------|
| All customer data loss timestamps: 03:00-03:05 UTC | `customer_case_notes.txt` — all three accounts |
| All affected user IDs: USR-8800 to USR-9050 | `customer_case_notes.txt` + `shard_router.log.csv` |
| `note=using_cached_map_v14_until_ttl_expiry` at 03:02:14 | `shard_router.log.csv` row 10 |
| Writes to shard-07 with `shard_map_stale_warning=true` | `shard_router.log.csv` rows 14-16 |
| Reads from shard-08 returning 0 rows for same keys | `db_proxy.log.csv` rows 10, 16 |
| `note=recent_writes_landed_on_shard-07_not_shard-08` | `db_proxy.log.csv` row 10 |
| TTL increased from 60,000 to 300,000 ms on 2025-01-24 | `jira_ticket_dvsync_1098.txt` |
| "Gap window: from rebalance complete until CacheTTLMs (300s)" | `design_doc_db_sharding.txt` Section 5 |
| "Failure mode 6.4: write misdirection during rebalance gap — NOT currently alerting" | `design_doc_db_sharding.txt` Section 6.4 |
| Rebalance scheduled 03:00 UTC daily | `design_doc_db_sharding.txt` Section 4 |

## Fix

1. **Immediate**: Identify all writes that landed on shard-07 for range USR-8800-to-USR-8950 between 03:02:14 and 03:04:44 UTC and migrate them to shard-08.
2. **Short-term**: Revert CacheTTLMs from 300,000 to 60,000 to reduce the misdirection window to < 60 seconds.
3. **Root fix**: Implement push-based shard map invalidation — Shard Coordinator should push a cache invalidation signal to all routers immediately when a rebalance completes, rather than relying on TTL expiry.
4. **Alerting**: Add a metric `shard_router.stale_map_age_ms` and alert when it exceeds 90,000ms (1.5× the old TTL) during or after a known rebalance window.
