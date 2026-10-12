# Local ChatGPT plan mode

This fork adds an experimental local OAuth provider for the ChatGPT subscription route. It preserves Kanwas's existing canvas and agent. It is intended for one explicitly bound Kanwas user on macOS or Linux. Live sign-in, account entitlement, and a complete board edit have not yet been verified.

## Set up the fork

Use Node 22 or newer and pnpm 10.11.0, matching the pinned package manager and upstream CI's major version:

```sh
pnpm install --frozen-lockfile
pnpm --filter shared build
pnpm --filter backend test:chatgpt-plan
pnpm --filter backend typecheck
pnpm --filter backend typecheck:chatgpt-plan
```

Kanwas still needs its normal local backend, database, Redis, Yjs server, frontend, and execution sandbox. See [system overview](SYSTEM_OVERVIEW.md) and the existing Docker compose setup. The OpenAI subscription does not provide those services or pay for other vendors such as Composio or Parallel.

## Authorize the local app

To test just sign-in on macOS, double-click `try_chatgpt_signin.command` in Finder, or run it from Terminal. It opens the system browser with a fresh authorization attempt and keeps the callback listener alive for five minutes. This isolated test uses the local owner label `local-signin-test` and ignored credentials under `.chatgpt-plan/signin-test`; it does not require Docker or start the canvas. Run it only after installing the dependencies. A regular browser is the documented OAuth route; embedded-browser sign-in has not worked in the live test here.

For the complete app, use the real Kanwas user ID and the separate commands below.

Get the ID of the Kanwas user that will own this connection from the local app/database. It is a Kanwas ID, not your OpenAI email or account ID.

```sh
pnpm --filter backend chatgpt:signin --user-id YOUR_KANWAS_USER_ID
pnpm --filter backend chatgpt:status
pnpm --filter backend chatgpt:models --user-id YOUR_KANWAS_USER_ID
```

The sign-in command provides a URL for your system browser and starts a callback listener on `127.0.0.1`. You complete the sign-in and review the requested ChatGPT plan permission yourself. It creates a new Kanwas authorization; it does not reuse Codex credentials. Token files are protected locally under `~/.config/kanwas/chatgpt-plan` by default. Keep them in private, ignored local storage; never track or commit them, share them, or paste them into an API-key field.

Pick a model slug returned by `chatgpt:models`, then explicitly test access:

```sh
pnpm --filter backend chatgpt:probe --user-id YOUR_KANWAS_USER_ID --model MODEL_SLUG
```

The probe sends a small text request using the authorized subscription. A listed model alone does not prove access; the request must finish successfully. Usage limits still apply.

## Enable it in Kanwas

Set these in your local `backend/.env`:

```dotenv
OPENAI_AUTH_MODE=chatgpt-plan
CHATGPT_PLAN_USER_ID=YOUR_KANWAS_USER_ID
CHATGPT_PLAN_MODEL=MODEL_SLUG
OPENAI_API_KEY=
OPENAI_BASE_URL=
```

Keep the user's provider selection as OpenAI. An existing per-user model override takes precedence over `CHATGPT_PLAN_MODEL`; clear it or choose a model returned by the catalog. Start/restart the backend after changing its configuration. The bootstrap provider cannot perform inference until rebound to the authenticated Kanwas actor. Other users are refused in this initial mode, even if they can view the board.

`KANWAS_CHATGPT_AUTH_DIR` optionally selects an absolute private credential directory. A container backend needs an owner-only mount of that directory with matching user ownership. Run the sign-in CLI on the host so the browser can reach its loopback listener. Mounting credentials does not establish that a hosted deployment is supported.

## Behavior and limits

- No automatic API-key fallback, including authorization, quota, and provider-selection errors.
- Tokens refresh before requests, with refresh and disconnect serialized and credential rotation atomic.
- Only the official public Responses endpoint is used. Requests stream with `store: false`; all needed history is sent again.
- Unsupported tuning/cache fields are omitted. Unsupported state or tool forms fail with an explicit error.
- Local function tools use the documented `additional_tools` input form; hosted tool support is limited by OpenAI's preview contract.
- Failed, incomplete, aborted, or truncated streams cannot count as a successful response.
- A tool may already have changed the board before a later stream fails. Failure handling does not roll back those edits; verify the board before retrying a side effect.
- Existing task title, summary, structured-output, repair, and subagent paths carry the same auth mode/user checks.
- This connection grants inference permission. It does not import your ChatGPT chats or memories.
- Existing Kanwas cost estimates and organization caps are app accounting, not proof of a separately billed API charge or your remaining subscription allowance.

To disconnect:

```sh
pnpm --filter backend chatgpt:disconnect --user-id YOUR_KANWAS_USER_ID
```

The command removes local tokens and reports whether remote revocation was confirmed. Revoke the authorization in your ChatGPT account as well if remote revocation could not be completed. The stable host identity and registration metadata may remain for reauthorization.

If an interrupted process leaves the session busy, run `pnpm --filter backend chatgpt:recover-lock`. Recovery only removes a lock whose recorded process is confirmed stopped; live or unknown owners are refused. It does not expire a lock merely because it is old.

## Validation status

Offline checks cover authorization validation, actor binding, request transformation, real SDK streaming fixtures, tool calls, token refresh, and terminal failures. They do not establish live account eligibility or successful Yjs board synchronization. The next acceptance check is a live sign-in and probe, followed by one board document edit, follow-up turn, refresh, and cancellation.

Official references: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), and [local/hosted scope](https://developers.openai.com/siwc/token-sharing-open-source).
