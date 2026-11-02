"""Entry point for LLM Hub."""

import os

import uvicorn


def main():
    port = int(os.environ.get("LLMHUB_PORT", "8005"))
    # Reloading restarts the app, which stops every managed llama-server, so it is opt-in.
    reload = os.environ.get("LLMHUB_RELOAD", "").lower() in {"1", "true", "yes"}
    uvicorn.run("llmhub.server:app", host="127.0.0.1", port=port, reload=reload)


if __name__ == "__main__":
    main()
