"""真实网络烟雾测试。默认跳过，运行：pytest -m network"""

import pytest


pytestmark = pytest.mark.network


@pytest.mark.network
def test_smartedu_tag_json_accessible():
    """验证 tag JSON 可下载并包含 zxxxk 维度。"""
    from core.fetcher import Fetcher
    import json

    fetcher = Fetcher(crawl_delay=0)
    text = fetcher.fetch_text(
        "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/tags/tch_material_tag.json"
    )
    data = json.loads(text)
    assert "zxxxk" in data
    assert len(data["zxxxk"]) > 0
