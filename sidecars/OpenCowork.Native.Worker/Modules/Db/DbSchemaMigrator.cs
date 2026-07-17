using System.Diagnostics;
using Microsoft.Data.Sqlite;

internal static class DbSchemaMigrator
{
    private const string UsageEffectiveInputTokensExpr = """
        COALESCE(
          billable_input_tokens,
          MAX(input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_creation_tokens, 0), 0)
        )
        """;

    public static void Initialize(SqliteConnection connection)
    {
        var startedAt = Stopwatch.GetTimestamp();
        WorkerLog.Info("db schema initialize start");
        CreateCoreTables(connection);
        CreateAgentChangeTables(connection);
        CreateMemoryTables(connection);
        CreateGoalTables(connection);
        CreateWorkItemTables(connection);
        CreateChannelAndCronTables(connection);
        CreateSshAndProjectTables(connection);
        CreateHookTables(connection);
        CreateUsageTables(connection);
        CreateSyncTables(connection);
        ApplyAdditiveMigrations(connection);
        BackfillUsageActivity(connection);
        var elapsedMs = (long)Math.Round(Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);
        WorkerLog.Info($"db schema initialize done elapsedMs={elapsedMs}");
    }

    private static void CreateCoreTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              icon TEXT,
              mode TEXT NOT NULL DEFAULT 'chat',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              message_count INTEGER NOT NULL DEFAULT 0,
              project_id TEXT,
              working_folder TEXT,
              ssh_connection_id TEXT,
              plan_id TEXT,
              pinned INTEGER DEFAULT 0,
              plugin_id TEXT,
              external_chat_id TEXT,
              provider_id TEXT,
              model_id TEXT,
              model_selection_mode TEXT NOT NULL DEFAULT 'inherit'
            );

            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              meta TEXT,
              created_at INTEGER NOT NULL,
              usage TEXT,
              sort_order INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session
              ON messages(session_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_sessions_plugin
              ON sessions(plugin_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_external_chat
              ON sessions(external_chat_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_project_id
              ON sessions(project_id);

            CREATE TABLE IF NOT EXISTS sub_agent_history (
              tool_use_id TEXT PRIMARY KEY,
              session_id TEXT,
              state_json TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              started_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sub_agent_history_session
              ON sub_agent_history(session_id, started_at DESC);
            """);
    }

    private static void CreateAgentChangeTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS agent_change_sets (
              run_id TEXT PRIMARY KEY,
              session_id TEXT,
              assistant_message_id TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_file_changes (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              session_id TEXT,
              tool_use_id TEXT,
              tool_name TEXT,
              file_path TEXT NOT NULL,
              transport TEXT NOT NULL,
              connection_id TEXT,
              op TEXT NOT NULL,
              status TEXT NOT NULL,
              before_json TEXT NOT NULL,
              after_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              accepted_at INTEGER,
              reverted_at INTEGER,
              conflict TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              FOREIGN KEY (run_id) REFERENCES agent_change_sets(run_id) ON DELETE CASCADE,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agent_change_sets_session
              ON agent_change_sets(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_agent_file_changes_run
              ON agent_file_changes(run_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_agent_file_changes_session
              ON agent_file_changes(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_agent_file_changes_tool_use
              ON agent_file_changes(tool_use_id);
            """);
    }

    private static void CreateMemoryTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS memory_automation_entries (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL,
              root_scope TEXT,
              memory_root_id TEXT,
              job_id TEXT,
              project_id TEXT,
              target TEXT NOT NULL,
              kind TEXT NOT NULL,
              content TEXT NOT NULL,
              confidence REAL NOT NULL DEFAULT 0,
              source_session_id TEXT,
              target_path TEXT,
              status TEXT NOT NULL,
              filter_reason TEXT,
              fingerprint TEXT NOT NULL,
              evidence_json TEXT,
              written_at INTEGER,
              error TEXT,
              before_content TEXT,
              after_content TEXT,
              appended_text TEXT,
              ssh_connection_id TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              undone_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_memory_automation_created
              ON memory_automation_entries(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_automation_target
              ON memory_automation_entries(target, target_path, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_automation_fingerprint
              ON memory_automation_entries(fingerprint, target, target_path, status);
            CREATE INDEX IF NOT EXISTS idx_memory_automation_session
              ON memory_automation_entries(source_session_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_automation_root
              ON memory_automation_entries(memory_root_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS memory_automation_rollups (
              scope TEXT NOT NULL,
              target TEXT NOT NULL,
              target_path TEXT NOT NULL,
              source_date TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              processed_at INTEGER NOT NULL,
              PRIMARY KEY (scope, target_path, source_date, content_hash)
            );

            CREATE TABLE IF NOT EXISTS memory_roots (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
              project_id TEXT,
              working_folder TEXT,
              ssh_connection_id TEXT,
              root_path TEXT NOT NULL,
              transport TEXT NOT NULL CHECK(transport IN ('local', 'ssh')),
              owner_key TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memory_roots_scope
              ON memory_roots(scope, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_roots_project
              ON memory_roots(project_id, working_folder, ssh_connection_id);

            CREATE TABLE IF NOT EXISTS memory_stage1_outputs (
              id TEXT PRIMARY KEY,
              memory_root_id TEXT NOT NULL,
              scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
              source_session_id TEXT NOT NULL,
              source_updated_at INTEGER,
              raw_memory TEXT NOT NULL,
              rollout_summary TEXT NOT NULL,
              rollout_slug TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              usage_count INTEGER NOT NULL DEFAULT 0,
              last_usage_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (memory_root_id) REFERENCES memory_roots(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_stage1_unique
              ON memory_stage1_outputs(memory_root_id, source_session_id, fingerprint);
            CREATE INDEX IF NOT EXISTS idx_memory_stage1_root_created
              ON memory_stage1_outputs(memory_root_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_stage1_session
              ON memory_stage1_outputs(source_session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS memory_jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              memory_root_id TEXT,
              source_session_id TEXT,
              lease_owner TEXT,
              lease_expires_at INTEGER,
              attempts INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              started_at INTEGER,
              finished_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (memory_root_id) REFERENCES memory_roots(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
              ON memory_jobs(status, kind, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_jobs_root
              ON memory_jobs(memory_root_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_jobs_session
              ON memory_jobs(source_session_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS memory_citation_usage (
              id TEXT PRIMARY KEY,
              memory_root_id TEXT NOT NULL,
              scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
              source_session_id TEXT,
              path TEXT NOT NULL,
              line INTEGER,
              citation_json TEXT,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (memory_root_id) REFERENCES memory_roots(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_memory_citation_usage_root
              ON memory_citation_usage(memory_root_id, created_at DESC);
            """);
    }

    private static void CreateGoalTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS session_goals (
              session_id TEXT PRIMARY KEY NOT NULL,
              goal_id TEXT NOT NULL,
              objective TEXT NOT NULL,
              status TEXT NOT NULL CHECK(
                status IN (
                  'active',
                  'paused',
                  'blocked',
                  'usage_limited',
                  'budget_limited',
                  'complete'
                )
              ),
              token_budget INTEGER,
              tokens_used INTEGER NOT NULL DEFAULT 0,
              time_used_seconds INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_session_goals_status
              ON session_goals(status);

            CREATE TABLE IF NOT EXISTS session_goal_events (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              goal_id TEXT,
              event_type TEXT NOT NULL,
              message TEXT,
              metadata_json TEXT,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_session_goal_events_session_created
              ON session_goal_events(session_id, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_session_goal_events_goal_created
              ON session_goal_events(goal_id, created_at DESC);
            """);

        MigrateSessionGoalsStatusSchema(connection);
    }

    private static void CreateWorkItemTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS plans (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              title TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'drafting',
              file_path TEXT,
              content TEXT,
              spec_json TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);

            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              plan_id TEXT,
              subject TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              active_form TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              owner TEXT,
              blocks TEXT DEFAULT '[]',
              blocked_by TEXT DEFAULT '[]',
              metadata TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
              FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);

            CREATE TABLE IF NOT EXISTS draw_runs (
              id TEXT PRIMARY KEY,
              prompt TEXT NOT NULL,
              provider_name TEXT NOT NULL,
              model_name TEXT NOT NULL,
              mode TEXT NOT NULL DEFAULT 'image',
              meta_json TEXT,
              created_at INTEGER NOT NULL,
              is_generating INTEGER NOT NULL DEFAULT 0,
              images_json TEXT NOT NULL DEFAULT '[]',
              error_json TEXT,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_draw_runs_created_at ON draw_runs(created_at DESC);
            """);
    }

    private static void CreateChannelAndCronTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS qq_wakeup_windows (
              plugin_id TEXT NOT NULL,
              open_id TEXT NOT NULL,
              period_key TEXT NOT NULL,
              source_message_id TEXT,
              source_timestamp INTEGER NOT NULL,
              sent_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (plugin_id, open_id, period_key)
            );

            CREATE INDEX IF NOT EXISTS idx_qq_wakeup_windows_open_id
              ON qq_wakeup_windows(plugin_id, open_id, sent_at DESC);

            CREATE TABLE IF NOT EXISTS cron_jobs (
              id                   TEXT PRIMARY KEY,
              name                 TEXT NOT NULL,
              schedule_kind        TEXT NOT NULL,
              schedule_at          INTEGER,
              schedule_every       INTEGER,
              schedule_expr        TEXT,
              schedule_tz          TEXT DEFAULT 'UTC',
              prompt               TEXT NOT NULL,
              agent_id             TEXT,
              model                TEXT,
              working_folder       TEXT,
              ssh_connection_id    TEXT,
              session_id           TEXT,
              source_session_title TEXT,
              source_project_id    TEXT,
              source_project_name  TEXT,
              source_provider_id   TEXT,
              delivery_mode        TEXT DEFAULT 'desktop',
              delivery_target      TEXT,
              plugin_id            TEXT,
              plugin_chat_id       TEXT,
              enabled              INTEGER DEFAULT 1,
              delete_after_run     INTEGER DEFAULT 0,
              max_iterations       INTEGER DEFAULT 15,
              deleted_at           INTEGER,
              last_fired_at        INTEGER,
              fire_count           INTEGER DEFAULT 0,
              created_at           INTEGER NOT NULL,
              updated_at           INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS cron_runs (
              id                            TEXT PRIMARY KEY,
              job_id                        TEXT NOT NULL,
              started_at                    INTEGER NOT NULL,
              finished_at                   INTEGER,
              status                        TEXT DEFAULT 'running',
              tool_call_count               INTEGER DEFAULT 0,
              output_summary                TEXT,
              error                         TEXT,
              scheduled_for                 INTEGER,
              job_name_snapshot             TEXT,
              prompt_snapshot               TEXT,
              source_session_id_snapshot    TEXT,
              source_session_title_snapshot TEXT,
              source_project_id_snapshot    TEXT,
              source_project_name_snapshot  TEXT,
              source_provider_id_snapshot   TEXT,
              model_snapshot                TEXT,
              working_folder_snapshot       TEXT,
              delivery_mode_snapshot        TEXT,
              delivery_target_snapshot      TEXT,
              FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cron_run_messages (
              id             TEXT PRIMARY KEY,
              run_id         TEXT NOT NULL,
              role           TEXT NOT NULL,
              content        TEXT NOT NULL,
              usage          TEXT,
              message_source TEXT,
              sort_order     INTEGER NOT NULL,
              created_at     INTEGER NOT NULL,
              FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cron_run_logs (
              id         TEXT PRIMARY KEY,
              run_id     TEXT NOT NULL,
              timestamp  INTEGER NOT NULL,
              type       TEXT NOT NULL,
              content    TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              FOREIGN KEY (run_id) REFERENCES cron_runs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at);
            CREATE INDEX IF NOT EXISTS idx_cron_run_messages_run ON cron_run_messages(run_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_cron_run_logs_run ON cron_run_logs(run_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_cron_jobs_session ON cron_jobs(session_id);
            CREATE INDEX IF NOT EXISTS idx_cron_jobs_deleted_at ON cron_jobs(deleted_at);
            """);
    }

    private static void CreateSshAndProjectTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS ssh_groups (
              id         TEXT PRIMARY KEY,
              name       TEXT NOT NULL,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ssh_connections (
              id                   TEXT PRIMARY KEY,
              group_id             TEXT,
              name                 TEXT NOT NULL,
              host                 TEXT NOT NULL,
              port                 INTEGER NOT NULL DEFAULT 22,
              username             TEXT NOT NULL,
              auth_type            TEXT NOT NULL DEFAULT 'password',
              encrypted_password   TEXT,
              private_key_path     TEXT,
              encrypted_passphrase TEXT,
              startup_command      TEXT,
              default_directory    TEXT,
              proxy_jump           TEXT,
              keep_alive_interval  INTEGER DEFAULT 60,
              sort_order           INTEGER NOT NULL DEFAULT 0,
              last_connected_at    INTEGER,
              created_at           INTEGER NOT NULL,
              updated_at           INTEGER NOT NULL,
              FOREIGN KEY (group_id) REFERENCES ssh_groups(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ssh_connections_group ON ssh_connections(group_id);

            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              working_folder TEXT,
              ssh_connection_id TEXT,
              plugin_id TEXT,
              pinned INTEGER DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);
            CREATE INDEX IF NOT EXISTS idx_projects_plugin_id ON projects(plugin_id);
            CREATE INDEX IF NOT EXISTS idx_projects_pinned_updated_at ON projects(pinned, updated_at DESC);
            """);
    }

    private static void CreateHookTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS hook_trusts (
              id TEXT PRIMARY KEY,
              identity_key TEXT NOT NULL,
              trust_key TEXT NOT NULL UNIQUE,
              source_kind TEXT NOT NULL,
              source_path TEXT NOT NULL,
              source_real_path TEXT NOT NULL,
              source_config_hash TEXT NOT NULL,
              project_id TEXT,
              project_root TEXT,
              project_root_real_path TEXT,
              event_name TEXT NOT NULL,
              matcher TEXT NOT NULL,
              handler_type TEXT NOT NULL,
              command TEXT NOT NULL,
              resolved_cwd TEXT NOT NULL,
              env_fingerprint TEXT NOT NULL,
              definition_hash TEXT NOT NULL,
              artifact_hashes_json TEXT,
              status TEXT NOT NULL,
              local_disabled INTEGER NOT NULL DEFAULT 0,
              snapshot_json TEXT NOT NULL,
              last_reviewed_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_hook_trusts_identity
              ON hook_trusts(identity_key, updated_at);
            CREATE INDEX IF NOT EXISTS idx_hook_trusts_source
              ON hook_trusts(source_kind, source_real_path);
            CREATE INDEX IF NOT EXISTS idx_hook_trusts_event
              ON hook_trusts(event_name);

            CREATE TABLE IF NOT EXISTS hook_runs (
              id TEXT PRIMARY KEY,
              trust_key TEXT NOT NULL,
              run_id TEXT,
              session_id TEXT,
              event_name TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              completed_at INTEGER,
              duration_ms INTEGER,
              status TEXT NOT NULL,
              exit_code INTEGER,
              skipped_reason TEXT,
              stdout_preview TEXT,
              stderr_preview TEXT,
              decision_json TEXT,
              error TEXT,
              retained_until INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_hook_runs_trust_started
              ON hook_runs(trust_key, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_hook_runs_session_started
              ON hook_runs(session_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_hook_runs_event_started
              ON hook_runs(event_name, started_at DESC);
            """);
    }

    private static void CreateUsageTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS usage_events (
              id TEXT PRIMARY KEY,
              created_at INTEGER NOT NULL,
              request_started_at INTEGER,
              request_finished_at INTEGER,
              session_id TEXT,
              message_id TEXT,
              project_id TEXT,
              source_kind TEXT NOT NULL,
              provider_id TEXT,
              provider_name TEXT,
              provider_type TEXT,
              provider_builtin_id TEXT,
              provider_base_url TEXT,
              model_id TEXT,
              model_name TEXT,
              model_category TEXT,
              request_type TEXT,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              billable_input_tokens INTEGER,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              cache_creation_tokens INTEGER,
              cache_read_tokens INTEGER,
              reasoning_tokens INTEGER,
              context_tokens INTEGER,
              input_price REAL,
              output_price REAL,
              cache_creation_price REAL,
              cache_hit_price REAL,
              input_cost_usd REAL,
              output_cost_usd REAL,
              cache_creation_cost_usd REAL,
              cache_hit_cost_usd REAL,
              total_cost_usd REAL,
              ttft_ms REAL,
              total_ms REAL,
              tps REAL,
              provider_response_id TEXT,
              request_debug_json TEXT,
              usage_raw_json TEXT,
              meta_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created_at ON usage_events(provider_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_model_created_at ON usage_events(model_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_session_created_at ON usage_events(session_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_source_kind ON usage_events(source_kind);

            CREATE TABLE IF NOT EXISTS usage_activity_daily (
              day TEXT PRIMARY KEY,
              first_at INTEGER NOT NULL,
              last_at INTEGER NOT NULL,
              request_count INTEGER NOT NULL DEFAULT 0,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
              cache_read_tokens INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens INTEGER NOT NULL DEFAULT 0,
              total_cost_usd REAL NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_activity_daily_models (
              day TEXT NOT NULL,
              provider_id TEXT NOT NULL DEFAULT '',
              provider_name TEXT,
              model_id TEXT NOT NULL DEFAULT '',
              model_name TEXT,
              request_count INTEGER NOT NULL DEFAULT 0,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
              cache_read_tokens INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens INTEGER NOT NULL DEFAULT 0,
              total_cost_usd REAL NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (day, provider_id, model_id)
            );

            CREATE TABLE IF NOT EXISTS usage_activity_daily_providers (
              day TEXT NOT NULL,
              provider_id TEXT NOT NULL DEFAULT '',
              provider_name TEXT,
              provider_type TEXT,
              provider_builtin_id TEXT,
              provider_base_url TEXT,
              request_count INTEGER NOT NULL DEFAULT 0,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
              cache_read_tokens INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens INTEGER NOT NULL DEFAULT 0,
              total_cost_usd REAL NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (day, provider_id)
            );

            CREATE INDEX IF NOT EXISTS idx_usage_activity_daily_day ON usage_activity_daily(day DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_activity_models_day ON usage_activity_daily_models(day DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_activity_providers_day ON usage_activity_daily_providers(day DESC);
            """);
    }

    private static void CreateSyncTables(SqliteConnection connection)
    {
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS sync_record_state (
              provider_id TEXT NOT NULL,
              domain TEXT NOT NULL,
              record_id TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              synced_at INTEGER NOT NULL,
              PRIMARY KEY (provider_id, domain, record_id)
            );

            CREATE TABLE IF NOT EXISTS sync_tombstones (
              provider_id TEXT NOT NULL,
              domain TEXT NOT NULL,
              record_id TEXT NOT NULL,
              deleted_at INTEGER NOT NULL,
              origin_device_id TEXT NOT NULL,
              PRIMARY KEY (provider_id, domain, record_id)
            );

            CREATE INDEX IF NOT EXISTS idx_sync_record_state_provider
              ON sync_record_state(provider_id, domain);

            CREATE INDEX IF NOT EXISTS idx_sync_tombstones_provider
              ON sync_tombstones(provider_id, domain, deleted_at);
            """);
    }

    private static void ApplyAdditiveMigrations(SqliteConnection connection)
    {
        EnsureColumn(connection, "sessions", "icon", "TEXT");
        EnsureColumn(connection, "sessions", "plugin_id", "TEXT");
        EnsureColumn(connection, "sessions", "external_chat_id", "TEXT");
        EnsureColumn(connection, "sessions", "plan_id", "TEXT");
        EnsureColumn(connection, "sessions", "provider_id", "TEXT");
        EnsureColumn(connection, "sessions", "model_id", "TEXT");
        EnsureColumn(connection, "sessions", "model_selection_mode", "TEXT NOT NULL DEFAULT 'inherit'");
        EnsureColumn(connection, "sessions", "pinned", "INTEGER DEFAULT 0");
        EnsureColumn(connection, "sessions", "message_count", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "sessions", "ssh_connection_id", "TEXT");
        EnsureColumn(connection, "sessions", "project_id", "TEXT");
        EnsureColumn(connection, "messages", "meta", "TEXT");

        Execute(connection, """
            UPDATE sessions
               SET model_selection_mode = 'manual'
             WHERE provider_id IS NOT NULL
               AND model_id IS NOT NULL
               AND model_selection_mode = 'inherit';

            UPDATE sessions
               SET message_count = (
                 SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id
               );
            """);

        EnsureColumn(connection, "memory_automation_entries", "root_scope", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "memory_root_id", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "job_id", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "project_id", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "filter_reason", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "before_content", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "after_content", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "appended_text", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "ssh_connection_id", "TEXT");
        EnsureColumn(connection, "memory_automation_entries", "undone_at", "INTEGER");

        EnsureColumn(connection, "draw_runs", "mode", "TEXT NOT NULL DEFAULT 'image'");
        EnsureColumn(connection, "draw_runs", "meta_json", "TEXT");
        EnsureColumn(connection, "projects", "pinned", "INTEGER DEFAULT 0");

        EnsureColumn(connection, "cron_jobs", "plugin_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "plugin_chat_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "session_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "source_session_title", "TEXT");
        EnsureColumn(connection, "cron_jobs", "source_project_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "source_project_name", "TEXT");
        EnsureColumn(connection, "cron_jobs", "source_provider_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "ssh_connection_id", "TEXT");
        EnsureColumn(connection, "cron_jobs", "deleted_at", "INTEGER");

        EnsureColumn(connection, "cron_runs", "scheduled_for", "INTEGER");
        EnsureColumn(connection, "cron_runs", "job_name_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "prompt_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "source_session_id_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "source_session_title_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "source_project_id_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "source_project_name_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "source_provider_id_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "model_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "working_folder_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "delivery_mode_snapshot", "TEXT");
        EnsureColumn(connection, "cron_runs", "delivery_target_snapshot", "TEXT");

        EnsureColumn(connection, "hook_trusts", "local_disabled", "INTEGER NOT NULL DEFAULT 0");
    }

    private static void BackfillUsageActivity(SqliteConnection connection)
    {
        if (ScalarLong(connection, "SELECT COUNT(*) FROM usage_activity_daily") > 0)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Execute(connection, $"""
            INSERT INTO usage_activity_daily (
              day, first_at, last_at, request_count, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              COUNT(*) AS request_count,
              COALESCE(SUM({UsageEffectiveInputTokensExpr}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              {now} AS updated_at
            FROM usage_events
            GROUP BY day;

            INSERT INTO usage_activity_daily_models (
              day, provider_id, provider_name, model_id, model_name, request_count,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(provider_id, '') AS provider_id,
              provider_name,
              COALESCE(model_id, '') AS model_id,
              model_name,
              COUNT(*) AS request_count,
              COALESCE(SUM({UsageEffectiveInputTokensExpr}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              {now} AS updated_at
            FROM usage_events
            GROUP BY day, provider_id, model_id;

            INSERT INTO usage_activity_daily_providers (
              day, provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
              request_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              reasoning_tokens, total_cost_usd, updated_at
            )
            SELECT
              strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(provider_id, '') AS provider_id,
              provider_name,
              provider_type,
              provider_builtin_id,
              provider_base_url,
              COUNT(*) AS request_count,
              COALESCE(SUM({UsageEffectiveInputTokensExpr}), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
              {now} AS updated_at
            FROM usage_events
            GROUP BY day, provider_id;
            """);
    }

    private static void MigrateSessionGoalsStatusSchema(SqliteConnection connection)
    {
        if (TableDefinitionIncludes(connection, "session_goals", "'usage_limited'"))
        {
            return;
        }

        Execute(connection, """
            ALTER TABLE session_goals RENAME TO session_goals_legacy;

            CREATE TABLE session_goals (
              session_id TEXT PRIMARY KEY NOT NULL,
              goal_id TEXT NOT NULL,
              objective TEXT NOT NULL,
              status TEXT NOT NULL CHECK(
                status IN (
                  'active',
                  'paused',
                  'blocked',
                  'usage_limited',
                  'budget_limited',
                  'complete'
                )
              ),
              token_budget INTEGER,
              tokens_used INTEGER NOT NULL DEFAULT 0,
              time_used_seconds INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            INSERT INTO session_goals (
              session_id,
              goal_id,
              objective,
              status,
              token_budget,
              tokens_used,
              time_used_seconds,
              created_at,
              updated_at
            )
            SELECT
              session_id,
              goal_id,
              objective,
              status,
              token_budget,
              tokens_used,
              time_used_seconds,
              created_at,
              updated_at
            FROM session_goals_legacy;

            DROP TABLE session_goals_legacy;

            CREATE INDEX IF NOT EXISTS idx_session_goals_status
              ON session_goals(status);
            """);
    }

    private static bool HasColumn(SqliteConnection connection, string tableName, string columnName)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info({QuoteIdent(tableName)})";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (string.Equals(reader.GetString(1), columnName, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    private static void EnsureColumn(
        SqliteConnection connection,
        string tableName,
        string columnName,
        string definition)
    {
        if (HasColumn(connection, tableName, columnName))
        {
            return;
        }

        Execute(
            connection,
            $"ALTER TABLE {QuoteIdent(tableName)} ADD COLUMN {QuoteIdent(columnName)} {definition}");
    }

    private static bool TableDefinitionIncludes(
        SqliteConnection connection,
        string tableName,
        string fragment)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT sql FROM sqlite_master
             WHERE type = 'table'
               AND name = $tableName
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$tableName", tableName);
        var value = command.ExecuteScalar() as string;
        return value?.Contains(fragment, StringComparison.Ordinal) ?? false;
    }

    private static long ScalarLong(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        var value = command.ExecuteScalar();
        return value is null || value == DBNull.Value ? 0 : Convert.ToInt64(value);
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static string QuoteIdent(string value)
    {
        return $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
    }
}
