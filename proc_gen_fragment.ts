
// ─── Procedural Generation from Reflections ─────────────────────────────────

const PROCEDURE_SYSTEM_PROMPT = `You are a procedural knowledge extractor. Given a set of reflective insights
(causal chains, patterns, self-assessments), your job is to distill them into
concrete, step-by-step PROCEDURES that a future agent can follow.

## Rules:
- Each procedure must be a reusable playbook with clear steps
- Steps should be imperative ("Do X", "Check Y", "If Z then W")
- Include trigger conditions: when should this procedure be activated?
- Name should be short and descriptive (3-7 words)
- Type must be one of: workflow, habit, tool_pattern, template
  - workflow: multi-step process for a recurring task
  - habit: behavioral pattern to always follow
  - tool_pattern: specific way to use a tool or API
  - template: reusable response or code template
- Only generate procedures that are genuinely actionable — skip vague observations
- Maximum 5 procedures per batch
- Each procedure must have at least 2 steps

Respond in JSON:
{
  "procedures": [
    {
      "name": "Short descriptive name",
      "type": "workflow" | "habit" | "tool_pattern" | "template",
      "description": "What this procedure accomplishes and why it matters",
      "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],
      "trigger_conditions": ["When X happens", "If Y is true"],
      "confidence": 0.0-1.0,
      "source_insight_ids": ["sn_xxx"]
    }
  ]
}`;

const MIN_INSIGHTS_FOR_PROCEDURES = 3;
const MIN_INSIGHT_CONFIDENCE_FOR_PROCEDURE = 0.7;

interface RawProcedure {
  name: string;
  type: string;
  description: string;
  steps: string[];
  trigger_conditions: string[];
  confidence: number;
  source_insight_ids: string[];
}

/**
 * Generate procedures from recent high-quality reflection insights.
 * Runs as a second LLM pass after the reflection pipeline, converting
 * the best causal/pattern insights into reusable step-by-step playbooks.
 */
async function generateProceduresFromReflections(
  db: Database,
  threadId: number,
): Promise<{ created: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { created: 0 };

  const knowledgeThreadId = resolveKnowledgeThreadId(threadId);

  // Gather recent high-quality causal/pattern reflections (last 7 days)
  const insights = db
    .prepare(
      `SELECT note_id, content, confidence FROM semantic_notes
       WHERE valid_to IS NULL AND superseded_by IS NULL
         AND content LIKE '[REFLECTION]%'
         AND (content LIKE '[REFLECTION] [CAUSAL]%' OR content LIKE '[REFLECTION] [PATTERN]%')
         AND confidence >= ?
         AND created_at >= datetime('now', '-7 days')
         AND (thread_id = ? OR thread_id IS NULL)
       ORDER BY confidence DESC, created_at DESC
       LIMIT 15`,
    )
    .all(MIN_INSIGHT_CONFIDENCE_FOR_PROCEDURE, knowledgeThreadId) as {
    note_id: string;
    content: string;
    confidence: number;
  }[];

  if (insights.length < MIN_INSIGHTS_FOR_PROCEDURES) {
    log.info(
      `[procedures] Skipped — only ${insights.length} qualifying insights (need ${MIN_INSIGHTS_FOR_PROCEDURES})`,
    );
    return { created: 0 };
  }

  // Build the input for the LLM
  const insightText = insights
    .map((ins) => `[${ins.note_id}] (conf: ${ins.confidence}) ${ins.content}`)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: PROCEDURE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `## Reflective insights to convert into procedures:\n\n${insightText}\n\nExtract actionable procedures from the insights above.`,
    },
  ];

  let raw: string;
  try {
    raw = await chatCompletion(messages, apiKey, {
      model: process.env.REFLECTION_MODEL ?? process.env.CONSOLIDATION_MODEL ?? "gpt-4o-mini",
      maxTokens: 4096,
      temperature: 0.3,
      responseFormat: { type: "json_object" },
      timeoutMs: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[procedures] LLM call failed: ${msg}`);
    return { created: 0 };
  }

  let parsed: { procedures?: RawProcedure[] };
  try {
    parsed = repairAndParseJSON(raw) as { procedures?: RawProcedure[] };
  } catch (err) {
    log.error(
      `[procedures] JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { created: 0 };
  }

  const rawProcs = parsed.procedures ?? [];
  const validTypes = new Set(["workflow", "habit", "tool_pattern", "template"]);
  let created = 0;

  for (const proc of rawProcs) {
    if (!proc.name || !proc.description || !Array.isArray(proc.steps) || proc.steps.length < 2) {
      log.info(`[procedures] Skipped invalid procedure: ${proc.name ?? "unnamed"}`);
      continue;
    }

    const procType = validTypes.has(proc.type) ? proc.type : "workflow";

    // Deduplicate by name — skip if a procedure with the same name already exists
    const existing = getProcedureByName(db, proc.name);
    if (existing) {
      log.info(`[procedures] Skipped duplicate: "${proc.name}"`);
      continue;
    }

    const confidence = Math.max(0, Math.min(1, proc.confidence ?? 0.5));
    const sourceIds = (proc.source_insight_ids ?? []).filter(
      (id) => typeof id === "string" && id.startsWith("sn_"),
    );

    const procId = saveProcedure(db, {
      name: proc.name,
      type: procType as "workflow" | "habit" | "tool_pattern" | "template",
      description: proc.description,
      steps: proc.steps.map(String),
      triggerConditions: (proc.trigger_conditions ?? []).map(String),
      learnedFrom: sourceIds,
      confidence,
    });

    log.info(`[procedures] Created: ${procId} — "${proc.name}" (${procType}, conf: ${confidence})`);
    created++;
  }

  // Enforce cap after creating new procedures
  if (created > 0) {
    enforceProcedureCap(db);
  }

  log.info(`[procedures] Generation complete: ${created} procedures from ${insights.length} insights`);
  return { created };
}
