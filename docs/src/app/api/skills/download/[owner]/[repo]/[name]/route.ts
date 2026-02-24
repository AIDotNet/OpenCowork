import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { recordSkillDownload } from '@/lib/db';

interface SkillFile {
  path: string;
  content: string;
}

const MAX_FILE_SIZE = 500 * 1024; // 500KB

/**
 * Download a specific skill's content from local public/skills/ directory.
 *
 * GET /api/skills/download/{owner}/{repo}/{name}
 *
 * Returns the skill's files as a bundle. Serves from docs/public/skills/{owner}/{repo}/{name}/
 * The desktop client uses this to install skills.
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
    const skillDir = join(process.cwd(), 'public', 'skills', owner, repo, name);
    const files: SkillFile[] = [];

    async function walkDir(dir: string, prefix: string): Promise<void> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          // Skip skill.json (metadata only)
          if (entry.name === 'skill.json') continue;

          const fullPath = join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            await walkDir(fullPath, relPath);
          } else {
            try {
              const stat = await readFile(fullPath);
              if (stat.length > MAX_FILE_SIZE) {
                console.warn(`[Skills API] Skipping large file: ${relPath} (${stat.length} bytes)`);
                continue;
              }
              const content = stat.toString('utf-8');
              files.push({ path: relPath, content });
            } catch (err) {
              console.warn(`[Skills API] Failed to read file: ${relPath}`, err);
            }
          }
        }
      } catch (err) {
        console.warn(`[Skills API] Failed to read directory: ${dir}`, err);
      }
    }

    await walkDir(skillDir, '');

    if (files.length === 0) {
      return NextResponse.json(
        {
          error: 'Skill not found',
          hint: `Could not find skill "${name}" in ${owner}/${repo}. The skill directory may not exist.`,
        },
        { status: 404 }
      );
    }

    // Record download
    try {
      const skillId = `${owner}/${repo}/${name}`;
      recordSkillDownload(skillId, name, repo);
    } catch (err) {
      console.warn('[Skills API] Failed to record download:', err);
      // Don't fail the request if recording fails
    }

    return NextResponse.json(
      {
        id: `${owner}/${repo}/${name}`,
        name,
        owner,
        repo,
        files,
        github: `https://github.com/${owner}/${repo}`,
        url: `https://open-cowork.shop/skills/${owner}/${repo}/${name}`,
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
