/**
 * jev-model-router — routes each turn's reasoning effort with TypeSafe's Jev.
 *
 * Jev classifies every prompt (tier, effort, risk) at `prompt.submit`; the
 * decision is applied at the turn's first `turn.step` request and reused for
 * the rest of that turn. Every new turn starts again from the session's own
 * model and effort.
 *
 * Recommended: effort only (routeMainModel false). Lowering effort on a
 * simple turn cuts thinking/output tokens and, on Claude Code 2.1.280+, keeps
 * the prompt cache (effort is sent per turn). Switching the MODEL throws the
 * cache away, so model changes are refused above `maxSwitchTokens`.
 *
 * Both directions: a task read as mechanical is routed down, a hard one up,
 * with a higher confidence bar to spend less than to spend more.
 *
 * Fail-open: an error, timeout, or malformed answer leaves the request exactly
 * as the engine built it. With no `typesafeApiKey`, the engine's own
 * `$.model.classify` answers (no confidence, so it can only route up).
 *
 * Needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 and Claude Code >= 2.1.280.
 * Privacy: with a key set, the prompt text is sent to api.typesafe.ai.
 */
import type { Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  describeDecision,
  effortLevel,
  EFFORT_ORDER,
  describeSetup,
  describeStatus,
  endpoint,
  pendingDecisions,
  readDecision,
  selectProvider,
  requestBody,
  requestHeaders,
  requestModelId,
  route,
  TIER_ORDER,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Tier } from './policy.ts'

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  // TypeSafe's own API is preferred when both keys are set: it is the only
  // one that reports a calibrated confidence, which the policy's threshold
  // reads. `provider` forces one, including "builtin" to use neither.
  const typesafeKey = text('typesafeApiKey', '')
  const gatewayKey = text('gatewayApiKey', '')
  const forced = text('provider', 'auto')
  const active: Provider | null = selectProvider(forced, typesafeKey, gatewayKey)

  // Each backend keeps its own URL and model, so an override written for one
  // can never be sent to the other when `auto` picks differently than expected.
  const apiKey = active === 'typesafe' ? typesafeKey : active === 'gateway' ? gatewayKey : ''
  const modelId = !active
    ? ''
    : active === 'typesafe'
      ? text('typesafeModel', DEFAULT_MODEL.typesafe)
      : text('gatewayModel', DEFAULT_MODEL.gateway)
  const url = !active
    ? ''
    : active === 'typesafe'
      ? endpoint('typesafe', text('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe))
      : endpoint('gateway', text('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))

  // A backend named in the options but missing its key degrades to the
  // built-in classifier, which is silent; say so once, when a hook first runs.
  let unusableReported = forced === 'auto' || forced === 'builtin' || active !== null

  const timeoutMs = number('timeoutMs', 800)
  const routeSubagentModel = flag('routeSubagentModel', true)
  const routeMainEffort = flag('routeMainEffort', true)
  const routeMainModel = flag('routeMainModel', false)
  const routeMainLoop = routeMainEffort || routeMainModel
  const logDecisions = flag('logDecisions', true)
  // A model without `[1m]` has a ~200k window. Routing a session
  // already past that onto it forces an auto-compaction, which then runs on the
  // small model and cannot fit the conversation either. Above this many live
  // context tokens, a switch to a non-1M model is refused and the turn stays on
  // the current model. Headroom below 200k covers the turn's own output.
  const smallModelMaxTokens = number('smallModelMaxTokens', 150000)
  // Changing the MODEL mid-conversation throws away the prompt cache (caches
  // are per model): the whole context is written again at up to 2x the input
  // rate. At 600k that is ~$2.40 to hop Opus 5.5 → Sonnet 5 against $0.12 to
  // stay warm, more than one cheap turn earns back. Above this many live
  // context tokens a model change is refused.
  //
  // EFFORT is not gated. Claude Code 2.1.280+ sends effort per turn
  // (per-turn-control), which keeps the cache on Opus 5.5, so lowering effort
  // on a simple turn saves thinking/output tokens at any session size.
  const maxSwitchTokens = number('maxSwitchTokens', 50000)
  // The highest effort the router may set. It never raises a turn past this,
  // whatever Jev or the risk rule asks for.
  const maxEffortRaw = text('maxEffort', 'high')
  const maxEffortRank = Math.max(0, EFFORT_ORDER.indexOf(maxEffortRaw as Effort))

  const policy: PolicyConfig = {
    tiers: {
      fast: text('fastModel', 'haiku'),
      balanced: text('balancedModel', 'sonnet'),
      deep: text('deepModel', 'opus'),
    },
    minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
    minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
  }

  // The classification waiting for the turn that reads its prompt, and what
  // the current turn settled on. Both are single slots: main-loop turns run
  // one at a time, so nothing accumulates over a long session. `pending`
  // keeps only the latest classification, so a prompt that never starts a
  // turn (a slash command, an interrupt) can't leave the next one unrouted.
  const pending = pendingDecisions()
  // Said once, the first time a hook runs. A router that loaded and one that
  // never loaded are otherwise told apart only by the absence of later lines,
  // and absence is not evidence: the policy leaves most turns alone anyway.
  let announced = false
  let appliedTurnId: string | undefined
  let applied: { model?: string; effort?: Effort } | null = null

  on('prompt.submit', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }
    if (!routeMainLoop) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(active, { prompt: e.text }, modelId),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the turn alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      // No backend: the engine's own small-model classifier answers the same
      // question, without the confidence the policy's threshold reads.
      try {
        const label = await $.model.classify(e.text, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    // What the decision model actually answered, whatever the policy then
    // does with it. This is the line that proves the classification ran.
    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      // Name the model this decision asks for, not the decider.
      // "jev:" told you who chose and never what you would get.
      const wants = !decision
        ? 'no decision'
        : routeMainModel
          ? requestModelId(policy.tiers[decision.tier])
          : decision.effort !== null
            ? `effort ${effortLevel(decision.effort)}`
            : 'no effort answer'
      $.ui.log(`[jev-model-router] wants ${wants}: ${describeDecision(decision, ms)}`)
    }

    pending.put(decision)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!routeMainLoop || e.agentId) return yield* next(e)

    // Every request after the first reuses what the turn settled on, so
    // neither the model nor the effort changes under its own tool loop.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      return yield* next(applied ? { ...e, ...applied } : e)
    }

    const decision = pending.take()
    const routing = route(decision, { model: e.model, effort: e.effort }, policy)
    const change: { model?: string; effort?: Effort } = {}
    // The main loop's `model` is sent to the API as written, so an alias
    // becomes its id here; a subagent's (agent.spawn) may stay an alias.
    let tooBig = ''
    const wantsModel = routeMainModel && Boolean(routing.model)
    const wantsEffort = routeMainEffort && Boolean(routing.effort)
    // Free call: the status line's own figures, no token-count request. Read
    // only when a model change is on the table; unknown size counts as too big.
    let tokens = 0
    if (wantsModel) {
      try {
        tokens = (await $.session.usage()).context.tokens ?? 0
      } catch {
        tokens = Number.POSITIVE_INFINITY
      }
    }
    const size = Number.isFinite(tokens) ? Math.round(tokens / 1000) + 'k' : 'unknown'
    const cacheBound = wantsModel && tokens > maxSwitchTokens
    if (cacheBound) {
      tooBig = ` (context ${size} > ${Math.round(maxSwitchTokens / 1000)}k: a model switch would re-read it uncached, model kept)`
    } else if (wantsModel && routing.model) {
      const wanted = requestModelId(routing.model)
      if (/\[1m\]/i.test(wanted)) {
        change.model = wanted
      } else {
        if (tokens <= smallModelMaxTokens) change.model = wanted
        else {
          // Too big for the small model: take the balanced tier instead when it
          // is a 1M model, so a cheap task still runs cheaper than the session
          // default without risking a compaction. The downgrade bar was already
          // cleared for the smaller tier, so the milder step clears it too.
          const fallback = requestModelId(policy.tiers.balanced)
          if (/\[1m\]/i.test(fallback) && fallback !== e.model) {
            change.model = fallback
            tooBig = ` (context ${size} > ${Math.round(smallModelMaxTokens / 1000)}k, ${wanted} → ${fallback})`
          } else {
            tooBig = ` (context ${size} > ${Math.round(smallModelMaxTokens / 1000)}k, ${wanted} skipped)`
          }
        }
      }
    }
    if (wantsEffort && routing.effort) {
      const capped = EFFORT_ORDER[Math.min(EFFORT_ORDER.indexOf(routing.effort), maxEffortRank)] as Effort
      // Capping can land on the effort the turn already has: then there is nothing to change.
      if (capped !== e.effort) change.effort = capped
    }

    appliedTurnId = e.turnId
    applied = Object.keys(change).length > 0 ? change : null
    // A row in the transcript scrolls away; this line stays on screen.
    if (logDecisions) $.ui.status(describeStatus(decision, applied, { model: e.model, effort: e.effort }))

    if (!applied) {
      // A turn left alone is the common case, and it used to be silent, which
      // made a working mod look like one that never loaded. Say what happened.
      if (logDecisions) {
        if (!routeMainModel && decision) {
          // Effort-only: the tier's model is irrelevant, so don't name it.
          const said = decision.confidence === null ? 'confidence n/d' : `confidence ${decision.confidence.toFixed(2)}`
          $.ui.log(`[jev-model-router] main loop: kept effort ${e.effort ?? 'default'}: ${decision.tier} (${said})`)
        } else {
          const suppressed = routing.model && !routeMainModel ? ' (main-loop model routing off)' : ''
          $.ui.log(`[jev-model-router] main loop: ${routing.reason}${suppressed}${tooBig}`)
        }
      }
      return yield* next(e)
    }
    if (logDecisions) {
      const what = [change.model, change.effort && `effort ${change.effort}`]
        .filter(Boolean)
        .join(', ')
      $.ui.log(`[jev-model-router] main loop → ${what}: ${routing.reason}${tooBig}`)
    }
    return yield* next({ ...e, ...change })
  })

  on('agent.spawn', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }

    // A fork inherits its parent's model; `model` is ignored for it.
    if (!routeSubagentModel || e.fork) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(
              active,
              { prompt: e.prompt, description: e.description, agentType: e.subagentType },
              modelId,
            ),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the subagent alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      try {
        const label = await $.model.classify(e.prompt, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[jev-model-router] jev (${e.subagentType}): ${describeDecision(decision, ms)}`)
    }

    // The subagent's own model wins when the caller named one; otherwise it
    // would inherit the parent's, so that is what a change is measured from.
    // The Agent tool takes no effort, so only the model is ours to set here.
    const current = e.model ?? e.parentModel
    const { model, reason } = route(decision, { model: current }, policy)
    if (!model) {
      if (logDecisions) $.ui.log(`[jev-model-router] ${e.subagentType}: ${reason}`)
      return next(e)
    }
    if (logDecisions) $.ui.log(`[jev-model-router] ${e.subagentType} → ${model}: ${reason}`)
    return next({ ...e, model })
  })
}
