# Kanwas fork

Read `docs/SYSTEM_OVERVIEW.md` before changing collaboration or agent execution. This fork adds a local, single-owner ChatGPT plan mode; read `docs/CHATGPT_PLAN.md` before changing that path.

- Keep API-key and ChatGPT-plan credentials and billing explicit. Never silently fall back to API billing.
- Never read Codex credentials, commit OAuth credentials, log tokens, or send one owner's subscription requests for another Kanwas user.
- Use the official OpenAI sign-in and public Responses API contracts. Validate ID-token signatures, issuer, audience, nonce, scopes, and account binding. Keep token rotation atomic and local files owner-only.
- In subscription mode, consume streaming responses through successful completion. Exercise failure, partial-stream, refresh, and cancellation cases with offline fixtures.
- Use pnpm 10 as upstream CI does. Build `shared` before backend checks. Run `pnpm --filter backend test:chatgpt-plan`, backend typecheck, and lint changed backend files. The broader Japa suite requires disposable PostgreSQL and Redis; follow `backend/.env.test` and its database guard.
- Preserve canonical Yjs workspace state and existing tool execution behavior. A successful model response does not establish successful board synchronization.
- Keep the initial implementation local. Hosted Zite support and a live account test remain separate checks; describe unverified behavior clearly.
