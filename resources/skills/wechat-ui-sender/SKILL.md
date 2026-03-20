---
name: wechat-ui-sender
description: Send desktop WeChat messages via screenshot-driven UI automation. Focus the WeChat window, search a contact or group, paste message from a markdown file, and optionally capture an audit screenshot. Supports automatic launch from tray and retry logic. Use when official APIs are unavailable. NOTE: Only supports markdown files - raw text messages are not supported.
compatibility: Windows desktop with WeChat PC client, Python 3.9+, and pyautogui + pyperclip + pygetwindow + pillow.
---

# WeChat UI Sender

Automate the Windows WeChat client to push messages from an AI Agent to a specific contact or group using UI-level simulation.

## When to use this skill

- Need to notify a person or group in personal WeChat (non-enterprise) from an AI workflow.
- No access to official WeChat/WeCom APIs, so UI automation is acceptable.
- Want basic auditing via optional screenshots after each send.
- WeChat may be closed, minimized to tray, or not running — script can auto-launch.

Avoid this skill if an official API (WeCom bot/app) is available—API integrations are more stable and secure.

## Requirements

1. Windows desktop with the WeChat PC client installed and logged in.
2. Python 3.9+ environment with:
   ```bash
   pip install pyautogui pyperclip pygetwindow pillow psutil
   ```
3. Resolution scaling should be 100% for best accuracy.
4. Skill runner must allow clipboard access (pyperclip) and simulated keyboard shortcuts.

## New features

- **Auto-launch**: Use `--force-launch` to automatically start WeChat if not running.
- **Tray recovery**: Script detects minimized/tray state and attempts restoration.
- **Retry logic**: Configurable retry attempts with `--max-retries` and `--retry-delay`.
- **Status check**: Use `--check-only` to verify WeChat status without sending.

## Scripts overview

| Script                   | Purpose                                                                                     | Dependencies                                                |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `scripts/send_wechat.py` | Activate WeChat, locate contact via Ctrl+F, paste message, press Enter, optional screenshot | `pyautogui`, `pyperclip`, `pygetwindow`, `pillow`, `psutil` |

## Usage steps

1. **Install dependencies (first time only)**

   ```bash
   pip install pyautogui pyperclip pygetwindow pillow psutil
   ```

2. **Basic usage** - Write message to a markdown file first, then send

   ```bash
   # Create a message file first
   echo "Your message here" > message.md

   # Send using the markdown file
   python scripts/send_wechat.py "CONTACT_OR_GROUP_NAME" --file message.md
   ```

3. **Auto-launch if closed**

   ```bash
   python scripts/send_wechat.py "Group Name" --file message.md --force-launch
   ```

4. **Check WeChat status**

   ```bash
   python scripts/send_wechat.py "dummy" --file message.md --check-only
   ```

5. **Full options**
   ```bash
   python scripts/send_wechat.py "CONTACT_OR_GROUP_NAME" \
       --file "C:\\path\\to\\message.md" \
       --window-title "微信" \
       --search-delay 0.6 \
       --typing-delay 0.2 \
       --screenshot-dir C:\\temp\\wechat-captures \
       --force-launch \
       --max-retries 5 \
       --retry-delay 3.0 \
       --confirm
   ```

## Command options

| Option             | Default      | Description                                                                   |
| ------------------ | ------------ | ----------------------------------------------------------------------------- |
| `contact`          | required     | Display name or keyword for the contact/group search box                      |
| `--file`           | **required** | Path to a markdown file (.md, .markdown, .txt) containing the message to send |
| `--window-title`   | `微信`       | Window title to match (case-sensitive partial match)                          |
| `--search-delay`   | 1.0          | Seconds to wait after typing contact before pressing Enter                    |
| `--typing-delay`   | 0.8          | Seconds to wait after pasting message before sending                          |
| `--pause`          | 0.8          | General pause between actions in seconds                                      |
| `--screenshot-dir` | None         | Optional folder to store a screenshot after sending                           |
| `--force-launch`   | False        | Force attempt to launch WeChat if not running                                 |
| `--max-retries`    | 3            | Maximum retry attempts to find/activate WeChat window                         |
| `--retry-delay`    | 3.0          | Seconds to wait between retry attempts                                        |
| `--confirm`        | False        | Wait for manual contact selection after search                                |
| `--confirm-delay`  | 2.0          | Seconds to wait when `--confirm` is used                                      |
| `--check-only`     | False        | Only check if WeChat is running, do not send                                  |
| `--use-center`     | False        | Use window center position for input box                                      |

> **Important**: This script ONLY supports sending markdown files. Use `--file` to specify the path to your message file. Plain text messages are no longer supported directly.

## Auto-launch paths

The script attempts to launch WeChat from these locations in order:

1. `%ProgramFiles%\Tencent\WeChat\WeChat.exe`
2. `%ProgramFiles(x86)%\Tencent\WeChat\WeChat.exe`
3. `%LocalAppData%\Programs\WeChat\WeChat.exe`
4. `C:\Program Files\Tencent\WeChat\WeChat.exe`
5. `C:\Program Files (x86)\Tencent\WeChat\WeChat.exe`
6. `D:\Program Files\Tencent\WeChat\WeChat.exe`

## Safety notes

- Add an approval gate before sending to prevent accidental messages.
- Keep message length moderate; pyperclip pastes full content but huge payloads may fail.
- UI automation is fragile—theme or layout changes may require timing tweaks.
- For reliability, keep WeChat logged in and unlocked.
- Auto-launch requires WeChat to be installed in a standard location.

## Troubleshooting

| Symptom                                  | Fix                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `Could not find a window matching title` | Use `--force-launch` to auto-start, or manually open WeChat.              |
| WeChat in tray                           | Script attempts recovery; try `--max-retries 5` for more attempts.        |
| Script hangs after Ctrl+F                | Increase `--search-delay` or close pop-up dialogs.                        |
| Message not sent                         | Ensure chat input is focused; verify there are no rich-text restrictions. |
| Screenshot path missing                  | Provide `--screenshot-dir` and ensure the path is writable.               |
| Auto-launch failed                       | Check WeChat is installed in one of the standard paths.                   |

## Exit codes

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 0    | Success (or `--check-only` with WeChat running)     |
| 1    | Failure (or `--check-only` with WeChat not running) |

## File list

- `SKILL.md` — this manifest & instructions
- `scripts/send_wechat.py` — automation script
