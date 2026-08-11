import type Database from 'better-sqlite3';

export interface FinanceInsightMigrationV1 {
  version: number;
  name: string;
  sql: string;
}

export const FINANCE_INSIGHT_MIGRATIONS_V1: readonly FinanceInsightMigrationV1[] =
  Object.freeze([
    {
      version: 1,
      name: 'initial-finance-insight-store',
      sql: `
CREATE TABLE finance_insight_connector_state (
  connector_ref TEXT PRIMARY KEY,
  current_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_source_sequence >= 0),
  current_source_generation TEXT,
  current_evaluation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_evaluation_sequence >= 0),
  CHECK (
    (current_source_sequence = 0 AND current_source_generation IS NULL) OR
    (current_source_sequence > 0 AND current_source_generation IS NOT NULL)
  )
) STRICT;

CREATE TABLE finance_insight_policy_snapshots (
  policy_version INTEGER PRIMARY KEY CHECK (policy_version > 0),
  effective_at TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE finance_insight_source_generations (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL UNIQUE,
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  request_json TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('staging', 'promoted', 'historical', 'rejected', 'expired')),
  assigned_detector_set_version TEXT,
  assigned_policy_version INTEGER,
  commit_idempotency_key TEXT UNIQUE,
  commit_digest TEXT,
  created_at TEXT NOT NULL,
  promoted_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (connector_ref, source_generation),
  UNIQUE (connector_ref, source_sequence),
  CHECK (
    (state IN ('promoted', 'historical') AND assigned_detector_set_version IS NOT NULL AND assigned_policy_version IS NOT NULL) OR
    (state IN ('staging', 'rejected', 'expired') AND assigned_detector_set_version IS NULL AND assigned_policy_version IS NULL)
  ),
  FOREIGN KEY (assigned_policy_version) REFERENCES finance_insight_policy_snapshots(policy_version)
) STRICT;

CREATE TABLE finance_insight_source_batches (
  source_generation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transaction', 'recurring', 'category', 'account', 'tag')),
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  batch_json TEXT NOT NULL,
  batch_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  fact_count INTEGER NOT NULL CHECK (fact_count BETWEEN 1 AND 250),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (source_generation, kind, batch_index),
  FOREIGN KEY (source_generation) REFERENCES finance_insight_source_generations(source_generation) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_staged_source_refs (
  source_generation TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  PRIMARY KEY (source_generation, kind, source_ref),
  FOREIGN KEY (source_generation, kind, batch_index)
    REFERENCES finance_insight_source_batches(source_generation, kind, batch_index)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_transaction_facts (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  merchant_name TEXT NOT NULL,
  category_ref TEXT,
  account_ref TEXT,
  is_pending INTEGER NOT NULL CHECK (is_pending IN (0, 1)),
  recurring_ref TEXT,
  tag_refs_json TEXT NOT NULL,
  fact_json TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX finance_insight_transactions_by_connector_date
  ON finance_insight_transaction_facts(connector_ref, occurred_on, source_ref);

CREATE TABLE finance_insight_recurring_facts (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount_minor INTEGER,
  cadence TEXT NOT NULL,
  next_date TEXT,
  category_ref TEXT,
  account_ref TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  fact_json TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_category_facts (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  group_ref TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  fact_json TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_account_facts (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  account_type TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  fact_json TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_tag_facts (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  fact_json TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_recurring_associations (
  connector_ref TEXT NOT NULL,
  transaction_source_ref TEXT NOT NULL,
  recurring_source_ref TEXT NOT NULL,
  association_version TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'configured', 'ambiguous')),
  source_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_ref, transaction_source_ref, source_sequence),
  FOREIGN KEY (connector_ref, source_sequence)
    REFERENCES finance_insight_source_generations(connector_ref, source_sequence)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_merchant_aliases (
  connector_ref TEXT NOT NULL,
  normalized_merchant_key TEXT NOT NULL,
  canonical_merchant_key TEXT NOT NULL,
  alias_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connector_ref, normalized_merchant_key)
) STRICT;

CREATE TABLE finance_insight_transaction_classifications (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  classifier_version TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (
    classification IN (
      'postedSpend', 'pending', 'transfer', 'income', 'refund',
      'unclassifiedCredit', 'knownRecurring', 'policyExcluded'
    )
  ),
  reason_code TEXT,
  classified_at TEXT NOT NULL,
  PRIMARY KEY (source_generation, source_ref, policy_version, classifier_version),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE,
  FOREIGN KEY (policy_version)
    REFERENCES finance_insight_policy_snapshots(policy_version)
) STRICT;

CREATE TABLE finance_insight_document_evidence (
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  entity_source_ref TEXT NOT NULL,
  evidence_index INTEGER NOT NULL CHECK (evidence_index BETWEEN 0 AND 7),
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (connector_ref, source_generation, entity_source_ref, evidence_index),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_evaluations (
  evaluation_key TEXT PRIMARY KEY,
  household_scope TEXT NOT NULL,
  connector_ref TEXT NOT NULL,
  source_generation TEXT NOT NULL,
  detector_set_version TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  source_sequence INTEGER NOT NULL,
  evaluation_sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'evaluating', 'completed', 'unavailable', 'failed')),
  accepted_at TEXT NOT NULL,
  completed_at TEXT,
  request_idempotency_key TEXT UNIQUE,
  request_digest TEXT,
  exclusion_summary_json TEXT,
  UNIQUE (connector_ref, evaluation_sequence),
  FOREIGN KEY (connector_ref, source_generation)
    REFERENCES finance_insight_source_generations(connector_ref, source_generation),
  FOREIGN KEY (policy_version) REFERENCES finance_insight_policy_snapshots(policy_version)
) STRICT;

CREATE TABLE finance_insight_evaluation_attempts (
  evaluation_key TEXT NOT NULL,
  evaluation_sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'evaluating', 'completed', 'unavailable', 'failed', 'stale')),
  accepted_at TEXT NOT NULL,
  completed_at TEXT,
  request_idempotency_key TEXT UNIQUE,
  request_digest TEXT,
  PRIMARY KEY (evaluation_key, evaluation_sequence),
  FOREIGN KEY (evaluation_key) REFERENCES finance_insight_evaluations(evaluation_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_series (
  insight_id TEXT PRIMARY KEY,
  connector_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (connector_ref, kind, entity_kind, entity_source_ref)
) STRICT;

CREATE TABLE finance_insight_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL,
  connector_ref TEXT NOT NULL,
  source_revision_ref TEXT,
  source_sequence INTEGER NOT NULL,
  evaluation_sequence INTEGER NOT NULL,
  delivery_revision INTEGER NOT NULL CHECK (delivery_revision > 0),
  analysis_state TEXT NOT NULL,
  source_lifecycle TEXT,
  resolution_reason TEXT,
  superseded_by_occurrence_id TEXT,
  detail_json TEXT NOT NULL,
  detail_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (insight_id) REFERENCES finance_insight_series(insight_id),
  FOREIGN KEY (superseded_by_occurrence_id)
    REFERENCES finance_insight_occurrences(occurrence_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX finance_insight_occurrence_list
  ON finance_insight_occurrences(updated_at DESC, occurrence_id ASC);
CREATE INDEX finance_insight_occurrence_series
  ON finance_insight_occurrences(insight_id, source_lifecycle);

CREATE TABLE finance_insight_list_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  filter_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE finance_insight_list_snapshot_items (
  snapshot_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  summary_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, position),
  FOREIGN KEY (snapshot_id)
    REFERENCES finance_insight_list_snapshots(snapshot_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_occurrence_revisions (
  occurrence_id TEXT NOT NULL,
  delivery_revision INTEGER NOT NULL,
  source_sequence INTEGER NOT NULL,
  evaluation_sequence INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  detail_digest TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (occurrence_id, delivery_revision),
  FOREIGN KEY (occurrence_id) REFERENCES finance_insight_occurrences(occurrence_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_lifecycle_events (
  occurrence_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL,
  reason_code TEXT,
  occurred_at TEXT NOT NULL,
  replacement_occurrence_id TEXT,
  evaluation_sequence INTEGER NOT NULL,
  PRIMARY KEY (occurrence_id, sequence),
  FOREIGN KEY (occurrence_id) REFERENCES finance_insight_occurrences(occurrence_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_feedback (
  action_ref TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('expected', 'notUseful')),
  reason TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator = 'fixedLocalOperator'),
  policy_version INTEGER NOT NULL,
  delivery_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  FOREIGN KEY (occurrence_id)
    REFERENCES finance_insight_occurrences(occurrence_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE finance_insight_suppressions (
  suppression_id TEXT PRIMARY KEY,
  connector_ref TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('occurrence', 'entity', 'category')),
  scope_ref TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days IN (30, 90, 180)),
  reason TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator = 'fixedLocalOperator'),
  policy_version INTEGER NOT NULL,
  delivery_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  undone_at TEXT,
  undo_idempotency_key TEXT UNIQUE,
  undo_request_digest TEXT,
  FOREIGN KEY (occurrence_id)
    REFERENCES finance_insight_occurrences(occurrence_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX finance_insight_active_suppressions
  ON finance_insight_suppressions(
    connector_ref, scope, scope_ref, expires_at, undone_at
  );
`,
    },
    {
      version: 2,
      name: 'evaluation-claim-lease',
      sql: `
ALTER TABLE finance_insight_evaluations
  ADD COLUMN claim_expires_at TEXT;
`,
    },
    {
      version: 3,
      name: 'kind-qualified-entity-suppression',
      sql: `
UPDATE finance_insight_suppressions
SET scope_ref = (
  SELECT json_extract(finance_insight_occurrences.detail_json, '$.entity.kind')
         || ':' || finance_insight_suppressions.scope_ref
  FROM finance_insight_occurrences
  WHERE finance_insight_occurrences.occurrence_id =
        finance_insight_suppressions.occurrence_id
)
WHERE scope = 'entity';
`,
    },
  ]);

export function migrateFinanceInsightStoreV1(
  database: Database.Database,
  appliedAt: string
): void {
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS finance_insight_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  database
    .transaction(() => {
      const applied = database
        .prepare(
          `SELECT version, name FROM finance_insight_schema_migrations
           ORDER BY version`
        )
        .all() as { version: number; name: string }[];
      for (const record of applied) {
        const expected = FINANCE_INSIGHT_MIGRATIONS_V1.find(
          (migration) => migration.version === record.version
        );
        if (!expected || expected.name !== record.name) {
          throw new Error('Finance insight schema migration history is invalid');
        }
      }
      const current = applied.at(-1)?.version ?? 0;
      for (const migration of FINANCE_INSIGHT_MIGRATIONS_V1) {
        if (migration.version <= current) continue;
        database.exec(migration.sql);
        database
          .prepare(
            'INSERT INTO finance_insight_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)'
          )
          .run(migration.version, migration.name, appliedAt);
      }
    })
    .exclusive();
}
