"""Entry point for LLM Hub."""

import uvicorn


def main():
    uvicorn.run("llmhub.server:app", host="0.0.0.0", port=8005, reload=True)


if __name__ == "__main__":
    main()
