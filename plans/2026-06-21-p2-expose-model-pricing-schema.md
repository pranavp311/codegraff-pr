# P2: Expose model pricing table through schema/SDKs

## Priority

P2

## Area

Core schema, SDK generation, GUI cost display, trajectory/cost tooling

## Problem

`src/main.zig` currently has the only source-of-truth pricing table:

```zig
const price_table = [_]ModelPrice{
    .{ .name = "gpt-5.5", .in = 5, .out = 30, .cache = 0.5 },
    // ...
};
```

That table powers CLI/session accounting (`/cost`, `--cost`, JSON `turn.cost_usd`, and trajectory `usage.cost_usd`). But it is not exposed through `graff --schema`, so SDKs, GUI code, and third-party tooling can observe final `cost_usd` after a turn but cannot independently estimate, preview, or recompute spend from token usage without duplicating prices manually.

## Desired behavior

Expose model pricing metadata in the machine-readable schema and generated SDKs.

Example schema shape:

```json
{
  "pricing": [
    {
      "model": "gpt-5.5",
      "input_usd_per_mtok": 5.0,
      "output_usd_per_mtok": 30.0,
      "cache_read_usd_per_mtok": 0.5
    }
  ]
}
```

Optionally expose provider billing classification too:

```json
{
  "provider_billing": {
    "codex": "subscription",
    "openai": "metered",
    "anthropic": "metered"
  }
}
```

This lets UI/SDKs distinguish estimated API spend from flat-rate/subscription usage.

## Acceptance criteria

- `graff --schema` includes every entry from `price_table`.
- TypeScript SDK generation exports pricing metadata and types, e.g. `MODEL_PRICES` / `ModelPrice`.
- Python SDK generation exports equivalent pricing metadata.
- README/SDK docs mention prices are estimates and may lag actual provider billing.
- No duplicate hand-maintained pricing table outside `src/main.zig`.
- Existing CLI cost behavior remains unchanged.
- Subscription providers such as `codex` remain represented as flat-rate/subscription rather than per-token API spend.
- Trajectory usage records can be recomputed by downstream tools using only `harness.trajectory.jsonl` plus schema pricing metadata.

## Implementation notes

Likely touch points:

- `src/main.zig`
  - schema renderer for `graff --schema`
  - `price_table`, `ModelPrice`, `billingFor`
- `sdk/generate.py`
  - TypeScript constants/types
  - Python constants/types
- `sdk/README.md`, `sdk/ts/README.md`, `sdk/py/README.md`
  - document estimated pricing metadata

## Risks / caveats

- Provider pricing changes over time. Schema should make clear prices are a baked-in snapshot.
- Same model name can be served by multiple providers. Current `price_table` is keyed by model name and provider-agnostic; if that becomes wrong, schema may need provider+model keys later.
- Subscription/login routes should not be displayed as paid API spend even if the underlying model has a price row.
