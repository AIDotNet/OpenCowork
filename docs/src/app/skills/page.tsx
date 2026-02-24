'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Search, ExternalLink, Github, Wand2,
  Copy, Check, ChevronLeft, ChevronRight, Download, Loader2,
} from 'lucide-react';

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

interface SkillsIndex {
  total: number;
  totalPages: number;
  pageSize: number;
  owners: { name: string; count: number }[];
}

interface PageData {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  skills: Skill[];
}

function formatInstalls(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const OWNERS_COLORS: Record<string, string> = {
  'vercel-labs': 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900',
  anthropics: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  microsoft: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'google-labs-code': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  expo: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  obra: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  supabase: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  antfu: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300',
};

function OwnerBadge({ owner }: { owner: string }) {
  const cls = OWNERS_COLORS[owner] ?? 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {owner}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-mono bg-muted/50 hover:bg-muted transition-colors"
      title="Copy install command"
    >
      {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
      {label}
    </button>
  );
}

export default function SkillsPage() {
  const [index, setIndex] = useState<SkillsIndex | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [page, setPage] = useState(1);
  const [installing, setInstalling] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load index on mount
  useEffect(() => {
    fetch('/skills/index.json')
      .then((r) => r.json())
      .then((d: SkillsIndex) => setIndex(d));
  }, []);

  // Fetch skills page from API
  const fetchSkills = useCallback(async (p: number, q: string, owner: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p) });
      if (q) params.set('q', q);
      if (owner) params.set('owner', owner);
      const resp = await fetch(`/api/skills?${params}`);
      const data: PageData = await resp.json();
      setSkills(data.skills);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on page change
  useEffect(() => {
    fetchSkills(page, search, selectedOwner);
  }, [page, fetchSkills]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      fetchSkills(1, value, selectedOwner);
    }, 300);
  }, [selectedOwner, fetchSkills]);

  // Owner filter
  const handleOwnerFilter = useCallback((owner: string | null) => {
    setSelectedOwner(owner);
    setPage(1);
    fetchSkills(1, search, owner);
  }, [search, fetchSkills]);

  // Download skill
  const handleDownload = useCallback(async (skill: Skill) => {
    setInstalling(skill.id);
    try {
      const resp = await fetch(`/api/skills/download/${skill.owner}/${skill.repo}/${skill.name}`);
      const data = await resp.json();
      if (resp.ok) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${skill.name}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        alert(data.error || 'Failed to download skill');
      }
    } catch {
      alert('Failed to download skill');
    } finally {
      setInstalling(null);
    }
  }, []);

  if (!index) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Wand2 className="size-8 text-muted-foreground/30 animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading skills...</p>
        </div>
      </div>
    );
  }

  const displayTotal = total || index.total;
  const displayPages = totalPages || index.totalPages;

  return (
    <main className="w-full max-w-6xl mx-auto px-4 py-12">
      {/* Header */}
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Skills Market</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {index.total.toLocaleString()} skills &mdash; install to enhance your AI agents
            </p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search skills by name, owner, or repo..."
            className="w-full rounded-lg border bg-background pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Owner pills */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => handleOwnerFilter(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              !selectedOwner ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            All ({index.total.toLocaleString()})
          </button>
          {index.owners.slice(0, 20).map((o) => (
            <button
              key={o.name}
              onClick={() => handleOwnerFilter(selectedOwner === o.name ? null : o.name)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedOwner === o.name
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {o.name} ({o.count})
            </button>
          ))}
        </div>
      </div>

      {/* Skills table */}
      <div className="rounded-xl border overflow-hidden">
        <div className="hidden sm:grid grid-cols-[3rem_1fr_10rem_5rem_7rem] gap-2 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
          <span>#</span>
          <span>Skill</span>
          <span>Owner</span>
          <span className="text-right">Installs</span>
          <span className="text-right">Actions</span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Loader2 className="size-6 text-muted-foreground/40 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Wand2 className="size-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground">No skills found</p>
          </div>
        ) : (
          skills.map((skill) => (
            <div
              key={skill.id}
              onClick={() => setSelected(selected?.id === skill.id ? null : skill)}
              className={`grid grid-cols-1 sm:grid-cols-[3rem_1fr_10rem_5rem_7rem] gap-1 sm:gap-2 px-4 py-3 text-sm border-b last:border-b-0 cursor-pointer transition-colors ${
                selected?.id === skill.id ? 'bg-primary/5' : 'hover:bg-muted/30'
              }`}
            >
              <span className="hidden sm:block text-muted-foreground text-xs tabular-nums pt-0.5">{skill.rank}</span>
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="sm:hidden text-muted-foreground text-xs tabular-nums">#{skill.rank}</span>
                  <span className="font-medium truncate">{skill.name}</span>
                </div>
                <span className="text-[11px] text-muted-foreground truncate font-mono">{skill.owner}/{skill.repo}</span>
              </div>
              <div className="hidden sm:flex items-center">
                <OwnerBadge owner={skill.owner} />
              </div>
              <div className="hidden sm:flex items-center justify-end">
                <span className="tabular-nums text-xs font-medium">{formatInstalls(skill.installs)}</span>
              </div>
              <div className="hidden sm:flex items-center justify-end gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); handleDownload(skill); }}
                  disabled={installing === skill.id}
                  className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                  title="Download skill"
                >
                  {installing === skill.id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Download className="size-3.5" />}
                </button>
                <a
                  href={skill.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors"
                  title="GitHub"
                >
                  <Github className="size-3.5" />
                </a>
                <a
                  href={skill.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors"
                  title="View on skills.sh"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {displayPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
          <span>{displayTotal.toLocaleString()} skills &middot; Page {page} of {displayPages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1 || loading}
              className="inline-flex items-center justify-center size-8 rounded-md border hover:bg-muted transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronLeft className="size-4" />
            </button>
            {Array.from({ length: Math.min(7, displayPages) }, (_, i) => {
              let p: number;
              if (displayPages <= 7) p = i + 1;
              else if (page <= 4) p = i + 1;
              else if (page >= displayPages - 3) p = displayPages - 6 + i;
              else p = page - 3 + i;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  disabled={loading}
                  className={`inline-flex items-center justify-center size-8 rounded-md text-xs font-medium transition-colors ${
                    page === p ? 'bg-foreground text-background' : 'border hover:bg-muted'
                  }`}
                >
                  {p}
                </button>
              );
            })}
            <button
              onClick={() => setPage(Math.min(displayPages, page + 1))}
              disabled={page === displayPages || loading}
              className="inline-flex items-center justify-center size-8 rounded-md border hover:bg-muted transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Selected skill detail panel */}
      {selected && (
        <div className="mt-6 rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Wand2 className="size-5 text-primary" />
                <h2 className="text-lg font-bold">{selected.name}</h2>
                <OwnerBadge owner={selected.owner} />
              </div>
              <p className="text-sm text-muted-foreground font-mono">{selected.owner}/{selected.repo}/{selected.name}</p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold tabular-nums">{formatInstalls(selected.installs)}</div>
              <div className="text-xs text-muted-foreground">installs</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <CopyButton text={`npx skills add ${selected.owner}/${selected.repo}`} label={`npx skills add ${selected.owner}/${selected.repo}`} />
            <button
              onClick={() => handleDownload(selected)}
              disabled={installing === selected.id}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
            >
              {installing === selected.id
                ? <Loader2 className="size-3 animate-spin" />
                : <Download className="size-3" />}
              Download Skill
            </button>
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
            >
              <ExternalLink className="size-3" /> View on skills.sh
            </a>
            <a
              href={selected.github}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
            >
              <Github className="size-3" /> GitHub Repo
            </a>
          </div>

          <div className="rounded-lg bg-muted/50 p-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Install</h3>
            <div className="font-mono text-sm bg-zinc-950 text-zinc-100 rounded-md px-4 py-3">
              <span className="text-zinc-500">$</span> npx skills add {selected.owner}/{selected.repo}
            </div>
          </div>

          <div className="rounded-lg bg-muted/50 p-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">API Endpoint</h3>
            <div className="font-mono text-xs bg-zinc-950 text-zinc-100 rounded-md px-4 py-3 break-all">
              <span className="text-zinc-500">GET</span> /api/skills/download/{selected.owner}/{selected.repo}/{selected.name}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
