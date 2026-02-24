import { NextRequest, NextResponse } from 'next/server';

interface SkillFile {
  name: string;
  path: string;
  content: string;
  encoding: string;
}

/**
 * Download a specific skill's content from GitHub.
 *
 * GET /api/skills/download/{owner}/{repo}/{name}
 *
 * Returns the skill's files (typically a .md file) fetched from the GitHub repo.
 * The desktop client can use this to install skills without needing GitHub access directly.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string; name: string }> }
) {
  const { owner, repo, name } = await params;

  if (!owner || !repo || !name) {
    return NextResponse.json({ error: 'Missing owner, repo, or name' }, { status: 400 });
  }

  try {
    // Skills are stored in GitHub repos. The skill file is typically at:
    // 1. skills/{name}.md (most common pattern)
    // 2. {name}.md (root level)
    // 3. {name}/skill.md (directory-based)
    // We try the GitHub API to find the actual skill file.

    const githubBase = `https://api.github.com/repos/${owner}/${repo}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'OpenCowork-Skills-API',
    };

    // Try to get the repo contents to find the skill
    const paths = [
      `skills/${name}.md`,
      `${name}.md`,
      `${name}/skill.md`,
      `${name}/index.md`,
      `skills/${name}/skill.md`,
      `skills/${name}/index.md`,
    ];

    let skillContent: string | null = null;
    let skillPath: string | null = null;
    const extraFiles: SkillFile[] = [];

    for (const path of paths) {
      const resp = await fetch(`${githubBase}/contents/${path}`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        if (data.content && data.encoding === 'base64') {
          skillContent = Buffer.from(data.content, 'base64').toString('utf-8');
          skillPath = path;
          break;
        }
      }
    }

    // If not found via direct paths, try listing the directory
    if (!skillContent) {
      for (const dir of [`skills/${name}`, name]) {
        const resp = await fetch(`${githubBase}/contents/${dir}`, { headers });
        if (resp.ok) {
          const items = await resp.json();
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.type === 'file' && item.name.endsWith('.md')) {
                const fileResp = await fetch(item.url, { headers });
                if (fileResp.ok) {
                  const fileData = await fileResp.json();
                  if (fileData.content && fileData.encoding === 'base64') {
                    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
                    if (!skillContent) {
                      skillContent = content;
                      skillPath = item.path;
                    } else {
                      extraFiles.push({
                        name: item.name,
                        path: item.path,
                        content,
                        encoding: 'utf-8',
                      });
                    }
                  }
                }
              }
            }
            if (skillContent) break;
          }
        }
      }
    }

    if (!skillContent) {
      return NextResponse.json(
        {
          error: 'Skill not found',
          hint: `Could not find skill "${name}" in ${owner}/${repo}. The skill may have been removed or the repo structure may differ.`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        id: `${owner}/${repo}/${name}`,
        name,
        owner,
        repo,
        path: skillPath,
        content: skillContent,
        extraFiles,
        github: `https://github.com/${owner}/${repo}`,
        url: `https://skills.sh/${owner}/${repo}/${name}`,
      },
      {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to fetch skill', detail: message }, { status: 500 });
  }
}
