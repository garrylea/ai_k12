"""robots.py 的 TDD 测试。

基于 zgkao.com 实际 robots.txt 内容设计：
    User-agent: *
    Allow: /
    Disallow: /api/
    Sitemap: https://www.zgkao.com/sitemap.xml
"""

import pytest

from robots import RobotsChecker


ZGKAO_ROBOTS_TXT = (
    "User-agent: *\n"
    "Allow: /\n"
    "Disallow: /api/\n"
    "Sitemap: https://www.zgkao.com/sitemap.xml\n"
)


class TestIsAllowed:
    def test_allows_shitiku_path(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert checker.is_allowed("https://www.zgkao.com/shitiku/89047.html")

    def test_disallows_api_path(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert not checker.is_allowed("https://www.zgkao.com/api/some-endpoint")

    def test_allows_root_path(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert checker.is_allowed("https://www.zgkao.com/")

    def test_disallows_api_path_exactly(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert not checker.is_allowed("https://www.zgkao.com/api/")


class TestCrawlDelay:
    def test_returns_none_when_crawl_delay_absent(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert checker.get_crawl_delay() is None

    def test_returns_value_when_crawl_delay_present(self):
        content = (
            "User-agent: *\n"
            "Allow: /\n"
            "Crawl-delay: 5\n"
        )
        checker = RobotsChecker(content)
        assert checker.get_crawl_delay() == 5.0


class TestEdgeCases:
    def test_empty_robots_allows_all(self):
        checker = RobotsChecker("")
        assert checker.is_allowed("https://www.zgkao.com/anything")

    def test_sitemap_directive_does_not_break_parsing(self):
        checker = RobotsChecker(ZGKAO_ROBOTS_TXT)
        assert checker.is_allowed("https://www.zgkao.com/shitiku/89047.html")

    def test_specific_user_agent_uses_own_rules(self):
        content = (
            "User-agent: BadBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: *\n"
            "Allow: /\n"
        )
        checker = RobotsChecker(content, user_agent="BadBot")
        assert not checker.is_allowed("https://www.zgkao.com/anything")

    def test_wildcard_user_agent_ignores_other_rules(self):
        content = (
            "User-agent: BadBot\n"
            "Disallow: /\n"
            "\n"
            "User-agent: *\n"
            "Allow: /\n"
        )
        checker = RobotsChecker(content, user_agent="GoodBot")
        assert checker.is_allowed("https://www.zgkao.com/anything")
