import { effectiveLocalLlmConfig, ANONYMOUS_USER_ID } from "../settings";
import type { ArchitectureMetrics, EvolutionEvent } from "../gitops/evolutionEngine";

/**
 * Generates an optional architectural narrative explaining WHY the metrics shifted
 * or what the milestone signifies, strictly refraining from doing any actual metric computation.
 * 
 * Uses the local, zero-cost LLM provider exclusively.
 */
export async function generateNarrative(
  olderMetrics: ArchitectureMetrics | null,
  newerMetrics: ArchitectureMetrics,
  events: EvolutionEvent[]
): Promise<{ reason: string; recommendation: string } | undefined> {
  // Use the system-configured local LLM (Ollama, LM Studio, etc.)
  const config = effectiveLocalLlmConfig(ANONYMOUS_USER_ID);
  
  // Fail gracefully if no local LLM is configured - we remain 100% deterministic and free.
  if (!config) return undefined;

  const prompt = `
    You are a Principal Software Architect analyzing an evolution milestone.
    Do NOT compute metrics. The metrics have already been deterministically computed.
    
    METRICS BEFORE:
    ${olderMetrics ? JSON.stringify(olderMetrics, null, 2) : "None (Baseline)"}
    
    METRICS AFTER:
    ${JSON.stringify(newerMetrics, null, 2)}
    
    DETERMINISTIC EVENTS DETECTED:
    ${JSON.stringify(events, null, 2)}
    
    Explain the underlying architectural story behind these numbers.
    Provide exactly two sentences for the 'reason' and exactly one sentence for the 'recommendation'.
    
    Format your response as strict JSON matching:
    {
      "reason": "String explaining the shift.",
      "recommendation": "Actionable next step."
    }
  `;

  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, // Low temp for deterministic-ish explanation
        response_format: { type: "json_object" } // Tell compatible models to force JSON
      }),
    });

    if (!res.ok) {
      console.warn(`Local LLM narrative generation failed (${res.status})`);
      return undefined;
    }

    const rawText = await res.text();
    const data = JSON.parse(rawText);
    const content = data.choices?.[0]?.message?.content;
    
    if (content) {
      // Clean and parse the JSON block from output
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
  } catch (error) {
    console.warn("Failed to generate architecture narrative via local LLM:", error);
  }
  
  return undefined;
}
