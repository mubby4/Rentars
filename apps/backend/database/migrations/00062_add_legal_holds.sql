-- Migration: 00062_add_legal_holds.sql
--
-- Adds the legal_holds table and supporting infrastructure so that the
-- data-retention cleanup jobs can identify records that must not be deleted
-- regardless of their age.
--
-- A legal hold is a named, audited marker that prevents any automated
-- retention job from touching the identified record.  Holds are placed
-- manually by an authorised operator (admin) and must be explicitly released.
--
-- Covered entity types (entity_type column):
--   'bookings'              — a specific booking and its related records
--   'payments'              — a specific payment record
--   'properties'            — a specific property listing
--   'blockchain_logs'       — a specific blockchain operation log entry
--   'users'                 — an entire user account and all child data
--   'notifications'         — a specific notification record
--   'data_exports'          — a specific data export request
--   'wallet_challenges'     — a specific wallet challenge token
--
-- Cleanup jobs query legal_holds WHERE active = true and exclude those
-- entity_ids from deletion.
--
-- The legal_hold_log table provides an immutable trail of every create and
-- release event for compliance reporting.

-- ─── legal_holds ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legal_holds (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which type of entity is being held.  Application-layer enum; validated
  -- by the CHECK constraint.
  entity_type   TEXT        NOT NULL
                CHECK (entity_type IN (
                  'bookings', 'payments', 'properties', 'blockchain_logs',
                  'users', 'notifications', 'data_exports', 'wallet_challenges'
                )),

  -- The UUID of the specific row being held.  Stored as TEXT to accommodate
  -- any primary-key type; typically a UUID string.
  entity_id     TEXT        NOT NULL,

  -- Human-readable reason (e.g. "Active dispute ref TW-20240912",
  -- "Regulatory investigation order #2024-NL-004").
  reason        TEXT        NOT NULL CHECK (char_length(reason) >= 5),

  -- Reference to an external case, ticket, or legal order number.
  case_reference TEXT,

  -- The admin user who placed the hold.
  placed_by     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- When the hold was placed.
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- When the hold was released (NULL while active).
  released_at   TIMESTAMPTZ,

  -- The admin user who released the hold (NULL while active).
  released_by   UUID        REFERENCES users(id) ON DELETE RESTRICT,

  -- Whether this hold is still active.  Set to false on release.
  active        BOOLEAN     NOT NULL DEFAULT true,

  -- Metadata: any additional context (court order number, ticket URL, etc.)
  meta          JSONB       NOT NULL DEFAULT '{}'
);

-- One active hold per entity is sufficient; this index also speeds up the
-- per-type lookups in cleanup jobs.
CREATE INDEX IF NOT EXISTS idx_legal_holds_entity
  ON legal_holds (entity_type, entity_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_legal_holds_placed_by
  ON legal_holds (placed_by);

CREATE INDEX IF NOT EXISTS idx_legal_holds_active
  ON legal_holds (active);

COMMENT ON TABLE legal_holds IS
  'Records that must not be deleted by automated retention jobs. '
  'Placed by authorised admins; released explicitly. '
  'Checked by retention.service.ts before any delete operation.';

-- ─── legal_hold_log ───────────────────────────────────────────────────────────
-- Immutable audit trail for every hold creation and release event.
-- Rows are append-only; no UPDATE or DELETE is granted via the API.

CREATE TABLE IF NOT EXISTS legal_hold_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id       UUID        NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  event         TEXT        NOT NULL CHECK (event IN ('placed', 'released')),
  actor_id      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason        TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta          JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_legal_hold_log_hold_id
  ON legal_hold_log (hold_id);

CREATE INDEX IF NOT EXISTS idx_legal_hold_log_occurred_at
  ON legal_hold_log (occurred_at DESC);

COMMENT ON TABLE legal_hold_log IS
  'Append-only audit trail for every legal_holds creation and release event.';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Only the service role (backend) may read or write these tables.
-- Admin-facing routes enforce additional RBAC checks at the application layer.

ALTER TABLE legal_holds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_hold_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_holds_service_role_only ON legal_holds
  USING (auth.role() = 'service_role');

CREATE POLICY legal_hold_log_service_role_only ON legal_hold_log
  USING (auth.role() = 'service_role');

-- ─── Trigger: auto-log on hold creation ──────────────────────────────────────

CREATE OR REPLACE FUNCTION legal_holds_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO legal_hold_log (hold_id, event, actor_id, reason, meta)
    VALUES (NEW.id, 'placed', NEW.placed_by, NEW.reason, NEW.meta);

  ELSIF TG_OP = 'UPDATE' AND OLD.active = true AND NEW.active = false THEN
    INSERT INTO legal_hold_log (hold_id, event, actor_id, reason, meta)
    VALUES (
      NEW.id,
      'released',
      COALESCE(NEW.released_by, NEW.placed_by),
      'Hold released',
      jsonb_build_object('released_at', NEW.released_at)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_holds_audit ON legal_holds;
CREATE TRIGGER trg_legal_holds_audit
  AFTER INSERT OR UPDATE ON legal_holds
  FOR EACH ROW
  EXECUTE FUNCTION legal_holds_audit();

-- ─── Helper view: cleanup_exempt_ids ─────────────────────────────────────────
-- Returns the (entity_type, entity_id) pairs currently under an active hold.
-- Retention jobs JOIN against this view to build their exclusion sets.

CREATE OR REPLACE VIEW cleanup_exempt_ids AS
SELECT
  entity_type,
  entity_id,
  reason,
  case_reference,
  placed_at,
  placed_by
FROM legal_holds
WHERE active = true;

COMMENT ON VIEW cleanup_exempt_ids IS
  'All entity IDs currently under an active legal hold. '
  'Retention cleanup jobs exclude every ID in this view.';

-- ─── Helper function: is_hold_exempt ─────────────────────────────────────────
-- Returns true when a specific entity is currently under an active legal hold.
-- Useful in stored procedures that need to guard individual deletes.

CREATE OR REPLACE FUNCTION is_hold_exempt(
  p_entity_type TEXT,
  p_entity_id   TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM legal_holds
    WHERE entity_type = p_entity_type
      AND entity_id   = p_entity_id
      AND active      = true
  );
$$;

COMMENT ON FUNCTION is_hold_exempt IS
  'Returns true if the entity currently has an active legal hold. '
  'Use in stored procedures to guard individual row deletions.';
