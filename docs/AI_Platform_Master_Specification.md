# Master Specification: AI Engineering Intelligence Platform

## 1. Product Vision & Target Audience
**Problem:** Codebases degrade over time. Knowledge silos form, architectural boundaries drift, and technical debt accumulates silently. Existing tools (GitHub, Sourcegraph, SonarQube) provide point-in-time analysis or textual search, but fail to explain the *temporal evolution* of software—the "why" behind structural decay.
**Target Users:** Engineering Managers, Staff/Principal Engineers, Tech Leads, and Onboarding Developers.
**Differentiator:** Temporal architecture analysis combined with AI. Instead of just highlighting a complex class, it identifies exactly when and why the class became complex, who owns the decay, and generates an AI roadmap to refactor it.

## 2. High-Level Architecture
To support repositories with millions of lines of code and tens of thousands of commits, the platform utilizes an event-driven, microservice-oriented architecture.

### Core Systems
1. **API Gateway / Auth Service:** Handles rate limiting, JWT validation, tenant isolation, and REST/GraphQL routing.
2. **Ingestion & Webhook Engine:** Listens to GitHub/GitLab webhooks. Enqueues repository indexing jobs.
3. **Queue / Message Broker (Redis/RabbitMQ/Kafka):** Decouples ingestion from heavy processing.
4. **Worker Pool (Heavy Compute):** Auto-scaling workers that perform Git checkout, AST parsing, and graph building.
5. **AI Analysis Pipeline:** 
   - **Tier 1 (Fast/Local):** Small, fast models (e.g., Llama 3 8B) for semantic commit tagging, spam filtering, and basic summarization.
   - **Tier 2 (Heavy/Remote):** Advanced models (GPT-4o/Claude 3.5 Sonnet) for high-level roadmap generation and deep architectural narrative synthesis.

### Storage Layer
1. **Relational Database (PostgreSQL):** Stores users, tenants, repository metadata, jobs, and permissions.
2. **Graph Database (Neo4j / Memgraph):** Stores the AST, dependencies, and modules. *Crucially, uses Event Sourcing (Delta Graphs)*. We do NOT store full copies of the graph per commit. We store the base graph and a time-series of `GraphDiff` edges (added/removed nodes/edges).
3. **Vector Database (Qdrant / Milvus):** Stores embeddings of commit summaries, PRs, and architectural decisions to power the AI RAG (Retrieval-Augmented Generation) engine.
4. **Blob Storage (S3):** Caches large AST dumps and Git artifacts.

## 3. Core Pipelines

### A. Repository Indexing Pipeline (Incremental by Design)
1. **Clone/Fetch:** Shallow clone + blobless clone for historical commits to save disk I/O.
2. **Sparse Parsing:** Only files modified in a commit (plus their direct dependents) are sent to the AST parser.
3. **Graph Delta Computation:** The parser outputs a `GraphDiff`. This diff is appended to the Graph Database's time-series ledger.

### B. AI Analysis Pipeline (Semantic Roll-up)
*Rule:* NEVER run a heavy LLM on every commit.
1. **Micro-Summarization:** A fast, cheap local model categorizes every commit (Bug, Feature, Chore) using rule-based heuristics and small embeddings.
2. **Macro-Summarization (The "Roll-up"):** Commits are grouped by Pull Request, branch, or time-window (e.g., weekly). The heavy LLM generates a narrative for the *group*, not the individual commits.

### C. Technical Debt & Regression Engine
1. **Heuristic Phase:** Computes cyclomatic complexity, fan-in/fan-out, and LOC natively without AI.
2. **Temporal Coupling:** Uses Git history to find "Ghost Edges" (files that change together but aren't statically linked).
3. **Decay Calculation:** Flags files with high churn, high complexity, and low recent authorship (The "Bus Factor" metric).

## 4. API & Data Access
- **GraphQL API:** Enables the frontend to execute complex time-slice queries (e.g., "Get the module graph as it existed on Commit X, along with the AI summary for that month").

## 5. Security & Observability
- **Tenant Isolation:** Row-level security (RLS) in PostgreSQL. Dedicated graph namespaces.
- **Observability:** OpenTelemetry tracking every stage of the AST and AI pipeline. 
- **Secret Scrubbing:** Pre-processing pipeline strictly drops `.env` files and uses regex to scrub tokens before ANY code hits the AI tier.

## 6. Frontend Architecture
- **Next.js (App Router):** Server-side rendering for dashboards.
- **WebGL / D3.js:** For rendering massive dependency graphs and Circle Packing visualizers smoothly at 60FPS.
- **State Management:** Zustand for local state, React Query for caching API responses.
