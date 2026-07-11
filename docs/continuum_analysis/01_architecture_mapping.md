# Continuum OS: Architecture Mapping

## 1. High-Level System Design
Continuum is designed as an autonomous engineering workspace, split into a clear two-tier architecture: a **TypeScript/Next.js Client (Product Shell)** and a **Python Analysis Engine (AI/RAG Backend)**, supported by a standalone **Node.js Terminal Interface**.

### 1.1 The Client (Next.js)
The frontend serves as the primary "command surface" for the engineering team.
*   **Responsibilities:** Authentication (Enterprise SSO/GitHub), UI presentation, dashboard rendering, repository import flows, and the interactive workspace UI.
*   **Design Pattern:** A React-based monolithic frontend leveraging server-side rendering (SSR) and API routes for immediate backend communication (Prisma -> Postgres).
*   **Weaknesses Found:** High reliance on large, single-purpose client components with duplicated data-shaping logic. Many placeholder flows (especially in the workspace UI) rather than fully integrated behavior.

### 1.2 The Engine (Python / FastAPI)
The heavy-lifting backend that powers the AI, orchestration, and repository analysis.
*   **Responsibilities:** Repository cloning, code chunking, generating embeddings, indexing into the Vector DB, running the Agent Orchestrator, executing RAG retrieval, and managing sandbox operations.
*   **Design Pattern:** A modular, service-oriented architecture. It uses an `Orchestrator` to manage specialized agents (Security, Bug, Architecture, Docs, Dependency) and an `ActionEngine` to aggregate agent findings into actionable plans.
*   **Strengths:** Highly coherent subsystem. Excellent architectural direction utilizing shared retrieval, token budgeting, static pre-analysis, and caching to avoid "agent sprawl" and reduce LLM costs.

### 1.3 The Terminal (Node.js / TypeScript)
A standalone CLI tool providing a keyboard-driven coding assistant session.
*   **Responsibilities:** Chatting about a repository, running analysis agents directly from the command line, and providing real-time status streams.
*   **Design Pattern:** A custom Read-Eval-Print Loop (REPL) built with pure dependency injection (no global state), ensuring high testability. It communicates with the Python engine over authenticated HTTP (`EngineClient`).

---

## 2. Component Communication & Integration
*   **Client <-> Engine:** The Next.js API routes communicate with the Python Engine via HTTP REST calls. 
    *   *Critical Technical Debt:* The codebase currently hard-codes `http://localhost:8000` in multiple client and server routes, creating a brittle deployment posture. It lacks a centralized service client or deployment-aware configuration layer.
*   **Client <-> Database:** The Next.js server utilizes Prisma ORM to interact directly with the PostgreSQL database for user state, session management, and relational repository metadata.
*   **Engine <-> Infrastructure:** The Python engine communicates with Qdrant (via HTTP/gRPC) for vector search, Redis for caching and background job queuing, and PostgreSQL (via `asyncpg`) for relational data.
*   **Terminal <-> Engine:** The CLI interacts exclusively with the Python engine via an `EngineClient` class over HTTP, maintaining its own session history locally.

## 3. Data Flow Example: Repository Ingestion
1.  **Trigger:** User initiates an import via the Client UI.
2.  **Validation (Flawed):** The Client sends repository metadata to the Next.js server. *(Note: The current architecture trusts this client payload too much, creating a security risk. It should re-validate via GitHub).*
3.  **Hand-off:** The Next.js server queues a job (via Redis/BullMQ) or calls the Engine directly.
4.  **Ingestion (Engine):** The Engine uses `GitPython` to clone the repository to a local storage path (`/tmp/continuum-repos`).
5.  **Processing (Engine):** The code is parsed, chunked, and embedded using `sentence-transformers` or remote embedding APIs.
6.  **Indexing (Qdrant):** Embeddings are stored in the Qdrant vector database.
7.  **Completion:** Status is updated in Postgres, and the Client UI polls (currently a hard-coded 5-second interval) to update the dashboard.