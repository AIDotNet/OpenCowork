using System.Text;
using System.Text.Json;

/// <summary>
/// Per-turn task-list context for the agent loop.
///
/// This used to be built in the renderer from its own <c>useTaskStore</c> projection, which made
/// it unavailable to every other client: hosted sessions, cron, the CLI and chat mode had no
/// task reminder at all, auto-continue turns skipped it, and background sessions read a store
/// that only refreshes while the session is in the foreground. No path said anything while the
/// list was still empty, so nothing pushed the model to create one in the first place.
///
/// The Worker owns the tasks table, so the reminder belongs here: one builder, every client,
/// and the state it reports is the stored state rather than a projection that can drift.
/// </summary>
internal static partial class AgentRuntimeTaskExecutor
{
    /// <summary>Above this many tasks the reminder degrades to counts and points at TaskList.</summary>
    private const int ReminderMaxRows = 15;

    /// <summary>Completed tasks older than the most recent few collapse into one count line.</summary>
    private const int ReminderRecentCompleted = 3;

    private const int ReminderTitleLimit = 100;

    /// <summary>
    /// Consecutive tool-calling iterations without a task tool before the loop re-states the
    /// current task. A turn can run for dozens of iterations, and the only other place the list
    /// appears is the TaskCreate/TaskUpdate result that scrolls further back with every batch.
    /// </summary>
    public const int ReminderDriftIterations = 8;

    private const string EmptyListReminderText =
        "The session task list is empty. Create it with a single TaskCreate call (pass the whole " +
        "`tasks` array, first entry in_progress) when the request spans several files or layers, " +
        "already enumerates several items, or needs an investigate-then-change order. Skip it for " +
        "a single action or a plain question.";

    /// <summary>
    /// Turn-level task state, prepended to the user message alongside the other request contexts.
    /// Returns null when the run cannot act on a session task list at all.
    /// </summary>
    public static string? BuildTurnReminder(JsonElement parameters)
    {
        if (!TryLoadReminderTasks(parameters, out var tasks))
        {
            return null;
        }

        return tasks.Count == 0
            ? WrapReminder([EmptyListReminderText])
            : WrapReminder(BuildTaskListLines(tasks));
    }

    /// <summary>
    /// Mid-turn nudge for a list that has stopped moving. Deliberately shorter than the turn
    /// reminder: the full list is already in context, what is missing is the prompt to advance it.
    /// </summary>
    public static string? BuildDriftReminder(JsonElement parameters)
    {
        if (!TryLoadReminderTasks(parameters, out var tasks) || tasks.Count == 0)
        {
            return null;
        }

        var current = tasks.FirstOrDefault(static task => task.Status == "in_progress");
        if (current is not null)
        {
            return WrapReminder([
                $"Task list check: #{current.Id} \"{TruncateReminderTitle(current.Subject)}\" is still in_progress.",
                "If it is done, mark it completed with TaskUpdate and move the next task to " +
                    "in_progress. If the plan changed, update the list instead of leaving it stale."
            ]);
        }

        var open = tasks.Count(static task => task.Status != "completed");
        if (open == 0)
        {
            return null;
        }

        return WrapReminder([
            $"Task list check: {open} task(s) are still open and none is in_progress.",
            "Pick the next one, mark it in_progress with TaskUpdate, and continue. Do not " +
                "re-create tasks that already exist."
        ]);
    }

    private static bool TryLoadReminderTasks(JsonElement parameters, out List<NativeTaskRow> tasks)
    {
        tasks = [];

        // A team routes tasks through AgentRuntimeTeamExecutor and its own three-state store, so
        // the standalone table would report a list the model cannot act on.
        if (!CanExecute(parameters) || !HasTaskTool(parameters))
        {
            return false;
        }

        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId))
        {
            return false;
        }

        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            tasks = LoadTasksBySession(connection, sessionId);
            return true;
        }
        catch (Exception error)
        {
            // A reminder is never worth failing a turn over.
            WorkerLog.Warn($"task reminder skipped: {error.Message}");
            return false;
        }
    }

    private static bool HasTaskTool(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("tools", out var tools) ||
            tools.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        foreach (var tool in tools.EnumerateArray())
        {
            var name = JsonHelpers.GetString(tool, "name");
            if (!string.IsNullOrEmpty(name) && TaskToolNames.Contains(name))
            {
                return true;
            }
        }

        return false;
    }

    private static List<string> BuildTaskListLines(List<NativeTaskRow> tasks)
    {
        var completed = tasks.Count(static task => task.Status == "completed");
        var current = tasks.FirstOrDefault(static task => task.Status == "in_progress");
        var lines = new List<string>
        {
            $"Session task list ({tasks.Count} total, {completed} completed):"
        };

        if (tasks.Count > ReminderMaxRows)
        {
            lines.Add(
                $"  {CountReminderStatus(tasks, "pending")} pending, " +
                $"{CountReminderStatus(tasks, "in_progress")} in_progress, " +
                $"{CountReminderStatus(tasks, "blocked")} blocked, " +
                $"{CountReminderStatus(tasks, "in_review")} in_review");
            if (current is not null)
            {
                lines.Add($"  Current: #{current.Id} {TruncateReminderTitle(current.Subject)}");
            }
            lines.Add("  Too many tasks to list here. Call TaskList before changing the plan.");
            return lines;
        }

        // Rows stay in stored order so the list reads as the execution order the model wrote.
        // Only the oldest completed rows fold away; the recent ones carry the sense of progress.
        var foldedCompleted = Math.Max(0, completed - ReminderRecentCompleted);
        if (foldedCompleted > 0)
        {
            lines.Add($"  ({foldedCompleted} earlier completed tasks omitted)");
        }

        var folded = 0;
        foreach (var task in tasks)
        {
            if (task.Status == "completed" && folded < foldedCompleted)
            {
                folded++;
                continue;
            }

            var marker = ReferenceEquals(task, current) ? "  <- current" : string.Empty;
            lines.Add($"  [{task.Status}] #{task.Id} {TruncateReminderTitle(task.Subject)}{marker}");
        }

        lines.Add(current is not null
            ? "Finish the current task, mark it completed with TaskUpdate, then move the next one to in_progress."
            : "No task is in_progress. Pick the next one, mark it in_progress with TaskUpdate, and continue.");
        lines.Add("Refine, split, or reorder these tasks rather than creating duplicates.");
        return lines;
    }

    private static int CountReminderStatus(List<NativeTaskRow> tasks, string status)
    {
        return tasks.Count(task => task.Status == status);
    }

    private static string TruncateReminderTitle(string title)
    {
        var collapsed = CollapseWhitespace(title);
        return collapsed.Length > ReminderTitleLimit
            ? string.Concat(collapsed.AsSpan(0, ReminderTitleLimit - 1), "…")
            : collapsed;
    }

    private static string CollapseWhitespace(string value)
    {
        var builder = new StringBuilder(value.Length);
        var pendingSpace = false;
        foreach (var character in value)
        {
            if (char.IsWhiteSpace(character))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }

            builder.Append(character);
        }

        return builder.ToString();
    }

    private static string WrapReminder(IReadOnlyList<string> lines)
    {
        var builder = new StringBuilder("<system-reminder>");
        foreach (var line in lines)
        {
            builder.Append('\n').Append(line);
        }

        return builder.Append("\n</system-reminder>").ToString();
    }
}
