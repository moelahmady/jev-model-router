# jev-model-router

Picks the model and reasoning effort for each turn using
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
TypeSafe's System One decision model: unstructured state in, a typed choice
with a probability distribution out, no free-form text.

TypeSafe only, logs that name the real model, a stray classification never
unroutes the next turn, and a context-size gate that keeps small-window models
like Haiku away from big sessions.

## Backend

| Backend | Endpoint | Model | Confidence |
|---|---|---|---|
| `typesafe` | `POST api.typesafe.ai/v1/systemone` | `jev-latest` | reported per answer |

With no key set it falls back to the engine's own `$.model.classify` (Claude's
small fast model). That path reports no confidence, so it can only route **up**,
never down. `provider: "builtin"` forces it. `provider: "gateway"` also lands on
the built-in classifier: there is no Gateway path, so nothing is ever sent to
Vercel.

## Switches

| Switch | What it sets | Default | Recommended |
|---|---|---|---|
| `routeMainModel` | model of the main conversation, at `turn.step` | off | **on** |
| `routeMainEffort` | reasoning effort of the main conversation | on | on |
| `routeSubagentModel` | model of each subagent, at `agent.spawn` | on | **off** |

`routeSubagentModel` is off so an explicit `model:` you pass on an Agent spawn is
never overridden. Switching the main loop's model mid-session invalidates the
prompt cache; on a long context re-caching can cost more than the cheaper tier
saves, so watch your sessions.

The prompt is classified at `prompt.submit` and the decision applies to the
turn's first model request, then is reused for the rest of that turn.

## What it asks

One request, three questions evaluated in parallel:

- `tier`: a `choice` between three descriptions of the *work* (mechanical and
  local / ordinary engineering / hard or high-stakes). Jev never sees a model name.
- `effort`: a `score` on a four-level rubric for how much reasoning the task needs.
- `risky`: a `noul` for whether the task touches production, money,
  credentials, or state that can't be undone.

## How it decides

The two mistakes don't cost the same, so they don't share a bar:

- Spending **more** (bigger model, more reasoning) needs `minUpgradeConfidence`, 0.3.
- Spending **less** needs `minDowngradeConfidence`, 0.6.
- `risky` above 0.7 forces the deep tier and real reasoning, past both bars.
- **Context gate:** a routed model without `[1m]` is applied only
  when live context is at or under `smallModelMaxTokens` (150k). Above it, or
  when the size can't be read, the turn goes to the balanced tier instead when
  that is a `[1m]` model (Sonnet by default), otherwise it stays on its current model. Jev reads
  only your latest message, so a short "i merged it already" can score `fast` at
  0.92 inside an 850k session; without this gate that switched to Haiku's 200k
  window, forced a compaction, and the compaction then failed on Haiku too.
  `[1m]` models are never gated.

Any failure (non-2xx, timeout, malformed body, thrown error) leaves the request
exactly as the engine built it. The router never blocks a turn.

## What you see

```
[jev-model-router] ready on typesafe (https://api.typesafe.ai/v1/systemone); routing main effort, main model
[jev-model-router] wants claude-haiku-4-5-20251001: tier fast (0.87) · effort 0.4 → low (0.71) · risky 0.02 · 249ms
[jev-model-router] main loop → claude-haiku-4-5-20251001, effort low: fast (confidence 0.87)
[jev-model-router] wants claude-sonnet-5[1m]: tier balanced (0.52) · effort 0.8 → medium (0.50) · risky 0.10 · 802ms
[jev-model-router] main loop: kept claude-opus-5-5[1m]/medium, wanted claude-sonnet-5[1m]/medium (confidence 0.52)
[jev-model-router] main loop → claude-sonnet-5[1m], effort low: fast (confidence 0.95) (context 850k > 150k, claude-haiku-4-5-20251001 → claude-sonnet-5[1m])
```

The last line is the context gate at work: Jev said `fast`, but the session is
too big for Haiku, so the turn goes to Sonnet `[1m]` instead: still cheaper than
Opus, and no forced compaction.

- `ready on` appears once per session: proof the module loaded, and which backend answers.
- `wants` is what Jev asked for, before policy. It fires at `prompt.submit`, before the turn exists.
- `main loop →` means it **changed** something. `main loop: kept` means it
  declined, and the text says why (usually confidence under the downgrade bar,
  or the context gate).

The status line under the prompt always leads with the model the turn actually runs on:

```
claude-haiku-4-5-20251001/low · fast 0.87 · routed
claude-opus-5-5[1m]/medium · fast 0.41 · kept
claude-opus-5-5[1m]/medium · no decision
```

`no decision` means no classification reached this turn: the TypeSafe call
failed or timed out, or the turn had no prompt of its own (a resumed session,
a queued continuation). It fails open.

The banner and `/model` never move: routing rewrites each request, not the
session setting. Trust the `main loop` line and the status line, not the header.

### No lines at all

1. **Headless run (`claude -p` or the SDK).** Lines go to `~/.claude/debug/<session-id>.txt` instead.
2. **Function hooks are off.** Needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and Claude Code 2.1.259+.
3. **Options under the wrong key.** A `ready on the built-in classifier, no key set`
   line when you did set a key means `pluginConfigs` uses the wrong id. Installed
   in `~/.claude/skills/`, the id is `jev-model-router@skills-dir`.

## Privacy

With a key set, your prompt text goes to `api.typesafe.ai`. The subagent path
(only if `routeSubagentModel` is on) also sends the subagent's prompt,
description, and agent type. Nothing else. No key: nothing leaves for a third
party, though the built-in classifier still sends the prompt to Anthropic on
your normal Claude Code credentials.

## Options

```
  typesafeApiKey:         string  TypeSafe API key
  provider:               string  "auto" | "typesafe" | "builtin"
  typesafeBaseUrl:        string  empty uses https://api.typesafe.ai
  typesafeModel:          string  empty uses jev-latest
  fastModel:              string  fast tier, alias or full id (default "haiku")
  balancedModel:          string  balanced tier, alias or full id (default "sonnet")
  deepModel:              string  deep tier, alias or full id (default "opus")
  smallModelMaxTokens:    number  context cap for any non-[1m] model (default 150000)
  minUpgradeConfidence:   number  bar to spend more (default 0.3)
  minDowngradeConfidence: number  bar to spend less (default 0.6)
  routeSubagentModel:     boolean model of each subagent (default true)
  routeMainEffort:        boolean effort of the main loop (default true)
  routeMainModel:         boolean model of the main loop (default false)
  timeoutMs:              number  latency budget per classification (default 800)
  logDecisions:           boolean log each decision (default true)
```

On the main loop an alias resolves to an id: `haiku` → `claude-haiku-4-5-20251001`,
`sonnet` → `claude-sonnet-5`, `opus` → `claude-opus-5-5[1m]`. A full id is sent as
written, `[1m]` suffix included. A decision for the tier the session already
runs is not a change.

**Keep `deepModel` on the model your session actually runs.** If you move to a
newer Opus, update it, or a `deep` verdict will downgrade you to the old one.

Recommended config, in `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" },
  "pluginConfigs": {
    "jev-model-router@skills-dir": {
      "options": {
        "typesafeApiKey": "apikey_...",
        "provider": "typesafe",
        "timeoutMs": 2500,
        "fastModel": "haiku",
        "balancedModel": "claude-sonnet-5[1m]",
        "deepModel": "claude-opus-5-5[1m]",
        "smallModelMaxTokens": 150000,
        "routeMainModel": true,
        "routeSubagentModel": false
      }
    }
  }
}
```

`timeoutMs` is 2500 rather than 800 because a measured TypeSafe call took
680 to 750ms, about 420ms of it TLS. 800 timed out often.

## Install

From a clone:

```bash
git clone https://github.com/moelahmady/jev-model-router
TYPESAFE_API_KEY='apikey_...' ./jev-model-router/install.sh
```

The installer copies the plugin to `~/.claude/skills/jev-model-router`, backs up
`settings.json`, writes the recommended config above, and runs
`claude plugin validate`. It needs Claude Code 2.1.259+. The key is never stored
in the package. Send it separately from the file.

After installing, restart Claude Code and run `/plugin-types`. The `$` API is
early access and gets renamed between releases, and `claude plugin validate`
**does not** check that a `$` method exists; only the generated declarations do.

## Tests

```sh
bun test tests/policy.test.ts
```

Needs `bun`. The router loads without `node_modules`, so TypeSafe is spoken to
over plain HTTP through `$.http.fetch`. The wire shape was read from
`@typesafe-ai/sdk` v0.6.0 and may change.
