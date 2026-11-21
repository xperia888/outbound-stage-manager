# Project AI Coding Guidelines

## 1. Core Workflow & Behavior
- **Clarify Before Coding:** If requirements are ambiguous, ask brief clarifying questions before generating large changes.
- **Simplicity First:** Write clean, modular, and readable code. Avoid over-engineering or introducing unnecessary abstractions.
- **Minimal Diffs:** Only modify files directly relevant to the task. Do not refactor unrelated code unless explicitly asked.

## 2. Tech Stack & Conventions
- **Language:** TypeScript (strict mode enabled; avoid `any`).
- **Formatting & Linting:** Follow existing ESLint and Prettier configurations.
- **Naming:** Use `camelCase` for variables/functions, `PascalCase` for components/classes, and `kebab-case` for file names.

## 3. Architecture & Error Handling
- Keep controllers/routes thin; move business logic into dedicated service functions.
- Always handle errors explicitly using `try/catch` or structured error boundaries. Never swallow exceptions silently.
- Validate and sanitize all external inputs and API payloads at the boundary.

## 4. Security Rules
- **No Hardcoded Secrets:** Never commit API keys, tokens, passwords, or `.env` values. Use environment variables.
- Preserve existing authentication and authorization checks on all endpoints.

## 5. Git & Testing
- **Git Safety:** Do not run `git commit`, `git push`, or create branches unless explicitly instructed in the prompt. Leave changes in the working tree for review.
- **Testing:** Write unit tests for any new business logic or bug fixes before considering a task complete.

