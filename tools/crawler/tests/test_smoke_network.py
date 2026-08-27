"""真实网络烟雾测试。默认跳过，运行：pytest -m network"""

import json

import pytest


pytestmark = pytest.mark.network

TAG_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/tags/tch_material_tag.json"
VERSION_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/version/data_version.json"

# 主流程依赖的 5 个维度 id（_extract_tags 对象格式分支按 tag_dimension_id 提取）
_EXPECTED_DIMENSIONS = {"zxxxd", "zxxxk", "zxxbb", "zxxnj", "zxxcc"}


@pytest.mark.network
def test_smartedu_upstream_accessible():
    """烟雾测试：上游数据源可访问且主流程依赖的结构未漂移。

    - tag JSON 可下载且能解析（2026-08 起顶层结构为 {tag_path, hierarchies, ext, tenant_id}，
      旧的扁平维度键已废弃；主流程的对象格式 tag_list 不依赖它）。
    - version JSON 可下载并列出分片 URL。
    - 第一个分片可下载，tag_list 仍是对象格式且包含 5 个维度 id
      （主流程 _extract_tags 的对象格式分支依赖）。
    """
    from core.fetcher import Fetcher

    fetcher = Fetcher(crawl_delay=0)

    tag_data = json.loads(fetcher.fetch_text(TAG_URL))
    assert "hierarchies" in tag_data, (
        f"tag JSON 顶层结构又变了: {sorted(tag_data.keys())}（当前代码仅要求能解析）")

    version_data = json.loads(fetcher.fetch_text(VERSION_URL))
    part_urls = [u.strip() for u in version_data.get("urls", "").split(",") if u.strip()]
    assert part_urls, f"version JSON 未列出分片 URL: {sorted(version_data.keys())}"

    part = json.loads(fetcher.fetch_text(part_urls[0]))
    assert isinstance(part, list) and part, "分片不再是非空数组"
    tag_list = part[0].get("tag_list", [])
    assert tag_list and isinstance(tag_list[0], dict), (
        f"tag_list 不再是对象格式（主流程 _extract_tags 会失效）: {type(tag_list[0])}")
    dims = {entry.get("tag_dimension_id", "") for entry in tag_list}
    missing = _EXPECTED_DIMENSIONS - dims
    assert not missing, f"分片 tag_list 缺少维度 id: {missing}"
