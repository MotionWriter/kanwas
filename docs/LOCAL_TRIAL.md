# Try the local Kanwas canvas

This launcher prepares a local canvas with ChatGPT subscription access. The previous `try_chatgpt_signin.command` verified authorization only. This trial connects a real Kanwas account and runs the application services.

## First launch

1. [Install Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) and open it. Wait until its engine is running.
2. Run `start_kanwas.command` in Terminal from this checkout. Node 22+ and installed repository dependencies are required; they are already present in the current local checkout.
3. When the launcher prompts, open [the local registration page](http://localhost:15173/register) in your regular browser. Create a local Kanwas account with a name, email, and password.
4. Return to Terminal, press Return, and enter that local account's email. Complete the new ChatGPT authorization in your regular browser. This binds the connection to your actual Kanwas user; the earlier isolated test connection is kept separate.
5. Wait for `Kanwas is ready`, then refresh [the local app](http://localhost:15173). Keep the Terminal window open while using it.

From the checkout's root:

```sh
./start_kanwas.command
```

Install dependencies first with the pinned pnpm 10.11.0 if this is a fresh checkout.

## What to try

Create a document on the canvas and put a short project brief in it. Ask the agent: “Create a second document with three next steps based on this brief.” Confirm that its new document appears and remains after refreshing the page. A first agent turn may need extra time to build its Docker execution image.

The trial supports canvas/documents and the subscription provider. External integrations and web search/extraction are disabled in this launcher. Your proposed Drive/Dropbox thumbnails and linked Slack conversations still require additional product/integration work.

## Restart and stop

Run the same command for later sessions. Your local account, board data, and owner binding persist. Press Ctrl+C in the launcher Terminal to stop the host services. To stop its PostgreSQL/Redis containers too, run the command with `--stop-infra`; it retains data volumes. Use `--reconnect` after stopping a session if ChatGPT authorization needs renewal.

`--check` checks dependencies and Docker without creating trial settings or opening sign-in. `--serve-only` starts the app for registration before subscription connection; agent access remains disabled until a real owner is authorized. The launcher uses Docker Desktop's local `desktop-linux` context. If a crashed process leaves `.local-trial/launcher.lock`, its contents are a process ID. Verify that process has stopped before removing that lock; do not remove a live launcher's lock.

## Local storage and configuration

The launcher uses its own `kanwas-local-trial` Compose project: PostgreSQL at `127.0.0.1:55432` and Redis at `127.0.0.1:56379`, with named data volumes. The PostgreSQL 18 mount uses `/var/lib/postgresql`. Backend/frontend/Yjs run on the host at ports 3333/15173/1999. Backend and Yjs listen on host interfaces so the Docker execution sandbox can reach them.

Private generated settings, matching backend/Yjs secrets, the actual user binding, and OAuth credentials live under the ignored `.local-trial/` directory. Preserve that directory and the Docker volumes if you need your existing trial data. It does not change the checkout's existing `.env` files. Backend dotenv loading is redirected to a private directory; Yjs receives explicit environment values. Vite still loads its normal dotenv files, with this trial's API/socket/token settings overridden by the launcher.

The explicit `KANWAS_LOCAL_TRIAL=true` mode permits missing Composio/Parallel configuration in development and tests. It is refused in production. The subscription still requires a bound owner and visible model; no API-key fallback is enabled. To add integrations later, use the regular configuration guide rather than this trial launcher, which deliberately clears third-party keys.

## Verification limits

Live ChatGPT authorization, account model listing, production-provider text inference, and a follow-up conversation are verified. All 78 targeted offline tests pass. Docker Desktop is installed and its local engine is running. PostgreSQL/Redis health checks, database migrations, backend/Yjs health endpoints, frontend startup, and the rendered registration page passed in the live trial. Actual-owner authorization, execution-image behavior, and a persisted agent board action remain pending.
