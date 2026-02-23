"""
发布推文到 X.com (Twitter)
使用系统浏览器登录状态
"""

import asyncio
import argparse
import os
import json
from pathlib import Path
from playwright.async_api import async_playwright


def get_default_browser_user_data_dir() -> str:
    """获取 Windows 系统默认浏览器用户数据目录"""
    local_app_data = os.environ.get('LOCALAPPDATA')
    if not local_app_data:
        return None
    
    # 优先尝试 Edge（用户默认浏览器）
    edge_path = Path(local_app_data) / "Microsoft" / "Edge" / "User Data"
    if edge_path.exists():
        return str(edge_path)
    
    # 尝试 Chrome
    chrome_path = Path(local_app_data) / "Google" / "Chrome" / "User Data"
    if chrome_path.exists():
        return str(chrome_path)
    
    return None


def show_login_notification():
    """显示 Windows 登录提醒弹窗"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0,
            "检测到未登录 X.com\n\n请在浏览器中完成登录，然后关闭此窗口继续",
            "需要登录 X",
            0x40 | 0x0
        )
    except Exception:
        print("\n" + "="*50)
        print("请在浏览器中完成 X.com 登录...")
        print("="*50 + "\n")


async def post_to_x(content: str, headless: bool = False):
    """发布推文到 X.com"""
    
    user_data_dir = get_default_browser_user_data_dir()
    
    if user_data_dir:
        print(f"使用原始浏览器数据: {user_data_dir}")
    else:
        print("未找到系统浏览器数据")
        return False
    
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-web-security",
                ]
            )
        except Exception as e:
            print(f"启动浏览器失败: {e}")
            print("提示：请关闭 Edge 浏览器后重试")
            return False
        
        try:
            page = await browser.new_page()
            
            # 访问 X.com 主页
            print("正在打开 x.com...")
            try:
                await page.goto("https://x.com", wait_until="domcontentloaded", timeout=60000)
            except:
                pass
            await asyncio.sleep(5)
            
            # 检查是否已登录
            print("检查登录状态...")
            logged_in_selectors = [
                '[data-testid="SideNav_NewTweet_Button"]',
                '[data-testid="tweetButtonInline"]',
                '[data-testid="AppTabBar_Profile_Link"]',
                'a[href="/compose/tweet"]',
            ]
            
            is_logged_in = False
            for selector in logged_in_selectors:
                try:
                    await page.wait_for_selector(selector, timeout=5000)
                    is_logged_in = True
                    print(f"已登录 (找到: {selector})")
                    break
                except:
                    continue
            
            if not is_logged_in:
                print("未登录，等待用户登录...")
                show_login_notification()
                
                for selector in logged_in_selectors:
                    try:
                        await page.wait_for_selector(selector, timeout=300000)
                        is_logged_in = True
                        print("登录成功！")
                        break
                    except:
                        continue
                
                if not is_logged_in:
                    print("登录超时")
                    return False
            
            # 打开发推界面
            print("打开发推界面...")
            try:
                tweet_btn = await page.query_selector('[data-testid="SideNav_NewTweet_Button"]')
                if tweet_btn:
                    await tweet_btn.click()
                    await asyncio.sleep(2)
                else:
                    await page.goto("https://x.com/compose/tweet", wait_until="networkidle")
            except:
                await page.goto("https://x.com/compose/tweet", wait_until="networkidle")
            
            await asyncio.sleep(3)
            
            # 找到文本输入框
            print("输入推文内容...")
            text_selectors = [
                '[data-testid="tweetTextarea_0"]',
                '[data-testid="tweetTextarea_0RichTextInputContainer"]',
                'div[contenteditable="true"]',
                '[aria-label="Tweet text"]',
                '[aria-label="发推"]',
            ]
            
            text_input = None
            for selector in text_selectors:
                try:
                    text_input = await page.wait_for_selector(selector, timeout=5000)
                    if text_input:
                        print(f"找到输入框: {selector}")
                        break
                except:
                    continue
            
            if not text_input:
                print("未找到文本输入框")
                await page.screenshot(path="x_debug.png")
                return False
            
            # 输入内容
            await text_input.fill(content)
            await asyncio.sleep(1)
            
            # 点击发布按钮
            print("点击发布按钮...")
            post_selectors = [
                '[data-testid="tweetButton"]',
                '[data-testid="tweetButtonInline"]',
                'button[data-testid="tweetButton"]',
            ]
            
            post_btn = None
            for selector in post_selectors:
                post_btn = await page.query_selector(selector)
                if post_btn:
                    print(f"找到发布按钮: {selector}")
                    break
            
            if post_btn:
                is_disabled = await post_btn.get_attribute("disabled")
                if is_disabled:
                    print("发布按钮当前不可用，等待...")
                    await asyncio.sleep(3)
                
                # 使用 JavaScript 点击避免元素遮挡
                try:
                    await post_btn.evaluate("el => el.click()")
                except:
                    await post_btn.click(force=True)
                
                print("已点击发布按钮")
                await asyncio.sleep(5)
                
                print("检查发布状态...")
                await asyncio.sleep(3)
                
                print("✅ 推文发布完成！")
                return True
            else:
                print("未找到发布按钮")
                await page.screenshot(path="x_debug.png")
                return False
                
        except Exception as e:
            print(f"发布失败: {str(e)}")
            try:
                await page.screenshot(path="x_error.png")
            except:
                pass
            return False
        finally:
            try:
                await browser.close()
            except:
                pass


def main():
    parser = argparse.ArgumentParser(description="发布推文到 X.com")
    parser.add_argument("content", help="推文内容")
    parser.add_argument("--headless", action="store_true", help="无头模式")
    
    args = parser.parse_args()
    
    result = asyncio.run(post_to_x(args.content, args.headless))
    
    output = {
        "success": result,
        "content": args.content if result else None
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
