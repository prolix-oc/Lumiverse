-- Durable V1 state for bounded WORK segments. Historical executions are not backfilled.
-- Provider transcripts, reasoning, carriers, tool arguments/results, and external effects are absent by design.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_attempts_execution_identity
  ON agent_run_attempts(user_id, turn_id, attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turn_workspaces_execution_identity
  ON agent_turn_workspaces(user_id, execution_id, workspace_id);

CREATE TABLE IF NOT EXISTS agent_work_segment_recovery (
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  recovery_epoch INTEGER NOT NULL DEFAULT 0 CHECK(recovery_epoch BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('active', 'closed')),
  phase_id TEXT CHECK(phase_id IS NULL OR length(phase_id) BETWEEN 1 AND 256),
  phase_index INTEGER CHECK(phase_index IS NULL OR phase_index BETWEEN 0 AND 1000000),
  phase_occurrence INTEGER CHECK(phase_occurrence IS NULL OR phase_occurrence BETWEEN 0 AND 1000000),
  next_segment_ordinal INTEGER NOT NULL CHECK(next_segment_ordinal BETWEEN 0 AND 1000000),
  current_segment_id TEXT CHECK(current_segment_id IS NULL OR length(current_segment_id) BETWEEN 1 AND 256),
  remaining_required_phase_count INTEGER NOT NULL CHECK(remaining_required_phase_count BETWEEN 0 AND 1000000),
  initial_required_phase_count INTEGER NOT NULL CHECK(initial_required_phase_count BETWEEN 0 AND 1000000),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  phase_plan_digest TEXT NOT NULL CHECK(length(phase_plan_digest) = 64 AND phase_plan_digest NOT GLOB '*[^0-9a-f]*'),
  phase_plan_json TEXT NOT NULL CHECK(length(phase_plan_json) BETWEEN 25 AND 65536 AND json_valid(phase_plan_json) AND json_type(phase_plan_json) = 'object'),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'),
  resume_envelope_digest TEXT NOT NULL CHECK(length(resume_envelope_digest) = 64 AND resume_envelope_digest NOT GLOB '*[^0-9a-f]*'),
  resume_envelope_json TEXT NOT NULL CHECK(length(resume_envelope_json) BETWEEN 256 AND 8388608 AND json_valid(resume_envelope_json) AND json_type(resume_envelope_json) = 'object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  max_segments INTEGER NOT NULL CHECK(max_segments BETWEEN 1 AND 1000000),
  max_provider_dispatches INTEGER NOT NULL CHECK(max_provider_dispatches BETWEEN 1 AND 2147483648),
  max_provider_output_tokens INTEGER NOT NULL CHECK(max_provider_output_tokens BETWEEN 1 AND 2147483648),
  max_output_tokens_per_dispatch INTEGER NOT NULL CHECK(max_output_tokens_per_dispatch BETWEEN 1 AND 2147483648),
  max_unsigned_boundaries INTEGER NOT NULL CHECK(max_unsigned_boundaries BETWEEN 0 AND 2147483648),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 0 AND 2147483648),
  max_workspace_operations INTEGER NOT NULL CHECK(max_workspace_operations BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens INTEGER NOT NULL CHECK(recovery_reserve_output_tokens BETWEEN 0 AND 2147483648),
  future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  protected_recovery_reserve_output_tokens INTEGER NOT NULL CHECK(protected_recovery_reserve_output_tokens BETWEEN 0 AND 2147483648),
  protected_future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(protected_future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  terminal_close_result TEXT CHECK(terminal_close_result IS NULL OR terminal_close_result IN ('failed', 'exhausted', 'cancelled')),
  terminal_close_reason TEXT CHECK(terminal_close_reason IS NULL OR length(terminal_close_reason) BETWEEN 1 AND 256),
  terminal_boundary_class TEXT CHECK(terminal_boundary_class IS NULL OR terminal_boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),

  segment_count INTEGER NOT NULL DEFAULT 0 CHECK(segment_count BETWEEN 0 AND 1000000),
  provider_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(provider_dispatches BETWEEN 0 AND 2147483648),
  provider_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(billed_output_tokens BETWEEN 0 AND 2147483648),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER NOT NULL DEFAULT 0 CHECK(workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER NOT NULL DEFAULT 0 CHECK(unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER NOT NULL DEFAULT 0 CHECK(receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_output_bytes BETWEEN 0 AND 9007199254740991),

  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (user_id, execution_id),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (user_id, execution_id, attempt_id, workspace_id),
  CHECK(
    (state = 'active' AND phase_index IS NOT NULL AND phase_occurrence IS NOT NULL)
    OR (state = 'closed' AND phase_id IS NULL AND phase_index IS NULL AND phase_occurrence IS NULL)
  ),
  CHECK(recovery_reserve_output_tokens + future_phase_reserve_output_tokens <= max_provider_output_tokens),
  CHECK(max_output_tokens_per_dispatch <= max_provider_output_tokens),
  CHECK(protected_recovery_reserve_output_tokens <= recovery_reserve_output_tokens),
  CHECK(protected_future_phase_reserve_output_tokens <= future_phase_reserve_output_tokens),
  CHECK(protected_recovery_reserve_output_tokens + protected_future_phase_reserve_output_tokens <= max_provider_output_tokens),
  CHECK(remaining_required_phase_count <= initial_required_phase_count),
  CHECK(initial_required_phase_count > 0 OR future_phase_reserve_output_tokens = 0),
  CHECK((state = 'active') OR current_segment_id IS NULL),
  CHECK((terminal_close_result IS NULL AND terminal_close_reason IS NULL AND terminal_boundary_class IS NULL)
    OR (state = 'closed' AND terminal_close_result IS NOT NULL AND terminal_close_reason IS NOT NULL)),
  CHECK(next_segment_ordinal < max_segments OR state = 'closed'),
  CHECK(segment_count <= max_segments),
  CHECK(provider_dispatches <= max_provider_dispatches),
  CHECK(provider_output_tokens <= max_provider_output_tokens),
  CHECK(billed_output_tokens <= max_provider_output_tokens),
  CHECK(unsigned_boundaries <= max_unsigned_boundaries),
  CHECK(tool_calls <= max_tool_calls),
  CHECK(workspace_operations <= max_workspace_operations),
  CHECK(provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens),
  CHECK(billed_output_tokens >= provider_output_tokens),
  FOREIGN KEY (user_id, execution_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, attempt_id)
    REFERENCES agent_run_attempts(user_id, turn_id, attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, workspace_id)
    REFERENCES agent_turn_workspaces(user_id, execution_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_work_segments (
  segment_id TEXT PRIMARY KEY CHECK(length(segment_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  source_transition_id TEXT CHECK(source_transition_id IS NULL OR length(source_transition_id) BETWEEN 1 AND 256),
  phase_id TEXT CHECK(phase_id IS NULL OR length(phase_id) BETWEEN 1 AND 256),
  phase_index INTEGER NOT NULL CHECK(phase_index BETWEEN 0 AND 1000000),
  phase_occurrence INTEGER NOT NULL CHECK(phase_occurrence BETWEEN 0 AND 1000000),
  segment_ordinal INTEGER NOT NULL CHECK(segment_ordinal BETWEEN 0 AND 1000000),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('admitted', 'running', 'closed', 'interrupted', 'failed', 'exhausted', 'cancelled')),
  admission_key TEXT NOT NULL CHECK(length(admission_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64 AND context_digest NOT GLOB '*[^0-9a-f]*'),
  context_json TEXT NOT NULL CHECK(length(context_json) BETWEEN 64 AND 1048576 AND json_valid(context_json) AND json_type(context_json) = 'object'),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  max_provider_dispatches INTEGER NOT NULL CHECK(max_provider_dispatches BETWEEN 1 AND 2147483648),
  max_provider_output_tokens INTEGER NOT NULL CHECK(max_provider_output_tokens BETWEEN 1 AND 2147483648),
  max_output_tokens_per_dispatch INTEGER NOT NULL CHECK(max_output_tokens_per_dispatch BETWEEN 1 AND 2147483648),
  max_unsigned_boundaries INTEGER NOT NULL CHECK(max_unsigned_boundaries BETWEEN 0 AND 2147483648),
  max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 0 AND 2147483648),
  max_workspace_operations INTEGER NOT NULL CHECK(max_workspace_operations BETWEEN 0 AND 2147483648),

  provider_dispatches INTEGER NOT NULL DEFAULT 0 CHECK(provider_dispatches BETWEEN 0 AND 2147483648),
  provider_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(billed_output_tokens BETWEEN 0 AND 2147483648),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER NOT NULL DEFAULT 0 CHECK(workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER NOT NULL DEFAULT 0 CHECK(unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER NOT NULL DEFAULT 0 CHECK(receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_output_bytes BETWEEN 0 AND 9007199254740991),

  boundary_class TEXT CHECK(boundary_class IS NULL OR boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),
  close_result TEXT CHECK(close_result IS NULL OR close_result IN (
    'phase_advanced', 'phase_repeated', 'same_phase_rollover', 'work_complete',
    'failed', 'exhausted', 'cancelled'
  )),
  closed_workspace_revision INTEGER CHECK(closed_workspace_revision IS NULL OR closed_workspace_revision BETWEEN 0 AND 9007199254740991),
  closed_execution_cas_revision INTEGER CHECK(closed_execution_cas_revision IS NULL OR closed_execution_cas_revision BETWEEN 0 AND 9007199254740991),
  closure_digest TEXT CHECK(closure_digest IS NULL OR (length(closure_digest) = 64 AND closure_digest NOT GLOB '*[^0-9a-f]*')),
  close_reason TEXT CHECK(close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),
  closed_at INTEGER CHECK(closed_at IS NULL OR closed_at BETWEEN 0 AND 9007199254740991),
  CHECK(max_output_tokens_per_dispatch <= max_provider_output_tokens),

  UNIQUE (user_id, execution_id, segment_id),
  UNIQUE (user_id, execution_id, segment_id, attempt_id, workspace_id),
  UNIQUE (user_id, execution_id, segment_ordinal),
  UNIQUE (user_id, execution_id, admission_key),
  CHECK(phase_occurrence <= segment_ordinal),
  CHECK(
    (segment_ordinal = 0 AND source_transition_id IS NULL)
    OR (segment_ordinal > 0 AND source_transition_id IS NOT NULL)
  ),
  CHECK(provider_dispatches <= max_provider_dispatches),
  CHECK(provider_output_tokens <= max_provider_output_tokens),
  CHECK(billed_output_tokens <= max_provider_output_tokens),
  CHECK(unsigned_boundaries <= max_unsigned_boundaries),
  CHECK(tool_calls <= max_tool_calls),
  CHECK(workspace_operations <= max_workspace_operations),
  CHECK(provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens),
  CHECK(billed_output_tokens >= provider_output_tokens),
  CHECK(
    (lifecycle IN ('admitted', 'running') AND close_result IS NULL AND close_reason IS NULL
      AND closed_workspace_revision IS NULL AND closed_execution_cas_revision IS NULL
      AND closure_digest IS NULL AND closed_at IS NULL)
    OR (lifecycle IN ('closed', 'interrupted', 'failed', 'exhausted', 'cancelled') AND close_result IS NOT NULL
      AND close_reason IS NOT NULL AND closed_workspace_revision IS NOT NULL
      AND closed_execution_cas_revision IS NOT NULL AND closure_digest IS NOT NULL AND closed_at IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, source_transition_id)
    REFERENCES agent_work_segment_transitions(user_id, execution_id, transition_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_work_segment_transitions (
  transition_id TEXT PRIMARY KEY CHECK(length(transition_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  source_segment_id TEXT NOT NULL CHECK(length(source_segment_id) BETWEEN 1 AND 256),
  transition_kind TEXT NOT NULL CHECK(transition_kind IN ('advance', 'repeat', 'rollover', 'terminal')),
  target_phase_id TEXT CHECK(target_phase_id IS NULL OR length(target_phase_id) BETWEEN 1 AND 256),
  target_phase_index INTEGER CHECK(target_phase_index IS NULL OR target_phase_index BETWEEN 0 AND 1000000),
  target_phase_occurrence INTEGER CHECK(target_phase_occurrence IS NULL OR target_phase_occurrence BETWEEN 0 AND 1000000),
  target_segment_ordinal INTEGER CHECK(target_segment_ordinal IS NULL OR target_segment_ordinal BETWEEN 0 AND 1000000),
  remaining_required_phase_count INTEGER NOT NULL CHECK(remaining_required_phase_count BETWEEN 0 AND 1000000),
  released_future_phase_reserve_output_tokens INTEGER NOT NULL CHECK(released_future_phase_reserve_output_tokens BETWEEN 0 AND 2147483648),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  phase_plan_digest TEXT NOT NULL CHECK(length(phase_plan_digest) = 64 AND phase_plan_digest NOT GLOB '*[^0-9a-f]*'),
  transition_decision_digest TEXT NOT NULL CHECK(length(transition_decision_digest) = 64 AND transition_decision_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  advisory_authority TEXT NOT NULL DEFAULT 'model_advisory' CHECK(advisory_authority = 'model_advisory'),
  advisory_summary TEXT NOT NULL CHECK(length(advisory_summary) BETWEEN 1 AND 16384),
  advisory_unresolved_ids_json TEXT NOT NULL CHECK(
    length(advisory_unresolved_ids_json) BETWEEN 2 AND 65536
    AND json_valid(advisory_unresolved_ids_json)
    AND json_type(advisory_unresolved_ids_json) = 'array'
  ),
  advisory_render_guidance TEXT CHECK(advisory_render_guidance IS NULL OR length(advisory_render_guidance) <= 8192),
  accepted_ids_authority TEXT NOT NULL DEFAULT 'host' CHECK(accepted_ids_authority = 'host'),
  accepted_task_ids_json TEXT NOT NULL CHECK(length(accepted_task_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_task_ids_json) AND json_type(accepted_task_ids_json) = 'array'),
  accepted_submission_ids_json TEXT NOT NULL CHECK(length(accepted_submission_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_submission_ids_json) AND json_type(accepted_submission_ids_json) = 'array'),
  accepted_finding_ids_json TEXT NOT NULL CHECK(length(accepted_finding_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_finding_ids_json) AND json_type(accepted_finding_ids_json) = 'array'),
  accepted_decision_ids_json TEXT NOT NULL CHECK(length(accepted_decision_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_decision_ids_json) AND json_type(accepted_decision_ids_json) = 'array'),
  accepted_artifact_ids_json TEXT NOT NULL CHECK(length(accepted_artifact_ids_json) BETWEEN 2 AND 65536 AND json_valid(accepted_artifact_ids_json) AND json_type(accepted_artifact_ids_json) = 'array'),
  open_required_ids_json TEXT NOT NULL CHECK(length(open_required_ids_json) BETWEEN 2 AND 65536 AND json_valid(open_required_ids_json) AND json_type(open_required_ids_json) = 'array'),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),

  UNIQUE (user_id, execution_id, transition_id),
  UNIQUE (user_id, execution_id, source_segment_id),
  UNIQUE (user_id, execution_id, idempotency_key),
  CHECK(
    (transition_kind = 'terminal' AND target_phase_id IS NULL AND target_phase_index IS NULL
      AND target_phase_occurrence IS NULL AND target_segment_ordinal IS NULL)
    OR (transition_kind <> 'terminal' AND target_phase_index IS NOT NULL
      AND target_phase_occurrence IS NOT NULL AND target_segment_ordinal IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, source_segment_id, attempt_id, workspace_id)
    REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_work_segment_dispatches (
  dispatch_id TEXT PRIMARY KEY CHECK(length(dispatch_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 256),
  segment_id TEXT NOT NULL CHECK(length(segment_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  workspace_revision INTEGER NOT NULL CHECK(workspace_revision BETWEEN 0 AND 9007199254740991),
  execution_cas_revision INTEGER NOT NULL CHECK(execution_cas_revision BETWEEN 0 AND 9007199254740991),
  dispatch_ordinal INTEGER NOT NULL CHECK(dispatch_ordinal BETWEEN 0 AND 2147483648),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('reserved', 'in_flight', 'settled', 'interrupted')),
  tool_mode TEXT NOT NULL CHECK(tool_mode IN ('ordinary', 'required')),
  budget_class TEXT NOT NULL CHECK(budget_class IN ('normal', 'recovery')),
  reserved_output_tokens INTEGER NOT NULL CHECK(reserved_output_tokens BETWEEN 1 AND 2147483648),
  ordinary_output_tokens_reserved INTEGER NOT NULL CHECK(ordinary_output_tokens_reserved BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens_reserved INTEGER NOT NULL CHECK(recovery_reserve_output_tokens_reserved BETWEEN 0 AND 2147483648),
  lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 9007199254740991),
  fence_generation INTEGER NOT NULL CHECK(fence_generation BETWEEN 1 AND 2147483648),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  record_complete INTEGER NOT NULL DEFAULT 1 CHECK(record_complete = 1),

  settlement_key TEXT CHECK(settlement_key IS NULL OR length(settlement_key) BETWEEN 1 AND 256),
  settlement_digest TEXT CHECK(settlement_digest IS NULL OR (length(settlement_digest) = 64 AND settlement_digest NOT GLOB '*[^0-9a-f]*')),
  interruption_reason TEXT CHECK(interruption_reason IS NULL OR length(interruption_reason) BETWEEN 1 AND 256),
  settled_workspace_revision INTEGER CHECK(settled_workspace_revision IS NULL OR settled_workspace_revision BETWEEN 0 AND 9007199254740991),
  settled_execution_cas_revision INTEGER CHECK(settled_execution_cas_revision IS NULL OR settled_execution_cas_revision BETWEEN 0 AND 9007199254740991),
  boundary_class TEXT CHECK(boundary_class IS NULL OR boundary_class IN (
    'tool_action', 'tool_free_stop', 'reasoning_only_stop', 'reasoning_only_length',
    'empty_provider_response', 'provider_protocol_failure'
  )),
  provider_input_tokens INTEGER CHECK(provider_input_tokens IS NULL OR provider_input_tokens BETWEEN 0 AND 9007199254740991),
  provider_output_tokens INTEGER CHECK(provider_output_tokens IS NULL OR provider_output_tokens BETWEEN 0 AND 2147483648),
  provider_total_tokens INTEGER CHECK(provider_total_tokens IS NULL OR provider_total_tokens BETWEEN 0 AND 9007199254740991),
  billed_output_tokens INTEGER CHECK(billed_output_tokens IS NULL OR billed_output_tokens BETWEEN 0 AND 2147483648),
  recovery_reserve_output_tokens_consumed INTEGER CHECK(recovery_reserve_output_tokens_consumed IS NULL OR recovery_reserve_output_tokens_consumed BETWEEN 0 AND 2147483648),
  tool_calls INTEGER CHECK(tool_calls IS NULL OR tool_calls BETWEEN 0 AND 2147483648),
  workspace_operations INTEGER CHECK(workspace_operations IS NULL OR workspace_operations BETWEEN 0 AND 2147483648),
  unsigned_boundaries INTEGER CHECK(unsigned_boundaries IS NULL OR unsigned_boundaries BETWEEN 0 AND 2147483648),
  receive_bytes INTEGER CHECK(receive_bytes IS NULL OR receive_bytes BETWEEN 0 AND 9007199254740991),
  published_output_bytes INTEGER CHECK(published_output_bytes IS NULL OR published_output_bytes BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  started_at INTEGER CHECK(started_at IS NULL OR started_at BETWEEN 0 AND 9007199254740991),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991),

  UNIQUE (user_id, execution_id, dispatch_id),
  UNIQUE (user_id, execution_id, segment_id, dispatch_ordinal),
  UNIQUE (user_id, execution_id, idempotency_key),
  UNIQUE (user_id, execution_id, settlement_key),
  CHECK(ordinary_output_tokens_reserved + recovery_reserve_output_tokens_reserved = reserved_output_tokens),
  CHECK((budget_class = 'normal' AND recovery_reserve_output_tokens_reserved = 0) OR budget_class = 'recovery'),
  CHECK(recovery_reserve_output_tokens_consumed IS NULL OR recovery_reserve_output_tokens_consumed <= recovery_reserve_output_tokens_reserved),
  CHECK(
    (provider_input_tokens IS NULL AND provider_output_tokens IS NULL AND provider_total_tokens IS NULL
      AND billed_output_tokens IS NULL AND recovery_reserve_output_tokens_consumed IS NULL
      AND tool_calls IS NULL AND workspace_operations IS NULL AND unsigned_boundaries IS NULL
      AND receive_bytes IS NULL AND published_output_bytes IS NULL)
    OR (provider_input_tokens IS NOT NULL AND provider_output_tokens IS NOT NULL AND provider_total_tokens IS NOT NULL
      AND billed_output_tokens IS NOT NULL AND recovery_reserve_output_tokens_consumed IS NOT NULL
      AND tool_calls IS NOT NULL AND workspace_operations IS NOT NULL AND unsigned_boundaries IS NOT NULL
      AND receive_bytes IS NOT NULL AND published_output_bytes IS NOT NULL)
  ),
  CHECK(
    provider_total_tokens IS NULL
    OR (provider_total_tokens >= provider_input_tokens AND provider_total_tokens >= provider_output_tokens
      AND billed_output_tokens >= provider_output_tokens AND billed_output_tokens <= reserved_output_tokens
      AND provider_output_tokens <= reserved_output_tokens)
  ),
  CHECK(
    (lifecycle = 'reserved' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NULL AND settled_at IS NULL AND settlement_key IS NULL AND settlement_digest IS NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NULL
      AND settled_execution_cas_revision IS NULL AND boundary_class IS NULL AND provider_input_tokens IS NULL)
    OR (lifecycle = 'in_flight' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND started_at IS NOT NULL AND settled_at IS NULL AND settlement_key IS NULL AND settlement_digest IS NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NULL
      AND settled_execution_cas_revision IS NULL AND boundary_class IS NULL AND provider_input_tokens IS NULL)
    OR (lifecycle = 'settled' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND settled_at IS NOT NULL AND settlement_key IS NOT NULL AND settlement_digest IS NOT NULL
      AND interruption_reason IS NULL AND settled_workspace_revision IS NOT NULL
      AND settled_execution_cas_revision IS NOT NULL AND boundary_class IS NOT NULL AND provider_input_tokens IS NOT NULL)
    OR (lifecycle = 'interrupted' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND started_at IS NOT NULL AND settled_at IS NOT NULL AND settlement_key IS NULL AND settlement_digest IS NOT NULL
      AND interruption_reason IS NOT NULL AND settled_workspace_revision IS NOT NULL
      AND settled_execution_cas_revision IS NOT NULL AND boundary_class IS NOT NULL AND provider_input_tokens IS NOT NULL)
  ),
  FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)
    REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, segment_id, attempt_id, workspace_id)
    REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_work_segments_execution
  ON agent_work_segments(user_id, execution_id, segment_ordinal);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_transitions_execution
  ON agent_work_segment_transitions(user_id, execution_id, created_at, transition_id);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_dispatches_segment
  ON agent_work_segment_dispatches(user_id, execution_id, segment_id, dispatch_ordinal);
CREATE INDEX IF NOT EXISTS idx_agent_work_segment_dispatches_lease
  ON agent_work_segment_dispatches(lifecycle, lease_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_segments_one_active
  ON agent_work_segments(user_id, execution_id)
  WHERE lifecycle IN ('admitted', 'running');

CREATE TABLE IF NOT EXISTS agent_work_workspace_receipts (
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
  segment_id TEXT NOT NULL CHECK(length(segment_id) BETWEEN 1 AND 256),
  logical_dispatch INTEGER NOT NULL CHECK(logical_dispatch BETWEEN 0 AND 2147483648),
  frame_id TEXT NOT NULL CHECK(length(frame_id) BETWEEN 1 AND 256),
  operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 256),
  operation_digest TEXT NOT NULL CHECK(length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^0-9a-f]*'),
  before_workspace_revision INTEGER NOT NULL CHECK(before_workspace_revision BETWEEN 0 AND 9007199254740991),
  after_workspace_revision INTEGER NOT NULL CHECK(after_workspace_revision = before_workspace_revision + 1),
  settled_at INTEGER NOT NULL CHECK(settled_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (user_id, execution_id, operation_key),
  UNIQUE (user_id, execution_id, before_workspace_revision),
  UNIQUE (user_id, execution_id, after_workspace_revision),
  FOREIGN KEY (user_id, execution_id, workspace_id)
    REFERENCES agent_turn_workspaces(user_id, execution_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, execution_id, segment_id, logical_dispatch)
    REFERENCES agent_work_segment_dispatches(user_id, execution_id, segment_id, dispatch_ordinal) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_work_workspace_receipts_dispatch
  ON agent_work_workspace_receipts(user_id, execution_id, segment_id, logical_dispatch, settled_at, operation_key);