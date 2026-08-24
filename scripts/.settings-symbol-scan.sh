#!/usr/bin/env bash
# Throwaway helper: report which top-level SettingsPage imports each extracted panel still needs.
set -euo pipefail
cd "$(dirname "$0")/../src/renderer/src/components/settings/panels"

SYMBOLS="useEffect useState useCallback useMemo
ArrowLeft Settings BrainCircuit BarChart3 Info Server Cable Loader2 Github Sparkles ShieldCheck Layers HardDriveDownload HardDriveUpload Trash2 Globe ArrowRightLeft Wand2 BookOpen Save RefreshCw Puzzle Terminal UserRound PawPrint Anchor Waypoints
useTheme AnimatePresence motion useUIStore useChatStore
clampMaxParallelToolCalls clampMaxConcurrentSubAgents clampApiRequestTimeoutSeconds DEFAULT_THEME_MODE DEFAULT_MAX_PARALLEL_TOOL_CALLS DEFAULT_MAX_CONCURRENT_SUB_AGENTS DEFAULT_API_REQUEST_TIMEOUT_SECONDS DEFAULT_SHELL_EXECUTION_ENDPOINT MAX_MAX_PARALLEL_TOOL_CALLS MIN_MAX_PARALLEL_TOOL_CALLS MAX_MAX_CONCURRENT_SUB_AGENTS MIN_MAX_CONCURRENT_SUB_AGENTS MAX_API_REQUEST_TIMEOUT_SECONDS MIN_API_REQUEST_TIMEOUT_SECONDS resolveShellExecutable ShellExecutionEndpoint useSettingsStore
toast useTranslation confirm LANGUAGE_OPTIONS resolveIntlLocale exportSessionSnapshotFromDb
Button Badge Input Textarea Separator Slider Switch SelectContent SelectGroup SelectItem SelectLabel SelectTrigger SelectValue Select
FadeIn SlideIn isProviderAvailableForModelSelection useProviderStore ModelIcon ProviderIcon IPC ipcClient
isMissingFileErrorMessage joinFsPath readTextFile resolveGlobalMemoryHomePath packageJson
clearUsageEvents getUsageActivityByModel getUsageActivityByProvider getUsageActivityDaily getUsageActivityOverview getUsageByModel getUsageByProvider getUsageDaily getUsageOverview getUsageTimeline listUsageEvents UsageTimelineBucket
getCacheReadRatio getLiveOutputCursorClass getLiveOutputShimmerClass getLiveOutputSurfaceClass
DEFAULT_APP_THEME_PRESET DEFAULT_SSH_TERMINAL_THEME_PRESET clampCompressionThreshold MAX_CONTEXT_COMPRESSION_THRESHOLD MIN_CONTEXT_COMPRESSION_THRESHOLD
WindowControls DEFAULT_BUILTIN_SOUL_TEMPLATE_ID BuiltinSoulTemplateWithContent OPEN_COWORK_RELEASES_LATEST_URL AppDistribution AnalyticsOverview GlobalThemePanel"

for file in "$@"; do
  echo "=== $file ==="
  for symbol in $SYMBOLS; do
    if grep -qE "(^|[^A-Za-z0-9_])${symbol}([^A-Za-z0-9_]|$)" "$file"; then
      printf '%s ' "$symbol"
    fi
  done
  echo
  echo
done
