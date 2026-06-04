# Incident 03 Answer Key — Kafka Offset Race Causes Terminal State Cache Staleness

> ⚠️ Do not upload this file to LogIQ. It is the answer key for evaluating the LLM response.

---

## What Happened

Starting 2025-04-02 around 11:00 UTC, downstream customers reported that cancelled orders
and ended subscriptions continued to show as ACTIVE in their systems. Other event types
(order updates, payments, profile changes) were processing correctly. No errors were
visible to customers — all event deliveries appeared to succeed.

## Root Cause

**A Kafka scaling change (STRM-3188, deployed 2025-04-01) increased `MaxPollRecords` from
50 to 500 and doubled partition count from 16 to 32. Under the higher parallelism, two
consumer threads began processing overlapping offset ranges from the same partition,
causing certain events to be delivered twice to the event_processor.**

**For idempotent events, duplicate delivery is harmless (second delivery is skipped).
For terminal state events (ORDER_CANCELLED, SUBSCRIPTION_ENDED), the second delivery
causes the StateMachine to throw `IllegalStateTransitionException` (cannot transition
out of terminal state). This exception is suppressed — by design, to prevent batch
failures. However, the suppression also skips read-cache invalidation for the entity.
If the read cache was not populated with the terminal state from the first delivery
(due to a race), the second delivery's suppressed exception leaves the cache showing
the pre-terminal state (ACTIVE) for up to 3,600 seconds (cache TTL).**

Key chain of events:
1. At 11:05 UTC, `BATCH-7741` processed `EVT-88212` (ORDER_CANCELLED, ORD-441801) successfully. State transitioned: ACTIVE → CANCELLED. Cache invalidation triggered.
2. Due to the offset race, `BATCH-7742` consumed the same offset range starting at offset 184100, re-delivering `EVT-88212`.
3. `BATCH-7742` detected the duplicate and re-routed it to OrderStateHandler (non-idempotent path).
4. StateMachine received `CANCELLED → CANCELLED` transition. Threw `IllegalStateTransitionException`, suppressed it, and — critically — **skipped cache invalidation** (no state change detected).
5. If the cache from step 1 had already been populated correctly, customers would see CANCELLED eventually. But under the race condition, the read cache was not guaranteed to reflect the CANCELLED state from step 1 before step 4 skipped invalidation.
6. The partition rebalance at 11:15 UTC caused a third delivery of the same events, repeating the suppression cycle and resetting the cache invalidation skip.
7. Customers read ACTIVE state from cache for up to 3,600 seconds.

## Why It Was Non-Obvious

- No errors surfaced to customers — all event deliveries returned success.
- The `IllegalStateTransitionException` was suppressed and only visible in the `Comments` column of `state_machine.log.csv` as `suppressed=true`.
- Most events worked fine — the issue was specific to terminal state events, which are a small fraction of total volume.
- The scaling change (STRM-3188) looked routine — partition increase + poll records increase, standard scaling operations.
- The design doc explicitly documented the interaction (Section 3.2, Section 4, Section 5 "Known Issue") but required reading the full document and connecting it to the Jira ticket.

## Clues That Connect the Dots

| Clue | Source |
|------|--------|
| Only terminal events affected (ORDER_CANCELLED, SUBSCRIPTION_ENDED) | `customer_case_notes.txt` — all three accounts |
| Issue started 2025-04-02 ~11:00 UTC, one day after scaling change | `customer_case_notes.txt` + `jira_ticket_strm_3188.txt` |
| `MaxPollRecords=500` (previous: 50), `Partitions=32` (previous: 16) | `kafka_consumer.log.csv` row 1-2 |
| Offset commit conflict / overlapping start offsets | `kafka_consumer.log.csv` rows 8-9, 19 |
| `note=terminal_state_events_not_idempotent; Action=re_processing` | `event_processor.log.csv` rows 11-12, 17-18 |
| `suppressed=true; ExceptionClass=IllegalStateTransitionException` | `state_machine.log.csv` rows 4-4 |
| `Cache invalidation skipped; note=read_cache_will_serve_stale_ACTIVE_state` | `state_machine.log.csv` rows 7-8, 11 |
| "Terminal state events are not idempotent; duplicate causes IllegalStateTransitionException" | `design_doc_event_processing.txt` Section 3.2 |
| "Interaction with MaxPollRecords=500 not load-tested at new scale" (known issue) | `design_doc_event_processing.txt` Section 5 |
| Staging test used idempotent events only | `jira_ticket_strm_3188.txt` |

## Fix

1. **Immediate**: Force-expire the read cache for all entities whose ORDER_CANCELLED / SUBSCRIPTION_ENDED events were delivered in the affected window (11:00-12:00 UTC on 2025-04-02). This causes the next read to fetch from DB, showing the correct terminal state.
2. **Short-term**: Revert `MaxPollRecords` from 500 to 50 to reduce offset overlap probability until the root fix is in place.
3. **Root fix (STRM-3310)**: Terminal state events must always trigger cache invalidation, regardless of whether the StateMachine throws `IllegalStateTransitionException`. The suppressed exception path must call cache invalidation before swallowing the exception.
4. **Process fix**: Load testing for Kafka scaling changes must include non-idempotent (terminal state) event scenarios with concurrent consumer threads and simulated partition rebalances.
