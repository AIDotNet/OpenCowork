---
name: email-drafter
description: Generate professional email drafts using Python templates. Use when the user needs to compose business emails, follow-ups, introductions, meeting requests, or other professional correspondence. Supports multiple tones, languages, and email types with structured output.
compatibility: Requires Python 3. No external dependencies (stdlib only).
---

# Email Drafter

Generate professional email drafts from structured input parameters.

## When to use this skill

- User asks to write or draft a professional email
- User needs help composing a business email (follow-up, introduction, request, etc.)
- User wants to generate email templates for different scenarios
- User needs multilingual email drafts (Chinese, English, Japanese, etc.)

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `email_draft.py` | Generate structured email drafts | Python 3 (stdlib only) |

## Steps

### 1. Generate an email draft

```bash
python scripts/email_draft.py --type TYPE --to "RECIPIENT" --subject "SUBJECT" --body "KEY_POINTS" --tone TONE
```

### 2. Email types

| Type | Description |
|---|---|
| `introduction` | Self-introduction or connecting two people |
| `follow-up` | Follow up on a previous conversation or meeting |
| `request` | Request information, meeting, or action |
| `thank-you` | Express gratitude after meeting/event |
| `apology` | Professional apology for delays/issues |
| `announcement` | Announce news, changes, or updates |
| `invitation` | Invite to meeting, event, or collaboration |
| `rejection` | Politely decline a request or proposal |
| `reminder` | Gentle reminder about deadlines or tasks |
| `proposal` | Propose a project, partnership, or idea |
| `cold-outreach` | First contact with a potential client/partner |
| `internal-memo` | Internal team communication |
| `custom` | Custom email from provided key points |

### 3. Tone options

- `formal` — Traditional business correspondence
- `professional` — Standard professional (default)
- `friendly` — Warm but professional
- `casual` — Informal, for colleagues you know well
- `urgent` — Time-sensitive communication

### 4. Options

- `--type TYPE` — Email type (see table above)
- `--to "NAME"` — Recipient name
- `--from "NAME"` — Sender name
- `--subject "SUBJECT"` — Email subject line
- `--body "KEY_POINTS"` — Key points to include (semicolon-separated)
- `--tone TONE` — Writing tone (default: professional)
- `--lang LANG` — Language: `en` (default), `zh`, `ja`, `ko`
- `--save PATH` — Save draft to file
- `--context "CONTEXT"` — Additional context or background

### 5. Examples

```bash
# Professional follow-up email
python scripts/email_draft.py --type follow-up --to "John" --subject "Follow up on our meeting" --body "discussed Q3 targets;agreed on timeline;need budget approval" --tone professional

# Formal Chinese business email
python scripts/email_draft.py --type request --to "王经理" --subject "关于项目合作" --body "希望安排会议;讨论合作细节;下周方便的时间" --tone formal --lang zh

# Internal announcement
python scripts/email_draft.py --type announcement --to "Team" --subject "New office policy" --body "remote work policy update;3 days in office;effective next month" --tone friendly

# Cold outreach
python scripts/email_draft.py --type cold-outreach --to "Sarah" --from "Alex" --subject "Partnership opportunity" --body "mutual benefit;our platform capabilities;propose a call" --tone professional --save outreach.txt
```

## Edge cases

- **Very long emails**: Break key points into concise items; the tool will structure them properly
- **Multiple recipients**: Use comma-separated names in `--to`
- **HTML output**: Use `--format html` for HTML-formatted email (default is plain text)
- **Signature**: Add `--signature "Your Name\nTitle\nCompany"` to append a signature block

## Scripts

- [email_draft.py](scripts/email_draft.py) — Generate professional email drafts
