# Live Stage Token Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `StageProjection` the source of truth for current per-stage token usage so in-flight stages show running token counts on the billing page.

**Architecture:** Store zeroable token counters directly on each `StageProjection`, plus optional model identity once model usage is known. Projection application updates those counters from usage-bearing events as they arrive, while terminal stage events remain authoritative and replace live counts when final billing is present. Billing rollups and server responses read from the projection rather than re-scanning raw events.

**Tech Stack:** Rust workspace crates `fabro-model`, `fabro-types`, `fabro-store`, `fabro-workflow`, `fabro-server`; OpenAPI-driven `fabro-api`; React route tests in `apps/fabro-web`.

---

## File Structure

- Modify `lib/crates/fabro-model/src/billing.rs` for OOP-style `BilledTokenCounts` aggregation helpers.
- Modify `lib/crates/fabro-types/src/run_projection.rs` for the new projection fields and attempt reset behavior.
- Modify `lib/crates/fabro-store/src/run_state.rs` so projection application updates live and terminal usage.
- Modify `lib/crates/fabro-workflow/src/billing_rollup.rs` and billing-related server code to read `StageProjection.usage`.
- Modify event conversion around `agent.message` to carry provider context and price live usage deltas when provider parsing succeeds.
- Modify `docs/public/api-reference/fabro-api.yaml` to expose `StageProjection.usage` and `StageProjection.model_id`.

## Task 1: Add `BilledTokenCounts` Aggregation Methods

**Files:**
- Modify: `lib/crates/fabro-model/src/billing.rs`

- [ ] Add methods to `impl BilledTokenCounts`:

```rust
pub fn add_counts(&mut self, source: &Self) {
    self.input_tokens += source.input_tokens;
    self.output_tokens += source.output_tokens;
    self.total_tokens += source.total_tokens;
    self.reasoning_tokens += source.reasoning_tokens;
    self.cache_read_tokens += source.cache_read_tokens;
    self.cache_write_tokens += source.cache_write_tokens;
    if let Some(value) = source.total_usd_micros {
        *self.total_usd_micros.get_or_insert(0) += value;
    }
}

pub fn add_billed_usage(&mut self, usage: &BilledModelUsage) {
    let tokens = usage.tokens();
    self.input_tokens += tokens.input_tokens;
    self.output_tokens += tokens.output_tokens;
    self.reasoning_tokens += tokens.reasoning_tokens;
    self.cache_read_tokens += tokens.cache_read_tokens;
    self.cache_write_tokens += tokens.cache_write_tokens;
    self.total_tokens += tokens.total_tokens();
    if let Some(value) = usage.total_usd_micros {
        *self.total_usd_micros.get_or_insert(0) += value;
    }
}

pub fn replace_with_billed_usage(&mut self, usage: &BilledModelUsage) {
    *self = Self::from_billed_usage(std::slice::from_ref(usage));
}

pub fn is_zero(&self) -> bool {
    self.input_tokens == 0
        && self.output_tokens == 0
        && self.total_tokens == 0
        && self.reasoning_tokens == 0
        && self.cache_read_tokens == 0
        && self.cache_write_tokens == 0
        && self.total_usd_micros.unwrap_or(0) == 0
}
```

- [ ] Add `fabro-model` unit tests covering `add_counts`, `add_billed_usage`, replacement, and unknown-cost behavior.

- [ ] Run:

```bash
cargo nextest run -p fabro-model billing
```

Expected: all `fabro-model` billing tests pass.

## Task 2: Make Stage Usage a First-Class Projection Field

**Files:**
- Modify: `lib/crates/fabro-types/src/run_projection.rs`
- Modify: `docs/public/api-reference/fabro-api.yaml`

- [ ] Change `StageProjection` from terminal-only internal usage to always-present counters:

```rust
#[serde(default)]
pub usage: BilledTokenCounts,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub model_id: Option<String>,
```

- [ ] Remove the `#[serde(skip)] pub usage: Option<BilledModelUsage>` field.

- [ ] Initialize `usage` with `BilledTokenCounts::default()` and `model_id` with `None` in `StageProjection::new`.

- [ ] Confirm `StageProjection::begin_attempt` resets usage and model identity by relying on `*self = Self::new(self.first_event_seq)` before setting `started_at`, `handler`, and `state`.

- [ ] Update the OpenAPI `StageProjection` schema:
  - add `usage: $ref: "#/components/schemas/BilledTokenCounts"`
  - add `model_id: ["string", "null"]`
  - include `usage` in `required`

- [ ] Run:

```bash
cargo build -p fabro-api
```

Expected: the generated Rust API crate still builds with `StageProjection` replaced by `fabro_types::StageProjection`.

## Task 3: Project Live and Terminal Usage in `fabro-store`

**Files:**
- Modify: `lib/crates/fabro-store/src/run_state.rs`

- [ ] Update `EventBody::AgentMessage` projection handling to add live usage deltas:

```rust
EventBody::AgentMessage(props) => {
    let Some(stage) = stage_at_stored_or_visit(self, stored, props.visit, event.seq) else {
        return Ok(());
    };
    stage.usage.add_counts(&props.billing);
    if !props.model.is_empty() {
        stage.model_id = Some(props.model.clone());
    }
}
```

- [ ] Update `EventBody::PromptCompleted` to store the response and replace usage when `props.billing` is present:

```rust
stage.response = Some(props.response.clone());
if let Some(billing) = &props.billing {
    stage.usage.replace_with_billed_usage(billing);
    stage.model_id = Some(billing.model_id().to_string());
}
```

- [ ] Update `EventBody::StageCompleted` and `EventBody::StageFailed` so terminal billing replaces live usage only when billing is present:

```rust
if let Some(billing) = &props.billing {
    stage.usage.replace_with_billed_usage(billing);
    stage.model_id = Some(billing.model_id().to_string());
}
```

- [ ] Do not clear nonzero live usage on terminal events that have `billing: None`; this preserves best-known live usage for events that do not include final pricing.

- [ ] Update existing projection tests that assert `stage.usage.as_ref() == Some(...)` to assert flattened counters and `model_id`.

- [ ] Add tests for live `agent.message` accumulation, terminal replacement, `stage.failed` replacement, and reset on a new `stage.started`.

- [ ] Run:

```bash
cargo nextest run -p fabro-store run_state
```

Expected: projection tests pass.

## Task 4: Keep Live Agent Usage Cost-Aware Where Possible

**Files:**
- Modify: `lib/crates/fabro-agent/src/types.rs`
- Modify: `lib/crates/fabro-agent/src/session.rs`
- Modify: `lib/crates/fabro-workflow/src/event/convert.rs`

- [ ] Add provider identity to `AgentEvent::AssistantMessage`:

```rust
AssistantMessage {
    text: String,
    provider: String,
    model: String,
    usage: TokenCounts,
    tool_call_count: usize,
}
```

- [ ] Emit `provider: self.provider_profile.provider().to_string()` from `Session` when emitting `AgentEvent::AssistantMessage`.

- [ ] In workflow event conversion, price assistant message usage when provider parsing succeeds:

```rust
let billing = provider.parse::<Provider>().ok().map_or_else(
    || billed_token_counts_from_llm(usage),
    |provider| {
        let billed = billed_model_usage_from_llm(model, provider, None, usage);
        BilledTokenCounts::from_billed_usage(std::slice::from_ref(&billed))
    },
);
```

- [ ] Keep the fallback to flattened token counts when provider parsing fails, so live tokens are never lost.

- [ ] Update affected unit tests that pattern-match `AgentEvent::AssistantMessage`.

- [ ] Run:

```bash
cargo nextest run -p fabro-agent
cargo nextest run -p fabro-workflow event::convert
```

Expected: agent event and event conversion tests pass.

## Task 5: Read Projection Usage in Billing Rollups and Server Responses

**Files:**
- Modify: `lib/crates/fabro-workflow/src/billing_rollup.rs`
- Modify: `lib/crates/fabro-server/src/server/handler/billing.rs`
- Modify: `lib/crates/fabro-server/src/server.rs`
- Modify: `lib/crates/fabro-server/src/server/handler/system.rs`

- [ ] Replace `stage.usage.is_some()` checks with `!stage.usage.is_zero()`.

- [ ] Replace `if let Some(usage) = stage.usage.as_ref()` rollup logic with direct `BilledTokenCounts` aggregation:

```rust
if !stage.usage.is_zero() {
    billed_visit_count += 1;
    row.billing.add_counts(&stage.usage);
    totals.add_counts(&stage.usage);
    if let Some(model_id) = &stage.model_id {
        row.model_id = Some(model_id.clone());
        let model_entry = by_model.entry(model_id.clone()).or_insert_with(|| {
            ProjectionBillingByModel {
                model_id: model_id.clone(),
                stages: 0,
                billing: BilledTokenCounts::default(),
            }
        });
        model_entry.stages += 1;
        model_entry.billing.add_counts(&stage.usage);
    }
}
```

- [ ] Replace open-coded token count accumulation in server aggregate billing with `add_counts`.

- [ ] Keep runtime behavior unchanged: live runtime still comes from `started_at` and terminal runtime still comes from `duration_ms`.

- [ ] Run:

```bash
cargo nextest run -p fabro-workflow billing_rollup
cargo nextest run -p fabro-server run_billing
```

Expected: billing rollup and server billing tests pass.

## Task 6: Verify UI Behavior

**Files:**
- Modify tests only if the server response type changes generated client expectations.
- Likely tests: `apps/fabro-web/app/routes/run-billing.test.tsx`

- [ ] Confirm `RunBillingStage.billing` is still `BilledTokenCounts`, so the route should not need behavioral changes.

- [ ] Add or update a route test that renders an in-flight stage with nonzero `billing.input_tokens` and a ticking runtime.

- [ ] Run:

```bash
cd apps/fabro-web && bun test run-billing
```

Expected: billing route tests pass.

## Final Verification

- [ ] Run focused Rust checks:

```bash
cargo nextest run -p fabro-model
cargo nextest run -p fabro-store
cargo nextest run -p fabro-workflow billing
cargo nextest run -p fabro-server run_billing
```

- [ ] Run the API build after OpenAPI edits:

```bash
cargo build -p fabro-api
```

- [ ] Run the web route test:

```bash
cd apps/fabro-web && bun test run-billing
```

## Acceptance Criteria

- In-flight stages included in `/runs/{id}/billing` can show nonzero token counts before `stage.completed`.
- Completed stages still use terminal billing as authoritative when terminal billing exists.
- Retry/new visit behavior resets per-visit usage cleanly.
- Billing totals, by-model totals, and stage rows are derived from `StageProjection`.
- Old projections without `usage` deserialize with zero counters.
