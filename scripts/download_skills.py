"""Download top skills from GitHub into individual directories."""
import json
import os
import time
import requests

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)
SKILLS_DIR = os.path.join(_PROJECT_ROOT, 'docs', 'public', 'skills')
SKILLS_JSON = os.path.join(SKILLS_DIR, 'skills.json')

# Possible file paths for a skill in a GitHub repo
SKILL_PATHS = [
    'skills/{name}.md',
    '{name}.md',
    '{name}/skill.md',
    '{name}/index.md',
    'skills/{name}/skill.md',
    'skills/{name}/index.md',
    'skills/{name}/README.md',
    '{name}/README.md',
]

HEADERS = {'User-Agent': 'OpenCowork-Skills-Downloader'}
RAW_BASE = 'https://raw.githubusercontent.com/{owner}/{repo}/main/{path}'
RAW_BASE_MASTER = 'https://raw.githubusercontent.com/{owner}/{repo}/master/{path}'

def download_skill(skill: dict, base_dir: str) -> bool:
    """Download a single skill's content from GitHub."""
    owner = skill['owner']
    repo = skill['repo']
    name = skill['name']

    skill_dir = os.path.join(base_dir, owner, repo, name)
    meta_file = os.path.join(skill_dir, 'skill.json')

    # Skip if already downloaded
    if os.path.exists(meta_file):
        return True

    for path_tpl in SKILL_PATHS:
        path = path_tpl.format(name=name)
        for base in [RAW_BASE, RAW_BASE_MASTER]:
            url = base.format(owner=owner, repo=repo, path=path)
            try:
                resp = requests.get(url, timeout=15, headers=HEADERS)
                if resp.status_code == 200 and len(resp.text.strip()) > 10:
                    os.makedirs(skill_dir, exist_ok=True)

                    # Save the skill markdown
                    md_filename = os.path.basename(path)
                    with open(os.path.join(skill_dir, md_filename), 'w', encoding='utf-8') as f:
                        f.write(resp.text)

                    # Save metadata
                    meta = {
                        'id': skill['id'],
                        'name': name,
                        'owner': owner,
                        'repo': repo,
                        'rank': skill['rank'],
                        'installs': skill['installs'],
                        'source_path': path,
                        'url': skill['url'],
                        'github': skill['github'],
                    }
                    with open(meta_file, 'w', encoding='utf-8') as f:
                        json.dump(meta, f, indent=2, ensure_ascii=False)

                    return True
            except requests.RequestException:
                continue

    return False


def main():
    with open(SKILLS_JSON, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Top N skills by rank (already sorted)
    top_n = int(os.environ.get('TOP_N', '500'))
    skills = data['skills'][:top_n]

    print(f'Downloading top {len(skills)} skills...')

    success = 0
    failed = 0
    failed_list = []

    for i, skill in enumerate(skills):
        ok = download_skill(skill, SKILLS_DIR)
        if ok:
            success += 1
        else:
            failed += 1
            failed_list.append(skill['id'])

        if (i + 1) % 50 == 0:
            print(f'  Progress: {i + 1}/{len(skills)} (success={success}, failed={failed})')

        # Small delay to be polite
        time.sleep(0.1)

    print(f'\nDone! Success: {success}, Failed: {failed}')
    if failed_list:
        print(f'Failed skills ({len(failed_list)}):')
        for sid in failed_list[:20]:
            print(f'  - {sid}')
        if len(failed_list) > 20:
            print(f'  ... and {len(failed_list) - 20} more')


if __name__ == '__main__':
    main()
