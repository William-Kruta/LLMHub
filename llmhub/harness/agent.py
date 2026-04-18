import json
import logging
import re
import datetime
from typing import Optional, Union
from .providers.provider import Provider
from .memory.memory import Memory

logger = logging.getLogger(__name__)

_PLAN_PROMPT = """\
Given this research question: "{query}"
If relevant, here is the current date: {date}
Generate 3-5 specific search queries that would help answer it thoroughly.
Respond ONLY in JSON: {{"queries": ["query1", "query2", ...]}}"""

_ANALYSIS_PROMPT = """\
Research question: "{query}"

Here is everything gathered so far:
{accumulated}

Do two things:
1. Synthesize the key findings so far. Be critical — note contradictions, weak sources, and gaps.
2. Decide: is the research sufficient to answer the question well?

Respond ONLY in JSON:
{{
    "analysis": "your synthesis here",
    "sufficient": true/false,
    "gaps": ["gap1", "gap2"],
    "next_queries": ["query1", "query2"]
}}

If sufficient is true, next_queries can be empty."""

_REPORT_PROMPT = """\
Research question: "{query}"

Accumulated research:
{accumulated}

Final analysis notes:
{analysis}

Write a comprehensive, critical answer to the research question.
Cite specifics from the research. Flag anything uncertain."""


def _extract_json(text: str) -> dict | list:
    """Try to parse JSON from text that may include markdown fences or preamble."""
    # Direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Strip markdown code fences
    stripped = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Find first { ... } or [ ... ] block
    for start_char, end_char in [('{', '}'), ('[', ']')]:
        start = text.find(start_char)
        end = text.rfind(end_char)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise json.JSONDecodeError("No JSON found", text, 0)


class Agent:
    def __init__(
        self,
        provider: Provider,
        tool_map: Optional[Union[dict, list]] = None,
        memory: Optional[Memory] = None,
        soul_md_path: Optional[str] = None,
    ):
        self.provider = provider
        self.memory = memory

        if soul_md_path is None:
            self.system_prompt = "You are a helpful assistant with access to tools."
        else:
            with open(soul_md_path, "r") as f:
                self.system_prompt = f.read()

        if isinstance(tool_map, list):
            self.tool_map = {k: v for d in tool_map for k, v in d.items()}
        elif isinstance(tool_map, dict):
            self.tool_map = tool_map
        else:
            self.tool_map = None

        if self.tool_map is not None:
            self.tools = [
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": func.description,
                        "parameters": func.args_schema.model_json_schema(),
                    },
                }
                for name, func in self.tool_map.items()
            ]
        else:
            self.tools = None

    def run(self, user_input: str, model: str = None, max_tokens: int = 2048) -> str:
        """
        Run the agent with optional conversation memory.
        If memory is attached, previous messages are included automatically.
        """
        if self.memory is not None:
            self.memory.add("user", user_input)
            messages = [
                {"role": "system", "content": self.system_prompt},
                *self.memory.get_history(),
            ]
        else:
            messages = [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_input},
            ]

        response = self.provider.chat(
            messages, tools=self.tools, tool_map=self.tool_map, model=model, max_tokens=max_tokens
        )

        if self.memory is not None:
            self.memory.add("assistant", response)

        return response

    def research(
        self,
        query: str,
        max_rounds: int = 3,
        model: str = None,
        analysis_tokens: int = 2048,
        planning_tokens: int = 1024,
        report_tokens: int = 8000,
        debug: bool = True,
    ) -> str:
        """Multi-round research pipeline."""
        if debug:
            logger.info("Phase 1: Planning...")
        queries = self._plan_queries(query, model, planning_tokens)

        all_findings = []
        analysis = {"analysis": "", "sufficient": False, "next_queries": queries}

        for _ in range(max_rounds):
            if debug:
                logger.info("Phase 2: Gathering data...")
            accumulated = self._gather_round(queries, all_findings)

            if debug:
                logger.info("Phase 3: Analyzing...")
            analysis = self._analyze(query, accumulated, model, analysis_tokens)

            if debug:
                logger.info("Phase 4: Deciding...")
            if analysis.get("sufficient") or not analysis.get("next_queries"):
                break
            queries = analysis["next_queries"]

        if debug:
            logger.info("Phase 5: Finalizing...")
        return self._write_report(query, accumulated, analysis["analysis"], model, report_tokens)

    def _plan_queries(self, query: str, model: Optional[str], max_tokens: int) -> list[str]:
        prompt = _PLAN_PROMPT.format(
            query=query,
            date=datetime.datetime.now().strftime("%Y-%m-%d"),
        )
        response = self.provider.chat(
            [{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}],
            model=model,
            max_tokens=max_tokens,
            tools=self.tools,
            tool_map=self.tool_map,
            response_format={"type": "json_object"},
        )
        try:
            return _extract_json(response).get("queries", [query])
        except json.JSONDecodeError:
            logger.warning("Failed to parse planning response as JSON; using original query.")
            return [query]

    def _gather_round(self, queries: list[str], all_findings: list[str]) -> str:
        round_results = []
        for q in queries:
            result = self.tool_map["web_search"].invoke({"query": q})
            round_results.append(f"Query: {q}\n{result}")
        all_findings.append("\n\n---\n\n".join(round_results))
        return "\n\n===ROUND===\n\n".join(all_findings)

    def _analyze(self, query: str, accumulated: str, model: Optional[str], max_tokens: int) -> dict:
        prompt = _ANALYSIS_PROMPT.format(query=query, accumulated=accumulated)
        response = self.provider.chat(
            [{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}],
            model=model,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        try:
            return _extract_json(response)
        except json.JSONDecodeError:
            logger.warning("Failed to parse analysis response as JSON.")
            return {"sufficient": False, "analysis": response, "next_queries": [query]}

    def _write_report(
        self,
        query: str,
        accumulated: str,
        analysis_notes: str,
        model: Optional[str],
        max_tokens: int,
    ) -> str:
        prompt = _REPORT_PROMPT.format(
            query=query,
            accumulated=accumulated,
            analysis=analysis_notes,
        )
        return self.provider.chat(
            [{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}],
            model=model,
            max_tokens=max_tokens,
        )
