# Try the local Kanwas canvas

This launcher prepares a local canvas with ChatGPT subscription access. The previous `try_chatgpt_signin.command` verified authorization only. This trial creates its internal local identity automatically and runs the application services. You do not register, enter an email, choose a password, or create a hosted Kanwas account.

## First launch

1. [Install Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) and open it. Wait until its engine is running.
2. Run `start_kanwas.command` in Terminal from this checkout. Node 22+ and installed repository dependencies are required; they are already present in the current local checkout.
3. The launcher creates or reuses your private local workspace and opens the canvas directly in your regular browser.
4. If the earlier sign-in test already granted plan access, that same protected connection is explicitly bound to this local identity. It is not copied into another credential profile. On a fresh checkout, complete ChatGPT authorization in your regular browser; only the OpenAI account needs a sign-in.
5. Keep the Terminal window open while using the canvas.

From the checkout's root:

```sh
./start_kanwas.command
```

Install dependencies first with the pinned pnpm 10.11.0 if this is a fresh checkout.

## What to try

Create a document on the canvas and put a short project brief in it. Ask the agent: “Create a second document with three next steps based on this brief.” Confirm that its new document appears and remains after refreshing the page. A first agent turn may need extra time to build its Docker execution image.

The trial supports canvas/documents and the subscription provider. External integrations and web search/extraction are disabled in this launcher. Your proposed Drive/Dropbox thumbnails and linked Slack conversations still require additional product/integration work.

## Restart and stop

Run the same command for later sessions. Your automatic local identity, board data, and owner binding persist. Press Ctrl+C in the launcher Terminal to stop the host services. To stop its PostgreSQL/Redis containers too, run the command with `--stop-infra`; it retains data volumes. Use `--reconnect` after stopping a session if ChatGPT authorization needs renewal.

`--check` checks dependencies and Docker without creating trial settings or opening sign-in. `--serve-only` opens the canvas without requesting new ChatGPT authorization. `--no-browser` prepares a private browser handoff for development tooling while suppressing browser opening; it still verifies an existing ChatGPT connection. The launcher uses Docker Desktop's local `desktop-linux` context. If a crashed process leaves `.local-trial/launcher.lock`, its contents are a process ID. Verify that process has stopped before removing that lock; do not remove a live launcher's lock.

## Local storage and configuration

The launcher uses its own `kanwas-local-trial` Compose project: PostgreSQL at `127.0.0.1:55432` and Redis at `127.0.0.1:56379`, with named data volumes. The PostgreSQL 18 mount uses `/var/lib/postgresql`. Backend/frontend/Yjs run on the host at ports 3333/15173/1999. Backend and Yjs listen on host interfaces so the Docker execution sandbox can reach them.

Private generated settings, matching backend/Yjs secrets, and the internal identity live under the ignored `.local-trial/` directory. OAuth credentials remain in the ignored `.chatgpt-plan/signin-test/` profile; this avoids duplicate rotating credentials. Preserve both directories. Preserve that directory and the Docker volumes if you need your existing trial data. It does not change the checkout's existing `.env` files. Backend dotenv loading is redirected to a private directory; Yjs receives explicit environment values. Vite still loads its normal dotenv files, with this trial's API/socket/token settings overridden by the launcher.

Each launch issues separate one-use passes for local workspace setup and browser session handoff. The browser pass travels in a URL fragment and is removed before app initialization, then exchanged for the ordinary app session. The guarded endpoints accept only loopback requests with an allowed local origin in development trial mode; normal authentication and workspace access checks remain in place. No OAuth credentials are sent to the frontend. Frontend and backend PostHog analytics are disabled for this local trial; the backend does not construct an analytics client or wrap inference with tracing.

The explicit `KANWAS_LOCAL_TRIAL=true` mode permits missing Composio/Parallel configuration in development and tests. It is refused in production. The subscription still requires a bound owner and visible model; no API-key fallback is enabled. To add integrations later, use the regular configuration guide rather than this trial launcher, which deliberately clears third-party keys.

## Verification limits

Live ChatGPT authorization, account model listing, production-provider text inference, and a follow-up conversation are verified. 119 targeted offline tests pass across the backend, launcher, and frontend suites; typechecks and changed-file lint pass. Docker Desktop is installed and its local engine is running. PostgreSQL/Redis health checks, database migrations, backend/Yjs health endpoints, frontend startup, and the rendered registration page passed in the live trial. Automatic workspace creation, exact-owner adoption of the existing grant, direct browser canvas entry, and a manually created document persisting after refresh have passed live checks. The Docker sandbox became ready, the subscription agent created trial-next-steps.md, and that document persisted after refresh. A same-task follow-up added a fourth bullet, and the edit also persisted after refresh. The broader database integration suite was not run.
