import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Skill {
  id: string;
  name: string;
  owner: string;
  repo: string;
  rank: number;
  installs: number;
  url: string;
  github: string;
}

interface PageData {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  skills: Skill[];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const q = searchParams.get('q')?.toLowerCase() ?? '';
  const owner = searchParams.get('owner') ?? '';

  // If no search/filter, serve paginated static files
  if (!q && !owner) {
    try {
      const filePath = join(process.cwd(), 'public', 'skills', 'pages', `page-${page}.json`);
      const data: PageData = JSON.parse(readFileSync(filePath, 'utf-8'));
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    } catch {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
  }

  // For search/filter, load full dataset and filter in memory
  try {
    const filePath = join(process.cwd(), 'public', 'skills', 'skills.json');
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    let skills: Skill[] = data.skills;

    if (owner) {
      skills = skills.filter((s: Skill) => s.owner === owner);
    }
    if (q) {
      skills = skills.filter(
        (s: Skill) =>
          s.name.toLowerCase().includes(q) ||
          s.owner.toLowerCase().includes(q) ||
          s.repo.toLowerCase().includes(q)
      );
    }

    const pageSize = 100;
    const totalPages = Math.ceil(skills.length / pageSize);
    const safePage = Math.min(page, totalPages || 1);
    const start = (safePage - 1) * pageSize;
    const pageSkills = skills.slice(start, start + pageSize);

    return NextResponse.json(
      {
        page: safePage,
        pageSize,
        totalPages,
        total: skills.length,
        skills: pageSkills,
      },
      { headers: { 'Cache-Control': 'public, max-age=3600' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed to load skills' }, { status: 500 });
  }
}
