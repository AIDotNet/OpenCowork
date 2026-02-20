"""
小红书搜索爬取脚本
自动搜索关键词并提取笔记图片
"""

import asyncio
import argparse
import os
import sys
from pathlib import Path
from playwright.async_api import async_playwright, Page


def get_default_chrome_user_data_dir():
    """获取 Windows 系统默认浏览器用户数据目录"""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    
    chrome_path = Path(local_app_data) / "Google" / "Chrome" / "User Data"
    if chrome_path.exists():
        return str(chrome_path)
    
    edge_path = Path(local_app_data) / "Microsoft" / "Edge" / "User Data"
    if edge_path.exists():
        return str(edge_path)
    
    return None


def show_login_notification():
    """显示登录提醒"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0,
            "检测到未登录状态\n\n请在浏览器中完成小红书登录，然后关闭浏览器窗口继续",
            "需要登录小红书",
            0x40 | 0x0
        )
    except Exception:
        print("\n" + "="*50)
        print("⚠️  请在浏览器中登录小红书...")
        print("="*50 + "\n")


async def check_login(page: Page, timeout=5000):
    """检查小红书登录状态 - 检查多个可能的登录指示器"""
    try:
        # 检查多种登录指示器（根据用户提供的HTML更新）
        selectors = [
            ".user.side-bar-component",                  # 用户头像导航项
            "a[href*='/user/profile']",                 # 个人主页链接
            "[src*='sns-avatar']",                      # 小红书头像图片
            "[class*='user']",                          # 包含 user 的类
            ".avatar",                                  # 头像
            "[class*='avatar']",                        # 包含 avatar 的类
            "img[src*='avatar']",                       # 头像图片
            ".user-nickname",                           # 用户名
            "text=创作中心",                            # 创作中心按钮
            "text=业务合作",                            # 业务合作按钮
            ".publish-btn",                             # 发布按钮
            ".global-nav"                               # 全局导航
        ]
        
        for selector in selectors:
            try:
                await page.wait_for_selector(selector, timeout=2000)
                print(f"✅ 检测到登录元素: {selector}")
                return True
            except:
                continue
        
        # 如果都没找到，尝试通过页面内容判断
        html = await page.content()
        login_indicators = ['退出登录', '个人主页', '创作中心', '业务合作', 'sns-avatar', '/user/profile/']
        for indicator in login_indicators:
            if indicator in html:
                print(f"✅ 通过页面内容检测到已登录: {indicator}")
                return True
            
        return False
    except:
        return False


async def wait_for_login(page: Page):
    """等待用户登录"""
    show_login_notification()
    print("⏳ 等待登录中...（最多 5 分钟）")
    print("💡 提示: 请确保在浏览器中完成登录，然后点击确定按钮继续")
    
    # 等待弹窗关闭后继续检测
    import time
    start_time = time.time()
    while time.time() - start_time < 300:
        if await check_login(page, timeout=3000):
            print("✅ 登录成功！")
            return True
        await asyncio.sleep(2)
    
    print("❌ 登录超时")
    return False


async def crawl_xiaohongshu(keyword: str, count: int = 20, save_dir: str = None):
    """爬取小红书搜索结果"""
    
    user_data_dir = get_default_chrome_user_data_dir()
    
    # 构建搜索 URL
    search_url = f"https://www.xiaohongshu.com/search_result?keyword={keyword}&type=51"
    
    async with async_playwright() as p:
        if user_data_dir:
            print(f"📁 使用系统浏览器")
            browser = await p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=False,
                args=["--disable-blink-features=AutomationControlled"]
            )
        else:
            print("⚠️ 未找到系统浏览器，使用临时配置")
            browser = await p.chromium.launch(headless=False)
        
        try:
            page = await browser.new_page()
            
            print(f"🔍 搜索: {keyword}")
            await page.goto(search_url, wait_until="networkidle", timeout=60000)
            
            # 等待加载
            await asyncio.sleep(3)
            
            # 检查登录
            is_logged_in = await check_login(page)
            if not is_logged_in:
                print("🔐 需要登录小红书")
                success = await wait_for_login(page)
                if not success:
                    raise Exception("未完成登录")
                await page.goto(search_url, wait_until="networkidle", timeout=60000)
                await asyncio.sleep(3)
            
            # 滚动加载更多
            print("📜 加载更多内容...")
            for _ in range(5):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(2)
            
            # 提取图片
            print("🖼️ 提取图片中...")
            
            # 小红书图片选择器 - 多种可能的选择器
            img_elements = await page.query_selector_all(
                '.note-item img, .cover-img img, .img img, [class*="cover"] img, .item img'
            )
            
            results = []
            for i, img in enumerate(img_elements[:count]):
                try:
                    src = await img.get_attribute('src')
                    if src and ('http' in src or '//' in src):
                        # 处理相对路径
                        if src.startswith('//'):
                            src = 'https:' + src
                        results.append(src)
                        print(f"  [{i+1}] {src[:80]}...")
                except Exception as e:
                    continue
            
            # 提取标题
            title_elements = await page.query_selector_all(
                '.note-item .title, .title-content, [class*="title"]'
            )
            titles = []
            for title in title_elements[:count]:
                try:
                    text = await title.inner_text()
                    if text:
                        titles.append(text.strip())
                except:
                    pass
            
            # 输出结果
            print(f"\n{'='*50}")
            print(f"📊 爬取结果: 共 {len(results)} 张图片")
            print(f"{'='*50}")
            
            # 保存到文件
            if save_dir:
                save_path = Path(save_dir)
                save_path.mkdir(parents=True, exist_ok=True)
                
                # 保存图片链接
                links_file = save_path / f"{keyword}_links.txt"
                with open(links_file, "w", encoding="utf-8") as f:
                    f.write(f"# 小红书搜索: {keyword}\n")
                    f.write(f"# 图片数量: {len(results)}\n\n")
                    for i, src in enumerate(results):
                        f.write(f"{i+1}. {src}\n")
                
                # 保存标题
                if titles:
                    titles_file = save_path / f"{keyword}_titles.txt"
                    with open(titles_file, "w", encoding="utf-8") as f:
                        f.write(f"# 小红书搜索: {keyword}\n\n")
                        for i, t in enumerate(titles):
                            f.write(f"{i+1}. {t}\n")
                
                print(f"💾 已保存链接到: {links_file}")
                print(f"💾 已保存标题到: {titles_file}")
            
            return results, titles
            
        finally:
            await browser.close()


def main():
    import json

    parser = argparse.ArgumentParser(description="小红书搜索爬取")
    parser.add_argument("keyword", help="搜索关键词")
    parser.add_argument("--count", type=int, default=20, help="爬取数量")
    parser.add_argument("--save", help="保存目录")

    args = parser.parse_args()

    results, titles = asyncio.run(crawl_xiaohongshu(
        keyword=args.keyword,
        count=args.count,
        save_dir=args.save
    ))

    # 输出结构化 JSON 供调用方解析
    output = {
        "keyword": args.keyword,
        "images": results,
        "titles": titles,
        "count": len(results)
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
