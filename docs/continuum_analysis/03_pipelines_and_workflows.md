# Continuum OS: Pipelines & Workflows

Continuum’s true complexity lies in its backend Python Engine. This document outlines the critical data pipelines and orchestration workflows that enable its autonomous AI capabilities.

## 1. Repository Ingestion Pipeline
Before agents can act, the system must build a structural understanding of the codebase.
1.  **Clone:** `GitPython` fetches the repository to a localized `/tmp/continuum-repos` storage path.
2.  **Static Pre-Analysis:** The engine performs a fast, non-LLM scan to map the directory structure, identify file types, and locate secrets or obvious vulnerabilities.
3.  **Chunking:** The codebase is split into semantically meaningful segments using `langchain-text-splitters`.
4.  **Embedding:** Text chunks are transformed into vector embeddings. The engine utilizes `sentence-transformers` for local processing, reducing API latency and cost.
5.  **Indexing:** Vectors, along with their metadata (file path, line numbers), are upserted into the `Qdrant` vector database.
6.  **Cache Invalidation:** Any prior contextual caches related to this repository commit hash in Redis are purged.

## 2. Agent Orchestration Workflow
Continuum avoids "agent sprawl" (where multiple LLMs talk over each other without context) by using a strictly controlled orchestration pipeline.

### The Pipeline Architecture:
1.  **Intent Classification (`intent_classifier.py`):** When a user submits a prompt via the UI or Terminal, this module determines the required specialization (e.g., "Is this a security audit or a bug fix?").
2.  **Shared Retrieval (`shared_retrieval.py`):** Instead of every agent querying the Vector DB individually, the Orchestrator performs a single, high-quality RAG retrieval from Qdrant. This shared context is passed down, drastically reducing token usage and DB load.
3.  **Token Budgeting (`token_budget.py`):** A strict gatekeeper that calculates the size of the shared context. It truncates or summarizes data before handing it to the LLMs to prevent context-window exhaustion and control API costs.
4.  **Agent Execution (`orchestrator.py` & `/agents/`):** 
    *   The orchestrator spawns the specific agent(s) required (`bug_agent`, `security_agent`, `architecture_agent`, `dependency_agent`, `docs_agent`).
    *   Agents receive the token-budgeted shared context and perform their specialized analysis using OpenAI/Gemini models.
5.  **Quality Gate (`finding_processor.py`):** Agent outputs are not streamed directly to the user. They pass through a processor that deduplicates findings, standardizes the output format, and discards low-confidence hallucinations.
6.  **Action Plan Generation (`action_engine.py`):** The final step aggregates the processed findings into a concrete, structured "Action Plan" (scores, risk levels, and step-by-step resolution logic). This creates a stable JSON contract that the Next.js UI can reliably render.

## 3. RAG (Retrieval-Augmented Generation) Implementation
The RAG pipeline is deeply integrated into the Shared Retrieval step.
*   **Vector Search:** Utilizes Qdrant for semantic similarity searches against the code embeddings.
*   **Hybrid Approach:** While not explicitly detailed, the static pre-analysis suggests a hybrid approach where exact string matching (grep-style) is combined with vector search to ensure specific function names or variables are not lost in the semantic noise.
*   **Context Window Optimization:** By centralizing the RAG query *before* agent execution, Continuum ensures that all agents operate on a unified, heavily optimized "truth" of the repository state.

## 4. Execution Sandbox (Planned/Partial)
The engine includes `docker` in its requirements and a `/sandbox` router.
*   **Workflow:** When an agent proposes a fix, the pipeline intends to spin up an ephemeral Docker container.
*   **Action:** It injects the modified code into the container and runs the repository's test suite to verify the fix autonomously before presenting it to the human user for approval.
*   *Note: According to the project audit, aspects of this workspace editing and sandbox execution remain in a "placeholder" or mock state on the client side, requiring further wiring to the engine's capabilities.*