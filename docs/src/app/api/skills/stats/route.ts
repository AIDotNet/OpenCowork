import { NextResponse } from 'next/server';
import { getSkillsDownloads, getCategoryStats } from '@/lib/db';

/**
 * GET /api/skills/stats
 * Returns download statistics for all skills
 */
export async function GET() {
  try {
    const downloads = getSkillsDownloads();
    const categoryStats = getCategoryStats();

    return NextResponse.json(
      {
        downloads,
        categoryStats,
        totalDownloads: downloads.reduce((sum, s) => sum + s.downloadCount, 0),
      },
      {
        headers: { 'Cache-Control': 'public, max-age=300' }, // 5 minutes cache
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to fetch stats', detail: message }, { status: 500 });
  }
}
