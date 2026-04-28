"""Entry point for LLM Hub."""

import uvicorn


def main():
    uvicorn.run("llmhub.server:app", host="127.0.0.1", port=8005, reload=True)


if __name__ == "__main__":
    main()
