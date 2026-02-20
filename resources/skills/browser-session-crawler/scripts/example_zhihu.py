"""
知乎爬取示例
演示如何使用 browser-session-crawler 爬取需要登录的内容
"""

import asyncio
import json
from playwright.async_api import Page
import sys
import os

# 添加脚本目录到路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from crawl import crawl_with_session, get_default_chrome_user_data_dir


async def crawl_zhihu_feed(page: Page):
    """爬取知乎首页动态"""
    
    # 等待内容加载
    await page.wait_for_selector(".ContentItem", timeout=15000)
    
    # 获取内容项
    items = await page.query_selector_all(".ContentItem")
    
    results = []
    for item in items[:20]:  # 取前20条
        try:
            # 标题
            title_elem = await item.query_selector(".ContentItem-title")
            title = await title_elem.inner_text() if title_elem else ""
            
            # 摘要
            content_elem = await item.query_selector(".RichContent-inner")
            content = await content_elem.inner_text() if content_elem else ""
            
            # 作者
            author_elem = await item.query_selector(".AuthorInfo-name")
            author = await author_elem.inner_text() if author_elem else "匿名"
            
            if title:
                results.append({
                    "title": title.strip(),
                    "content": content.strip()[:200] + "..." if len(content) > 200 else content.strip(),
                    "author": author.strip()
                })
        except Exception as e:
            continue
    
    return results


async def main():
    print("="*50)
    print("🧪 知乎爬取示例")
    print("="*50)
    
    # 检查浏览器
    user_data_dir = get_default_chrome_user_data_dir()
    if user_data_dir:
        print(f"✅ 找到浏览器数据: {user_data_dir}")
    else:
        print("⚠️ 未找到浏览器数据")
    
    # 执行爬取
    result = await crawl_with_session(
        target_url="https://www.zhihu.com/",
        logged_in_indicator=".AppHeader-profile",  # 知乎登录后出现的元素
        crawl_function=crawl_zhihu_feed,
        # login_url="https://www.zhihu.com/signin",  # 可选：登录页
    )
    
    # 输出结构化 JSON 供调用方解析
    output = {
        "source": "zhihu",
        "items": result,
        "count": len(result)
    }
    print(json.dumps(output, ensure_ascii=False))

    return result


if __name__ == "__main__":
    asyncio.run(main())
