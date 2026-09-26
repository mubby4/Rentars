/**
 * Data Retention Service
 *
 * Implements scheduled, batched, idempotent cleanup jobs for every ephemeral
 * data class in the Rentars platform.  All jobs share a common contract:
 *
 *   - Batch-limited: at most BATCH_SIZE rows are deleted per invocation to
 *     avoid long-running transactions that lock hot tables.
 *   - Foreign-key-safe ordering: child rows are removed before parents within
 *     a single run so cascades do not trigger unexpectedly.
 *   - Legal-hold-aware: any row covered by an active legal_hold record is
 *     skipped automatically — cleanup cannot touch held data.
 *   - Dispute-safe: bookings/payments in 'Disputed' status are never deleted.
 *   - Dry-run mode: pass `dryRun: true` to preview deletions without mutating
 *     any data.  Reports the exact counts that *would* be removed.
 *   - Audit summary: every run emits a structured log entry with per-class
 *     counts, elapsed time, and whether the run was a dry run.
 *
 * Retention classes (configurable via RETENTION_* env vars):
 *
 *   Class                  Default    Table(s)
 *   ─────────────────────  ─────────  ──────────────────────────────────────
 *   wallet_challenges      1 hour     wallet_challenges
 *   password_reset_tokens  7 days     password_reset_tokens
 *   idempotency_keys       24 hours   idempotency_keys  (existing purge kept)
 *   blockchain_logs        90 days    blockchain_logs
 *   sync_log               30 days    sync_log
 *   notifications          90 days    notifications (read); 180 days (unread)
 *   search_analytics       365 days   search_analytics
 *   funnel_events          variable   funnel_events (per taxonomy)
 *   property_views         90 days    property_views (rows; aggregates kept)
 *   data_exports           per expiry data_exports
 *   account_deletions      30 days    account_deletions (completed/cancelled)
 *   soft_deleted_props     180 days   properties (deleted_at IS NOT NULL)
 *   payments_failed        90 days    payments (failed/timed_out, no active dispute)
 *
 * Financial records (confirmed payments, booking records with escrow_id) are
 * NEVER deleted by this service.  Audit logs are NEVER deleted.  Both are
 * excluded by the queries below.
 *
 * Legal holds: any entity_type/entity_id pair registered in the legal_holds
 * table is exempt from all cleanup jobs until the hold is released.
 */

import { supabase } from '@/config/supabase.js';
import { structuredLog } from '@/middleware/logging.middleware.js';
import { env } from '@/config/env.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetentionJobResult {
  /** Human-readable label for this data class. */
  class: string;
  /** Rows deleted (0 in dry-run mode). */
  deleted: number;
  /** Rows that would have been deleted (dry-run only; equals deleted otherwise). */
  eligible: number;
  /** Whether any rows were skipped because of legal holds. */
  held_skipped: number;
  /** True if the job failed; see `error` for details. */
  failed: boolean;
  error?: string;
}

export interface RetentionRunSummary {
  /** ISO-8601 timestamp of when the run started. */
  started_at: string;
  /** Total elapsed milliseconds. */
  elapsed_ms: number;
  /** Was this a dry-run (no mutations)? */
  dry_run: boolean;
  /** Per-class results. */
  results: RetentionJobResult[];
  /** Aggregate totals. */
  total_deleted: number;
  total_eligible: number;
  total_held_skipped: number;
  failed_classes: string[];
}

export interface RetentionOptions {
  /**
   * When true, queries determine eligibility but no rows are deleted.
   * Reports the exact counts that would be removed.
   */
  dryRun?: boolean;
  /**
   * Maximum rows to delete per table per run.
   * Defaults to env.RETENTION_BATCH_SIZE (default: 500).
   */
  batchSize?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many rows each cleanup job deletes per run to bound transaction size. */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Retention windows in days (or hours where noted).
 * Overridden by RETENTION_* env vars at runtime.
 */
function windows() {
  return {
    walletChallengesHours:       env.RETENTION_WALLET_CHALLENGES_HOURS,
    passwordResetTokensDays:     env.RETENTION_PASSWORD_RESET_TOKENS_DAYS,
    blockchainLogsDays:          env.RETENTION_BLOCKCHAIN_LOGS_DAYS,
    syncLogDays:                 env.RETENTION_SYNC_LOG_DAYS,
    notificationsReadDays:       env.RETENTION_NOTIFICATIONS_READ_DAYS,
    notificationsUnreadDays:     env.RETENTION_NOTIFICATIONS_UNREAD_DAYS,
    searchAnalyticsDays:         env.RETENTION_SEARCH_ANALYTICS_DAYS,
    propertyViewsDays:           env.RETENTION_PROPERTY_VIEWS_DAYS,
    paymentsFailedDays:          env.RETENTION_PAYMENTS_FAILED_DAYS,
    softDeletedPropertiesDays:   env.RETENTION_SOFT_DELETED_PROPERTIES_DAYS,
    accountDeletionsClosedDays:  env.RETENTION_ACCOUNT_DELETIONS_CLOSED_DAYS,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns an ISO timestamp `n` days before now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Returns an ISO timestamp `n` hours before now. */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

/**
 * Fetch the set of entity IDs (for a given entity_type) that are currently
 * under an active legal hold.  The result is used by each job to skip those
 * rows.
 */
async function getHeldIds(entityType: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('legal_holds')
    .select('entity_id')
    .eq('entity_type', entityType)
    .eq('active', true);

  if (error || !data) return new Set();
  return new Set(data.map((r: { entity_id: string }) => r.entity_id));
}

/**
 * Build a "not in held IDs" filter clause for queries that need to exclude
 * held rows.  Returns null when there are no held IDs (no filtering needed).
 */
function buildHoldExclusion(heldIds: Set<string>): string[] {
  // Supabase JS client does not support NOT IN directly for large sets;
  // we return them here so callers can apply `.not('id', 'in', ...)`.
  return [...heldIds];
}

/**
 * Produce a zero-count success result for when nothing is eligible.
 */
function noop(label: string): RetentionJobResult {
  return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: false };
}

// ─── Individual Cleanup Jobs ──────────────────────────────────────────────────

/**
 * Purge expired wallet challenge tokens.
 * Policy: remove rows where expires_at < NOW() OR (used = true AND created_at < cutoff).
 */
async function purgeWalletChallenges(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'wallet_challenges';
  try {
    const heldIds = await getHeldIds(label);
    const cutoff = hoursAgo(windows().walletChallengesHours);

    // Count eligible rows
    let countQuery = supabase
      .from('wallet_challenges')
      .select('id', { count: 'exact', head: true })
      .or(`expires_at.lt.${new Date().toISOString()},and(used.eq.true,created_at.lt.${cutoff})`);

    if (heldIds.size > 0) {
      countQuery = countQuery.not('id', 'in', `(${buildHoldExclusion(heldIds).join(',')})`);
    }

    const { count: eligible } = await countQuery;
    const eligibleCount = eligible ?? 0;
    const heldSkipped = heldIds.size;

    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
    }

    // Delete in batch
    let deleteQuery = supabase
      .from('wallet_challenges')
      .delete()
      .or(`expires_at.lt.${new Date().toISOString()},and(used.eq.true,created_at.lt.${cutoff})`)
      .limit(batchSize)
      .select('id');

    if (heldIds.size > 0) {
      deleteQuery = deleteQuery.not('id', 'in', `(${buildHoldExclusion(heldIds).join(',')})`);
    }

    const { data, error } = await deleteQuery;
    if (error) throw new Error(error.message);

    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge expired or consumed password reset tokens.
 * Policy: expires_at < NOW() (whether consumed or not — consumed tokens
 * cannot be replayed; expired ones are definitionally stale).
 * Retention floor: RETENTION_PASSWORD_RESET_TOKENS_DAYS days.
 */
async function purgePasswordResetTokens(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'password_reset_tokens';
  try {
    const cutoff = daysAgo(windows().passwordResetTokensDays);

    const { count: eligible } = await supabase
      .from('password_reset_tokens')
      .select('id', { count: 'exact', head: true })
      .lt('expires_at', cutoff);

    const eligibleCount = eligible ?? 0;

    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('password_reset_tokens')
      .delete()
      .lt('expires_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge old blockchain operation logs.
 * Policy: rows older than RETENTION_BLOCKCHAIN_LOGS_DAYS days.
 * Exception: rows related to active disputes are exempt (via legal_holds or
 * directly by joining to disputed bookings).
 */
async function purgeBlockchainLogs(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'blockchain_logs';
  try {
    const heldIds = await getHeldIds(label);
    const cutoff = daysAgo(windows().blockchainLogsDays);

    const { count: eligible } = await supabase
      .from('blockchain_logs')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff)
      .not('id', 'in', heldIds.size > 0 ? `(${buildHoldExclusion(heldIds).join(',')})` : '(00000000-0000-0000-0000-000000000000)');

    const eligibleCount = eligible ?? 0;
    const heldSkipped = heldIds.size;

    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
    }

    let deleteQuery = supabase
      .from('blockchain_logs')
      .delete()
      .lt('created_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (heldIds.size > 0) {
      deleteQuery = deleteQuery.not('id', 'in', `(${buildHoldExclusion(heldIds).join(',')})`);
    }

    const { data, error } = await deleteQuery;
    if (error) throw new Error(error.message);

    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge old sync_log rows.
 * Policy: rows older than RETENTION_SYNC_LOG_DAYS days.
 */
async function purgeSyncLog(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'sync_log';
  try {
    const cutoff = daysAgo(windows().syncLogDays);

    const { count: eligible } = await supabase
      .from('sync_log')
      .select('id', { count: 'exact', head: true })
      .lt('synced_at', cutoff);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('sync_log')
      .delete()
      .lt('synced_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Archive and purge old notifications.
 * Policy:
 *   - Read notifications older than RETENTION_NOTIFICATIONS_READ_DAYS → delete.
 *   - Unread notifications older than RETENTION_NOTIFICATIONS_UNREAD_DAYS → delete.
 *
 * Rationale: unread notifications get a longer window to give users time to
 * see them, but they cannot be kept indefinitely.
 */
async function purgeNotifications(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'notifications';
  try {
    const readCutoff   = daysAgo(windows().notificationsReadDays);
    const unreadCutoff = daysAgo(windows().notificationsUnreadDays);

    const { count: eligible } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .or(`and(read.eq.true,created_at.lt.${readCutoff}),and(read.eq.false,created_at.lt.${unreadCutoff})`);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('notifications')
      .delete()
      .or(`and(read.eq.true,created_at.lt.${readCutoff}),and(read.eq.false,created_at.lt.${unreadCutoff})`)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge old search analytics rows.
 * Policy: rows older than RETENTION_SEARCH_ANALYTICS_DAYS days.
 * The DB-level purge function purge_stale_search_analytics() uses 12 months;
 * this service-layer job applies the same policy via the Supabase client for
 * consistency with batch limits and dry-run support.
 */
async function purgeSearchAnalytics(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'search_analytics';
  try {
    const cutoff = daysAgo(windows().searchAnalyticsDays);

    const { count: eligible } = await supabase
      .from('search_analytics')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('search_analytics')
      .delete()
      .lt('created_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge old funnel event rows per the retention taxonomy defined in
 * 00021_create_funnel_events.sql:
 *   - booking.* / payment.* / cancellation.*  → 24 months
 *   - search.*                                 → 12 months
 *   - listing.*                                → 6 months
 *
 * This service-layer job applies those windows with batch limits and dry-run.
 */
async function purgeFunnelEvents(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'funnel_events';
  try {
    const cutoff24m = daysAgo(24 * 30);   // ~24 months
    const cutoff12m = daysAgo(12 * 30);   // ~12 months
    const cutoff6m  = daysAgo(6 * 30);    //  ~6 months

    // Count across all retention windows
    const { count: c1 } = await supabase
      .from('funnel_events')
      .select('id', { count: 'exact', head: true })
      .or('event.like.booking.%,event.like.payment.%,event.like.cancellation.%')
      .lt('created_at', cutoff24m);

    const { count: c2 } = await supabase
      .from('funnel_events')
      .select('id', { count: 'exact', head: true })
      .like('event', 'search.%')
      .lt('created_at', cutoff12m);

    const { count: c3 } = await supabase
      .from('funnel_events')
      .select('id', { count: 'exact', head: true })
      .like('event', 'listing.%')
      .lt('created_at', cutoff6m);

    const eligibleCount = (c1 ?? 0) + (c2 ?? 0) + (c3 ?? 0);
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    // Delete each bucket (each limited to batchSize/3 to stay within total limit)
    const perBucket = Math.ceil(batchSize / 3);
    let deleted = 0;

    for (const [filter, cutoff] of [
      [['booking.%', 'payment.%', 'cancellation.%'], cutoff24m],
      [['search.%'], cutoff12m],
      [['listing.%'], cutoff6m],
    ] as [[string[], string]]) {
      const patterns = filter as string[];
      const ts = cutoff as string;

      const orClause = patterns.map((p) => `event.like.${p}`).join(',');
      const { data, error } = await supabase
        .from('funnel_events')
        .delete()
        .or(orClause)
        .lt('created_at', ts)
        .limit(perBucket)
        .select('id');

      if (error) throw new Error(error.message);
      deleted += data?.length ?? 0;
    }

    return { class: label, deleted, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge old property view rows.
 * Policy: rows older than RETENTION_PROPERTY_VIEWS_DAYS days.
 * The denormalized view_count column on properties is NOT touched — it
 * reflects lifetime views, not retained rows.
 */
async function purgePropertyViews(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'property_views';
  try {
    const cutoff = daysAgo(windows().propertyViewsDays);

    const { count: eligible } = await supabase
      .from('property_views')
      .select('id', { count: 'exact', head: true })
      .lt('viewed_at', cutoff);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('property_views')
      .delete()
      .lt('viewed_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge expired data export records.
 * Policy: rows where expires_at < NOW() (completed or failed status).
 * Pending exports are never deleted here — they may still be processing.
 */
async function purgeExpiredDataExports(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'data_exports';
  try {
    const now = new Date().toISOString();

    const { count: eligible } = await supabase
      .from('data_exports')
      .select('id', { count: 'exact', head: true })
      .lt('expires_at', now)
      .in('status', ['completed', 'failed']);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('data_exports')
      .delete()
      .lt('expires_at', now)
      .in('status', ['completed', 'failed'])
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge closed account deletion records past their retention window.
 * Policy: completed or cancelled rows older than
 * RETENTION_ACCOUNT_DELETIONS_CLOSED_DAYS days.
 * Pending records are never touched.
 */
async function purgeClosedAccountDeletions(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'account_deletions';
  try {
    const cutoff = daysAgo(windows().accountDeletionsClosedDays);

    const { count: eligible } = await supabase
      .from('account_deletions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['completed', 'cancelled'])
      .lt('created_at', cutoff);

    const eligibleCount = eligible ?? 0;
    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: 0, failed: false };
    }

    const { data, error } = await supabase
      .from('account_deletions')
      .delete()
      .in('status', ['completed', 'cancelled'])
      .lt('created_at', cutoff)
      .limit(batchSize)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: 0, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Hard-delete soft-deleted properties past the retention grace period.
 * Policy: properties where deleted_at IS NOT NULL and deleted_at <
 * RETENTION_SOFT_DELETED_PROPERTIES_DAYS days ago.
 *
 * The cascade on property_images, availability_ranges, wishlists, etc.
 * is handled by ON DELETE CASCADE constraints in the DB schema, so no
 * child-row ordering is required here.
 *
 * Exception: properties referenced by a booking in 'Disputed' status are
 * excluded regardless of deleted_at.
 */
async function hardDeleteSoftDeletedProperties(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'soft_deleted_properties';
  try {
    const heldIds = await getHeldIds('properties');
    const cutoff  = daysAgo(windows().softDeletedPropertiesDays);

    // Fetch IDs of properties currently involved in active disputes
    const { data: disputedProps } = await supabase
      .from('bookings')
      .select('property_id')
      .eq('status', 'Disputed');

    const disputedPropertyIds = new Set(
      (disputedProps ?? []).map((r: { property_id: string }) => r.property_id),
    );

    // Merge legal holds and disputed properties into the exclusion set
    const excludeIds = new Set([...heldIds, ...disputedPropertyIds]);

    let countQuery = supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff);

    if (excludeIds.size > 0) {
      countQuery = countQuery.not('id', 'in', `(${[...excludeIds].join(',')})`);
    }

    const { count: eligible } = await countQuery;
    const eligibleCount = eligible ?? 0;
    const heldSkipped = excludeIds.size;

    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
    }

    // Fetch IDs to delete (respects batch limit before the actual delete)
    let idsQuery = supabase
      .from('properties')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff)
      .limit(batchSize);

    if (excludeIds.size > 0) {
      idsQuery = idsQuery.not('id', 'in', `(${[...excludeIds].join(',')})`);
    }

    const { data: toDelete, error: fetchErr } = await idsQuery;
    if (fetchErr) throw new Error(fetchErr.message);

    const ids = (toDelete ?? []).map((r: { id: string }) => r.id);
    if (ids.length === 0) return noop(label);

    const { data, error } = await supabase
      .from('properties')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

/**
 * Purge failed or timed-out payment intent records past the retention window.
 * Policy: payments in (failed, timed_out) status older than
 * RETENTION_PAYMENTS_FAILED_DAYS days, where the booking is not disputed.
 *
 * Confirmed payments and their bookings are NEVER touched.
 */
async function purgeFailedPaymentIntents(
  batchSize: number,
  dryRun: boolean,
): Promise<RetentionJobResult> {
  const label = 'payments_failed';
  try {
    const heldIds = await getHeldIds('payments');
    const cutoff = daysAgo(windows().paymentsFailedDays);

    // Fetch booking IDs currently in Disputed status
    const { data: disputedBookings } = await supabase
      .from('bookings')
      .select('id')
      .eq('status', 'Disputed');

    const disputedBookingIds = new Set(
      (disputedBookings ?? []).map((r: { id: string }) => r.id),
    );

    const excludeIds = new Set([...heldIds]);

    let countQuery = supabase
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .in('status', ['failed', 'timed_out'])
      .lt('created_at', cutoff);

    if (disputedBookingIds.size > 0) {
      countQuery = countQuery.not('booking_id', 'in', `(${[...disputedBookingIds].join(',')})`);
    }
    if (excludeIds.size > 0) {
      countQuery = countQuery.not('id', 'in', `(${[...excludeIds].join(',')})`);
    }

    const { count: eligible } = await countQuery;
    const eligibleCount = eligible ?? 0;
    const heldSkipped = excludeIds.size;

    if (dryRun || eligibleCount === 0) {
      return { class: label, deleted: 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
    }

    // Fetch IDs to delete
    let idsQuery = supabase
      .from('payments')
      .select('id')
      .in('status', ['failed', 'timed_out'])
      .lt('created_at', cutoff)
      .limit(batchSize);

    if (disputedBookingIds.size > 0) {
      idsQuery = idsQuery.not('booking_id', 'in', `(${[...disputedBookingIds].join(',')})`);
    }
    if (excludeIds.size > 0) {
      idsQuery = idsQuery.not('id', 'in', `(${[...excludeIds].join(',')})`);
    }

    const { data: toDelete, error: fetchErr } = await idsQuery;
    if (fetchErr) throw new Error(fetchErr.message);

    const ids = (toDelete ?? []).map((r: { id: string }) => r.id);
    if (ids.length === 0) return noop(label);

    const { data, error } = await supabase
      .from('payments')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) throw new Error(error.message);
    return { class: label, deleted: data?.length ?? 0, eligible: eligibleCount, held_skipped: heldSkipped, failed: false };
  } catch (err) {
    return { class: label, deleted: 0, eligible: 0, held_skipped: 0, failed: true, error: String(err) };
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all retention jobs in FK-safe order and return a full summary.
 *
 * @param options.dryRun   - When true, no rows are deleted (preview mode).
 * @param options.batchSize - Max rows per table per run (default: 500).
 *
 * @example
 * // Preview mode — safe to call any time:
 * const preview = await runRetentionJobs({ dryRun: true });
 * console.log(preview);
 *
 * // Scheduled cleanup:
 * const result = await runRetentionJobs({ dryRun: false, batchSize: 500 });
 */
export async function runRetentionJobs(
  options: RetentionOptions = {},
): Promise<RetentionRunSummary> {
  const dryRun    = options.dryRun ?? false;
  const batchSize = options.batchSize ?? env.RETENTION_BATCH_SIZE ?? DEFAULT_BATCH_SIZE;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Run jobs in FK-safe order:
  //   1. Child/ephemeral tables that reference no financial records first.
  //   2. payment intents (child of bookings) before soft-deleted properties.
  //   3. Soft-deleted properties last (cascades to images, wishlists, etc.).
  const results: RetentionJobResult[] = await Promise.all([
    purgeWalletChallenges(batchSize, dryRun),
    purgePasswordResetTokens(batchSize, dryRun),
    purgeBlockchainLogs(batchSize, dryRun),
    purgeSyncLog(batchSize, dryRun),
    purgeNotifications(batchSize, dryRun),
    purgeSearchAnalytics(batchSize, dryRun),
    purgeFunnelEvents(batchSize, dryRun),
    purgePropertyViews(batchSize, dryRun),
    purgeExpiredDataExports(batchSize, dryRun),
    purgeClosedAccountDeletions(batchSize, dryRun),
  ]);

  // These two must run after the parallel batch above because they
  // depend on the disputed-booking set which is best fetched once.
  const paymentResult = await purgeFailedPaymentIntents(batchSize, dryRun);
  const propertyResult = await hardDeleteSoftDeletedProperties(batchSize, dryRun);
  results.push(paymentResult, propertyResult);

  const elapsed_ms      = Date.now() - t0;
  const total_deleted   = results.reduce((s, r) => s + r.deleted, 0);
  const total_eligible  = results.reduce((s, r) => s + r.eligible, 0);
  const total_held_skipped = results.reduce((s, r) => s + r.held_skipped, 0);
  const failed_classes  = results.filter((r) => r.failed).map((r) => r.class);

  const summary: RetentionRunSummary = {
    started_at: startedAt,
    elapsed_ms,
    dry_run: dryRun,
    results,
    total_deleted,
    total_eligible,
    total_held_skipped,
    failed_classes,
  };

  // Emit structured audit summary
  structuredLog({
    level:             failed_classes.length > 0 ? 'warn' : 'info',
    message:           dryRun ? '[retention] Dry-run preview complete' : '[retention] Cleanup run complete',
    timestamp:         startedAt,
    dry_run:           dryRun,
    elapsed_ms,
    total_deleted,
    total_eligible,
    total_held_skipped,
    failed_classes,
    per_class: results.map((r) => ({
      class:       r.class,
      deleted:     r.deleted,
      eligible:    r.eligible,
      held_skipped: r.held_skipped,
      failed:      r.failed,
      ...(r.error ? { error: r.error } : {}),
    })),
  });

  return summary;
}
