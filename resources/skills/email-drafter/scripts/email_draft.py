#!/usr/bin/env python3
"""
Generate professional email drafts from structured input.
No external dependencies — uses only Python 3 standard library.
"""

import argparse
import sys
from datetime import datetime


# ---------------------------------------------------------------------------
# Email templates by type and language
# ---------------------------------------------------------------------------

TEMPLATES = {
    'en': {
        'introduction': {
            'opening': 'I hope this email finds you well. My name is {sender}, and I am reaching out to introduce myself.',
            'closing': 'I would welcome the opportunity to connect further. Please feel free to reach out at your convenience.',
            'sign_off': 'Best regards',
        },
        'follow-up': {
            'opening': 'Thank you for taking the time to meet with me{context}. I wanted to follow up on our conversation.',
            'closing': 'Please let me know if you have any questions or if there is anything else I can help with.',
            'sign_off': 'Best regards',
        },
        'request': {
            'opening': 'I hope this message finds you well. I am writing to request your assistance with the following.',
            'closing': 'I appreciate your time and consideration. Please let me know if you need any additional information.',
            'sign_off': 'Thank you',
        },
        'thank-you': {
            'opening': 'I wanted to take a moment to express my sincere gratitude.',
            'closing': 'Thank you once again. I truly appreciate your support.',
            'sign_off': 'With appreciation',
        },
        'apology': {
            'opening': 'I am writing to sincerely apologize for the inconvenience caused.',
            'closing': 'I appreciate your understanding and patience. Please do not hesitate to reach out if you have any concerns.',
            'sign_off': 'Sincerely',
        },
        'announcement': {
            'opening': 'I am writing to share an important update with you.',
            'closing': 'If you have any questions or concerns, please do not hesitate to reach out.',
            'sign_off': 'Best regards',
        },
        'invitation': {
            'opening': 'I would like to cordially invite you to the following.',
            'closing': 'I look forward to your positive response. Please confirm your availability at your earliest convenience.',
            'sign_off': 'Looking forward to hearing from you',
        },
        'rejection': {
            'opening': 'Thank you for your proposal/request. After careful consideration, I wanted to share our decision.',
            'closing': 'I appreciate your understanding and hope we can explore other opportunities in the future.',
            'sign_off': 'Best regards',
        },
        'reminder': {
            'opening': 'I hope this message finds you well. I wanted to send a friendly reminder regarding the following.',
            'closing': 'Please let me know if you have any questions or need any assistance.',
            'sign_off': 'Best regards',
        },
        'proposal': {
            'opening': 'I am excited to present the following proposal for your consideration.',
            'closing': 'I would be happy to discuss this proposal in more detail at your convenience. Please let me know a suitable time.',
            'sign_off': 'Looking forward to your feedback',
        },
        'cold-outreach': {
            'opening': 'I came across your work and was impressed by what you have accomplished. I believe there may be a great opportunity for us to collaborate.',
            'closing': 'Would you be open to a brief call to explore this further? I am happy to work around your schedule.',
            'sign_off': 'Best regards',
        },
        'internal-memo': {
            'opening': 'Please see the following update for the team.',
            'closing': 'Please reach out if you have any questions.',
            'sign_off': 'Thanks',
        },
        'custom': {
            'opening': '',
            'closing': '',
            'sign_off': 'Best regards',
        },
    },
    'zh': {
        'introduction': {
            'opening': '您好！我是{sender}，冒昧给您写信，希望能向您做一个简单的自我介绍。',
            'closing': '期待有机会与您进一步交流，如有任何问题请随时联系我。',
            'sign_off': '此致\n敬礼',
        },
        'follow-up': {
            'opening': '感谢您百忙之中抽出时间{context}。我想就我们的交谈做一个跟进。',
            'closing': '如有任何问题或需要进一步的信息，请随时与我联系。',
            'sign_off': '此致\n敬礼',
        },
        'request': {
            'opening': '您好！冒昧打扰，我写信是想请求您在以下方面给予协助。',
            'closing': '感谢您的时间和考虑。如需任何补充信息，请随时告知。',
            'sign_off': '谢谢',
        },
        'thank-you': {
            'opening': '我想借此机会向您表达我诚挚的感谢。',
            'closing': '再次感谢您的支持与帮助。',
            'sign_off': '此致\n敬礼',
        },
        'apology': {
            'opening': '对于给您带来的不便，我深表歉意。',
            'closing': '感谢您的理解与耐心。如有任何疑虑，请随时与我联系。',
            'sign_off': '此致\n敬礼',
        },
        'announcement': {
            'opening': '我写信是想与您分享一个重要的更新。',
            'closing': '如有任何疑问或建议，欢迎随时与我交流。',
            'sign_off': '此致\n敬礼',
        },
        'invitation': {
            'opening': '诚挚地邀请您参加以下活动。',
            'closing': '期待您的积极回复，请在方便时确认您的出席。',
            'sign_off': '期待您的回复',
        },
        'rejection': {
            'opening': '感谢您的提案/请求。经过慎重考虑后，我想与您分享我们的决定。',
            'closing': '感谢您的理解，希望未来我们能有其他合作机会。',
            'sign_off': '此致\n敬礼',
        },
        'reminder': {
            'opening': '您好！我想就以下事项发送一个友好的提醒。',
            'closing': '如有任何问题或需要帮助，请随时联系我。',
            'sign_off': '此致\n敬礼',
        },
        'proposal': {
            'opening': '我很高兴向您提交以下提案供您参考。',
            'closing': '我很乐意在您方便时进一步讨论此提案的细节。请告知合适的时间。',
            'sign_off': '期待您的反馈',
        },
        'cold-outreach': {
            'opening': '我了解到您在相关领域的出色工作，非常钦佩。我认为我们之间可能存在很好的合作机会。',
            'closing': '不知您是否方便安排一次简短的通话，进一步探讨合作的可能？我可以配合您的时间。',
            'sign_off': '此致\n敬礼',
        },
        'internal-memo': {
            'opening': '请查阅以下团队更新信息。',
            'closing': '如有问题请随时联系。',
            'sign_off': '谢谢',
        },
        'custom': {
            'opening': '',
            'closing': '',
            'sign_off': '此致\n敬礼',
        },
    },
}

TONE_ADJUSTMENTS = {
    'formal': {
        'greeting_en': 'Dear {recipient},',
        'greeting_zh': '尊敬的{recipient}：',
    },
    'professional': {
        'greeting_en': 'Dear {recipient},',
        'greeting_zh': '{recipient}，您好：',
    },
    'friendly': {
        'greeting_en': 'Hi {recipient},',
        'greeting_zh': '{recipient}，你好！',
    },
    'casual': {
        'greeting_en': 'Hey {recipient},',
        'greeting_zh': '{recipient}，',
    },
    'urgent': {
        'greeting_en': 'Dear {recipient},',
        'greeting_zh': '{recipient}，您好：',
    },
}


def generate_email(email_type, recipient, subject, body_points, tone='professional',
                   lang='en', sender=None, context=None, signature=None):
    """Generate a professional email draft."""
    # Get template
    lang_templates = TEMPLATES.get(lang, TEMPLATES['en'])
    template = lang_templates.get(email_type, lang_templates['custom'])

    # Get greeting
    tone_cfg = TONE_ADJUSTMENTS.get(tone, TONE_ADJUSTMENTS['professional'])
    greeting_key = f'greeting_{lang}' if f'greeting_{lang}' in tone_cfg else 'greeting_en'
    greeting = tone_cfg[greeting_key].format(recipient=recipient)

    # Build opening
    opening = template['opening']
    if sender:
        opening = opening.replace('{sender}', sender)
    if context:
        opening = opening.replace('{context}', f' {context}')
    else:
        opening = opening.replace('{context}', '')

    # Build body
    points = [p.strip() for p in body_points.split(';') if p.strip()]
    if lang == 'zh':
        body_text = '\n'.join(f'• {p}' for p in points) if points else ''
    else:
        body_text = '\n'.join(f'• {p}' for p in points) if points else ''

    # Build closing
    closing = template['closing']
    sign_off = template['sign_off']

    # Urgent prefix
    urgent_prefix = ''
    if tone == 'urgent':
        if lang == 'zh':
            urgent_prefix = '【紧急】'
        else:
            urgent_prefix = '[URGENT] '

    # Compose email
    parts = []
    parts.append(f"Subject: {urgent_prefix}{subject}")
    parts.append(f"To: {recipient}")
    if sender:
        parts.append(f"From: {sender}")
    parts.append(f"Date: {datetime.now().strftime('%Y-%m-%d')}")
    parts.append('')
    parts.append('---')
    parts.append('')
    parts.append(greeting)
    parts.append('')
    if opening:
        parts.append(opening)
        parts.append('')
    if body_text:
        parts.append(body_text)
        parts.append('')
    if closing:
        parts.append(closing)
        parts.append('')
    parts.append(sign_off + ',')
    if sender:
        parts.append(sender)
    if signature:
        parts.append('')
        parts.append(signature)

    return '\n'.join(parts)


def main():
    parser = argparse.ArgumentParser(description='Professional Email Draft Generator')
    parser.add_argument('--type', required=True,
                        choices=['introduction', 'follow-up', 'request', 'thank-you',
                                 'apology', 'announcement', 'invitation', 'rejection',
                                 'reminder', 'proposal', 'cold-outreach', 'internal-memo', 'custom'],
                        help='Email type')
    parser.add_argument('--to', required=True, help='Recipient name')
    parser.add_argument('--from', dest='sender', help='Sender name')
    parser.add_argument('--subject', required=True, help='Email subject')
    parser.add_argument('--body', required=True, help='Key points (semicolon-separated)')
    parser.add_argument('--tone', default='professional',
                        choices=['formal', 'professional', 'friendly', 'casual', 'urgent'])
    parser.add_argument('--lang', default='en', choices=['en', 'zh'],
                        help='Language (default: en)')
    parser.add_argument('--context', help='Additional context')
    parser.add_argument('--signature', help='Signature block')
    parser.add_argument('--save', help='Save draft to file')

    args = parser.parse_args()

    email = generate_email(
        email_type=args.type,
        recipient=args.to,
        subject=args.subject,
        body_points=args.body,
        tone=args.tone,
        lang=args.lang,
        sender=args.sender,
        context=args.context,
        signature=args.signature
    )

    if args.save:
        with open(args.save, 'w', encoding='utf-8') as f:
            f.write(email)
        print(f"Draft saved to: {args.save}", file=sys.stderr)

    print(email)


if __name__ == '__main__':
    main()
