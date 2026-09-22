# jev-model-router

> [!NOTE]
> **Use it for effort only.** Routing the main conversation's *model* costs more
> than it saves in long sessions: caches are per model, so a switch re-writes
> the whole context (~$2.40 to hop Opus 5.5 to Sonnet 5 at 600k, against $0.12
> to stay warm). Routing *effort* doesn't have that problem: on Claude Code
> 2.1.280+ effort is sent per turn and the cache survives, so dropping to `low`
> on simple turns saves thinking and output tokens at any session size.
> Status: experimental, not yet measured on a real bill.

Picks the reasoning effort (and optionally the model) for each turn using
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
TypeSafe's System One decision model: unstructured state in, a typed choice
with a probability distribution out, no free-form text.

It talks to TypeSafe only, logs name what actually changed, a stray
classification never unroutes the next turn, and model switches are refused once
the session is too big for them to pay off.

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
| `routeMainModel` | model of the main conversation, at `turn.step` | off | **off** |
| `routeMainEffort` | reasoning effort of the main conversation | on | on |
| `routeSubagentModel` | model of each subagent, at `agent.spawn` | on | **off** |

`routeSubagentModel` is off so an explicit `model:` you pass on an Agent spawn is
never overridden. `routeMainModel` is off because a model switch invalidates
the prompt cache (see How it decides). `routeMainEffort` is the useful one.

The prompt is classified at `prompt.submit` and the decision applies to the
turn's first model request, then is reused for the rest of that turn.

## What it asks

One request, three questions evaluated in parallel:

- `tier`: a `choice` between three descriptions of the *work* (mechanical and
  local / ordinary engineering / hard or high-stakes). Jev never sees a model name.
- `effort`: a `score` on a four-level rubric for how much reasoning the task needs.
- `risky`: a `noul` for whether carrying out the task would itself change
  production, move real money, or alter data that can't be restored. Writing or
  testing code that deals with those things doesn't count.

## How it decides

**Model switches are gated; effort isn't.** Prompt caches are per model. A
model switch means the new model has no cache for the conversation, so the
whole context is written again: 1.25x the input rate (5-minute cache) or 2x
(1-hour cache). Per turn at 600k context:

| | Opus 5.5 | Sonnet 5 |
|---|---|---|
| Stay warm (cache read, $0.20/M) | $0.12 | $0.12 |
| Cold hop, 5-minute cache | $3.00 | $1.50 |
| Cold hop, 1-hour cache | $4.80 | $2.40 |

A cold hop to Sonnet costs ~$2.28 more than staying on Opus. Sonnet saves
$10/M on output, so it needs ~228k output tokens on routed turns to earn that
back; quick "fast" turns almost never do. Hopping back to Opus within the cache
lifetime usually finds Opus's cache still warm. So above `maxSwitchTokens`
(50k) the model is never changed.

Effort is different. On Claude Code 2.1.280+ effort goes out per turn and the
cache survives the change on Opus 5.5, so effort is routed at any session size.
Dropping to `low` on a simple turn cuts thinking and output tokens ($20/M on
Opus 5.5) with no re-read.

Prices: Opus 5.5 $4 in / $0.20 cache read / $20 out; Sonnet 5 $2 in / $0.20 cache
read / $10 out, per million tokens.

Then, the two mistakes don't cost the same, so they don't share a bar:

- Spending **more** (bigger model, more reasoning) needs `minUpgradeConfidence`, 0.3.
- Spending **less** needs `minDowngradeConfidence`, 0.6.
- `risky` above 0.7 forces the deep tier and real reasoning, past both bars.
- **Context gate**: a routed model without `[1m]` is applied only when live
  context is at or under `smallModelMaxTokens` (150k). Above it, or
  when the size can't be read, the turn goes to the balanced tier instead when
  that is a `[1m]` model (Sonnet by default), otherwise it stays on its current model. Jev reads
  only your latest message, so a short "i merged it already" can score `fast` at
  0.92 inside an 850k session; without this gate that switched to Haiku's 200k
  window, forced a compaction, and the compaction then failed on Haiku too.
  `[1m]` models are never gated. With the defaults this gate never fires,
  because `maxSwitchTokens` (50k) already stops every model switch first. It
  only matters if you raise `maxSwitchTokens` above `smallModelMaxTokens`.

Any failure (non-2xx, timeout, malformed body, thrown error) leaves the request
exactly as the engine built it. The router never blocks a turn.

## What you see

```
[jev-model-router] ready on typesafe (https://api.typesafe.ai/v1/systemone); routing main effort
[jev-model-router] wants effort low: tier fast (0.87) · effort 0.4 → low (0.71) · risky 0.02 · 249ms
[jev-model-router] main loop → effort low: fast (confidence 0.87)
[jev-model-router] wants effort medium: tier balanced (0.52) · effort 1.2 → medium (0.50) · risky 0.10 · 249ms
[jev-model-router] main loop: kept effort medium: balanced (confidence 0.52)
```

That's effort-only mode at 600k context: a simple turn drops to `low` on the
same model and cache; an ordinary one stays at `medium`. With `routeMainModel` on,
a model switch above `maxSwitchTokens` logs `a model switch would re-read it
uncached, model kept` instead.

- `ready on` appears once per session: proof the module loaded, and which backend answers.
- `wants` is what Jev asked for, before policy. It fires at `prompt.submit`, before the turn exists.
- `main loop →` means it **changed** something. `main loop: kept` means it
  declined, and the text says why (usually confidence under the downgrade bar,
  or the context gate).

The status line under the prompt always leads with the model the turn actually runs on:

```
claude-opus-5-5[1m]/low · fast 0.87 · routed
claude-opus-5-5[1m]/medium · balanced 0.52 · kept
claude-opus-5-5[1m]/medium · no decision
```

`no decision` means no classification reached this turn: the TypeSafe call
failed or timed out, or the turn had no prompt of its own (a resumed session,
a queued continuation). It fails open.

The banner and `/model` never move: routing rewrites each request, not the
session setting. Trust the `main loop` line and the status line, not the header.

### No lines at all

1. **Headless run (`claude -p` or the SDK).** Lines go to `~/.claude/debug/<session-id>.txt` instead.
2. **Function hooks are off.** Needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and Claude Code 2.1.280+.
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
  maxSwitchTokens:        number  above this, never change the model; effort is unaffected (default 50000)
  maxEffort:              string  highest effort the router may set: low|medium|high|xhigh (default "high")
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
        "maxSwitchTokens": 50000,
        "maxEffort": "high",
        "smallModelMaxTokens": 150000,
        "routeMainModel": false,
        "routeMainEffort": true,
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
`claude plugin validate`. It needs Claude Code 2.1.280+. The key is read from
the environment and written only to your `settings.json`; it is never stored in
this repo.

After installing, restart Claude Code and run `/plugin-types` to generate the
plugin API's TypeScript declarations. The `$` API is early access and gets
renamed between releases, and `claude plugin validate` **does not** check that
a `$` method exists; type-checking against those declarations does.

## Tests

```sh
bun test tests/policy.test.ts
```

Needs `bun`. The router loads without `node_modules`, so TypeSafe is spoken to
over plain HTTP through `$.http.fetch`. The wire shape was read from
`@typesafe-ai/sdk` v0.6.0 and may change.
