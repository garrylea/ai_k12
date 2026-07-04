"""robots.txt 解析器。

按 RFC 9309 实现"最长匹配优先"规则，不依赖 urllib.robotparser
（标准库实现为先匹配优先，与 RFC 不一致）。

按 user-agent 分组解析：若请求的 UA 有自己的规则组，则仅使用该组规则；
否则回退到通配组 `*`。每次运行重新解析传入的内容，不做本地缓存。
"""

from typing import Optional
from urllib.parse import urlsplit


class _Rule:
    __slots__ = ("allow", "path")

    def __init__(self, allow: bool, path: str) -> None:
        self.allow = allow
        self.path = path


class RobotsChecker:
    def __init__(self, content: str, user_agent: str = "*") -> None:
        self._user_agent = user_agent.lower()
        self._rules: list[_Rule] = []
        self._crawl_delay: Optional[float] = None
        self._parse(content)

    def _parse(self, content: str) -> None:
        groups: dict[str, list[_Rule]] = {}
        crawl_delays: dict[str, float] = {}
        current_agents: list[str] = []
        for raw_line in content.splitlines():
            line = raw_line.split("#", 1)[0].strip()
            if not line:
                current_agents = []
                continue
            if ":" not in line:
                continue
            field, _, value = line.partition(":")
            field = field.strip().lower()
            value = value.strip()
            if field == "user-agent":
                current_agents.append(value.lower())
            elif field == "allow":
                self._add_rule(groups, current_agents, _Rule(allow=True, path=value))
            elif field == "disallow":
                self._add_rule(groups, current_agents, _Rule(allow=False, path=value))
            elif field == "crawl-delay":
                try:
                    delay = float(value)
                except ValueError:
                    continue
                for agent in current_agents:
                    crawl_delays[agent] = delay

        self._rules = self._select_group(groups)
        if self._user_agent in crawl_delays:
            self._crawl_delay = crawl_delays[self._user_agent]
        elif "*" in crawl_delays:
            self._crawl_delay = crawl_delays["*"]

    @staticmethod
    def _add_rule(
        groups: dict[str, list[_Rule]], agents: list[str], rule: _Rule
    ) -> None:
        for agent in agents:
            groups.setdefault(agent, []).append(rule)

    def _select_group(self, groups: dict[str, list[_Rule]]) -> list[_Rule]:
        if self._user_agent in groups:
            return groups[self._user_agent]
        return groups.get("*", [])

    def is_allowed(self, url: str) -> bool:
        path = urlsplit(url).path or "/"
        longest_len = -1
        longest_allow = True
        for rule in self._rules:
            if path.startswith(rule.path):
                if len(rule.path) > longest_len:
                    longest_len = len(rule.path)
                    longest_allow = rule.allow
                elif len(rule.path) == longest_len and rule.allow:
                    longest_allow = True
        if longest_len < 0:
            return True
        return longest_allow

    def get_crawl_delay(self) -> Optional[float]:
        return self._crawl_delay
