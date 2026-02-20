"""
Browser Session Crawler - 通用爬取模块
使用系统浏览器登录状态进行爬取
"""

import asyncio
import argparse
import os
import sys
import json
from pathlib import Path
from typing import Optional, Callable, Any
from playwright.async_api import async_playwright, Page, BrowserContext


def get_default_chrome_user_data_dir() -> Optional[str]:
    """获取 Windows 系统默认浏览器用户数据目录"""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    
    # 尝试 Chrome
    chrome_path = Path(local_app_data) / "Google" / "Chrome" / "User Data"
    if chrome_path.exists():
        return str(chrome_path)
    
    # 尝试 Edge
    edge_path = Path(local_app_data) / "Microsoft" / "Edge" / "User Data"
    if edge_path.exists():
        return str(edge_path)
    
    return None


def show_login_notification():
    """显示 Windows 登录提醒弹窗"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0,
            "检测到未登录状态\n\n请在浏览器中完成登录，然后关闭此窗口继续",
            "需要登录",
            0x40 | 0x0
        )
    except Exception:
        print("\n" + "="*50)
        print("⚠️  请在浏览器中完成登录...")
        print("="*50 + "\n")


async def check_login_status(page: Page, indicator: str, timeout: int = 3000) -> bool:
    """检查登录状态"""
    try:
        await page.wait_for_selector(indicator, timeout=timeout)
        return True
    except:
        return False


async def wait_for_login(page: Page, indicator: str, login_url: Optional[str] = None):
    """等待用户登录"""
    if login_url:
        await page.goto(login_url)
    
    show_login_notification()
    
    print(f"等待用户登录中...（最多 5 分钟）")
    try:
        await page.wait_for_selector(indicator, timeout=300000)
        print("✅ 登录成功！")
        return True
    except:
        print("❌ 登录超时")
        return False


async def crawl_with_session(
    target_url: str,
    logged_in_indicator: str,
    crawl_function: Callable[[Page], Any],
    login_url: Optional[str] = None,
    use_system_profile: bool = True,
    headless: bool = False
) -> Any:
    """使用系统浏览器会话进行爬取"""
    
    user_data_dir = None
    
    if use_system_profile:
        user_data_dir = get_default_chrome_user_data_dir()
        if user_data_dir:
            print(f"📁 使用系统浏览器: {user_data_dir}")
        else:
            print("⚠️ 未找到系统浏览器，使用临时配置")
    
    async with async_playwright() as p:
        launch_options = {
            "headless": headless,
            "args": [
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security",
            ]
        }
        
        if user_data_dir:
            browser = await p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                **launch_options
            )
        else:
            browser = await p.chromium.launch(**launch_options)
        
        try:
            page = await browser.new_page()
            
            print(f"🌐 正在访问: {target_url}")
            await page.goto(target_url, wait_until="networkidle")
            
            # 检查登录状态
            is_logged_in = await check_login_status(page, logged_in_indicator)
            
            if not is_logged_in:
                print("🔐 需要登录")
                success = await wait_for_login(page, logged_in_indicator, login_url)
                if not success:
                    raise Exception("用户未完成登录")
                
                # 重新访问目标页面
                await page.goto(target_url, wait_until="networkidle")
            
            # 执行爬取
            print("🔍 爬取中...")
            result = await crawl_function(page)
            return result
            
        finally:
            await browser.close()


async def simple_crawl(
    target_url: str,
    logged_in_indicator: str,
    selector: Optional[str] = None,
    login_url: Optional[str] = None,
    wait: int = 3,
    scroll: bool = False,
    max_length: int = 0,
    save_path: Optional[str] = None
) -> str:
    """简单爬取：提取页面内容"""
    
    user_data_dir = get_default_chrome_user_data_dir()
    
    async with async_playwright() as p:
        if user_data_dir:
            browser = await p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=False,
                args=["--disable-blink-features=AutomationControlled"]
            )
        else:
            browser = await p.chromium.launch(headless=False)
        
        try:
            page = await browser.new_page()
            
            print(f"🌐 访问: {target_url}")
            await page.goto(target_url, wait_until="networkidle")
            
            # 等待
            if wait > 0:
                await asyncio.sleep(wait)
            
            # 滚动
            if scroll:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(2)
            
            # 检查登录
            is_logged_in = await check_login_status(page, logged_in_indicator)
            
            if not is_logged_in:
                print("🔐 需要登录")
                success = await wait_for_login(page, logged_in_indicator, login_url)
                if not success:
                    raise Exception("未完成登录")
                await page.goto(target_url, wait_until="networkidle")
            
            # 提取内容
            if selector:
                print(f"📦 提取选择器: {selector}")
                elements = await page.query_selector_all(selector)
                results = []
                for el in elements:
                    text = await el.inner_text()
                    results.append(text.strip())
                output = "\n\n---\n\n".join(results)
            else:
                print("📄 提取全文...")
                output = await page.evaluate("document.body.innerText")
            
            # 截断
            if max_length > 0 and len(output) > max_length:
                output = output[:max_length] + "\n\n... (内容已截断)"
            
            # 保存
            if save_path:
                with open(save_path, "w", encoding="utf-8") as f:
                    f.write(output)
                print(f"💾 已保存到: {save_path}")
            
            return output
            
        finally:
            await browser.close()


def main():
    parser = argparse.ArgumentParser(description="使用系统浏览器会话爬取网页")
    parser.add_argument("target_url", help="目标URL")
    parser.add_argument("--logged-indicator", required=True, help="登录后出现的元素选择器")
    parser.add_argument("--login-url", help="登录页面URL")
    parser.add_argument("--selector", help="CSS选择器（只提取匹配元素）")
    parser.add_argument("--wait", type=int, default=3, help="加载后等待秒数")
    parser.add_argument("--scroll", action="store_true", help="滚动页面触发懒加载")
    parser.add_argument("--max-length", type=int, default=0, help="最大字符数")
    parser.add_argument("--save", help="保存到文件")
    parser.add_argument("--headless", action="store_true", help="无头模式（可能无法登录）")
    
    args = parser.parse_args()
    
    result = asyncio.run(simple_crawl(
        target_url=args.target_url,
        logged_in_indicator=args.logged_indicator,
        selector=args.selector,
        login_url=args.login_url,
        wait=args.wait,
        scroll=args.scroll,
        max_length=args.max_length,
        save_path=args.save
    ))

    # 输出结构化 JSON 供调用方解析
    output = {
        "url": args.target_url,
        "content": result,
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
