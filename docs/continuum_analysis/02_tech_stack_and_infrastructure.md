# Continuum OS: Tech Stack & Infrastructure

This document breaks down the specific languages, frameworks, libraries, and infrastructure components utilized across the Continuum ecosystem.

## 1. Infrastructure (Dockerized)
The core infrastructure is orchestrated via Docker Compose, designed for local execution but structured for modular cloud deployment.
*   **Relational Database:** `PostgreSQL 15` — Stores user profiles, enterprise SSO states, repository metadata, and persistent application state.
*   **Vector Database:** `Qdrant` — Handles the storage and rapid similarity search of code embeddings required for the Retrieval-Augmented Generation (RAG) pipeline.
*   **Message Broker / Cache:** `Redis 7` — Used for caching LLM responses, managing token budgets across sessions, and handling background worker queues.

## 2. The Client (Frontend & BFF)
Built on a modern React ecosystem, focusing heavily on a polished, cinematic user experience.
*   **Core Framework:** `Next.js 16.2.x` (App Router) & `React 19`.
*   **Language:** TypeScript.
*   **Styling:** Tailwind CSS v4, utilizing heavily customized CSS variables for a "dark mode command surface" aesthetic.
*   **3D / Visualizations:** `@react-three/fiber`, `@react-three/drei`, `three.js`, and `@react-three/postprocessing` (for cinematic landing pages and potential spatial data representation).
*   **Animation:** `framer-motion` (UI transitions), `gsap` (scroll and cinematic sequencing), and `lenis` (smooth scrolling).
*   **Database ORM:** `Prisma` (@prisma/client) for connecting to PostgreSQL.
*   **Job Queues:** `bullmq` (backed by Redis) for managing background UI tasks.
*   **Authentication:** `next-auth` (configured for GitHub OAuth and email fallback).

## 3. The Engine (Backend AI Service)
A heavy-duty Python service optimized for handling LLM context, RAG, and asynchronous processing.
*   **Core Framework:** `FastAPI` (running on `uvicorn`).
*   **Language:** Python 3.10+.
*   **Data Validation:** `pydantic` & `pydantic-settings`.
*   **AI / LLM Orchestration:** `langchain`, `langchain-text-splitters`.
*   **LLM Providers:** `openai` (GPT models) and `google-genai` (Gemini models).
*   **Embeddings (Local):** `sentence-transformers` for generating vector embeddings of code chunks locally to save API costs.
*   **Vector DB Client:** `qdrant-client`.
*   **Repository Operations:** `GitPython` (for cloning and manipulating local git trees).
*   **Database Client:** `asyncpg` (Asynchronous Postgres access).
*   **Sandbox / Execution:** `docker` (Python client for spinning up isolated containers to safely execute generated code or tests).

## 4. The Terminal (CLI)
A lightweight, dependency-injected Node.js application.
*   **Runtime:** Node.js (executed via `tsx`).
*   **Language:** TypeScript.
*   **Architecture:** Custom Read-Eval-Print Loop (REPL) using standard input/output streams, avoiding heavy CLI frameworks in favor of a bespoke dependency-injection model.
*   **Testing:** `vitest`.

## 5. Security & Operational Posture
Based on the project audit, the current stack implementation has critical security and operational gaps:
*   **Secret Management:** Relies on hard-coded fallback secrets (e.g., in `client/server/lib/encryption.ts`), posing a severe risk if environment variables are missing.
*   **Network Security:** The FastAPI engine runs with highly permissive CORS (`allow_origins=["*"]`) and relies entirely on local network placement (localhost) rather than explicit API authentication boundaries (like HMAC or internal service tokens).
*   **Testing:** Minimal to no automated test harness exists (1/10 rating in the project audit), making the stack brittle to refactors.