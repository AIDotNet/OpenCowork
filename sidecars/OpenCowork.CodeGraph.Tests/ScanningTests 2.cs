using Xunit;

// =============================================================================
// Scanning goldens (WS-B, M4b). Pins the ignore engine that scopes indexing/sync —
// CodeGraphGitIgnoreMatcher (the from-scratch git `.gitignore` semantics) and
// CodeGraphScopeIgnore / CodeGraphIgnoreDefaults (DEFAULT_IGNORE_DIRS +
// buildDefaultIgnore + the exclude/include precedence). Pure-function + temp-dir
// tests; no grammar, always run. (The git/FS directory walker itself —
// CodeGraphDirectoryScanner — is a later slice; its file selection is driven ENTIRELY
// by these matchers, which are what these tests pin.)
// =============================================================================

// -----------------------------------------------------------------------------
// (a) CodeGraphGitIgnoreMatcher — the git ignore spec, reproduced from scratch.
// -----------------------------------------------------------------------------
public sealed class CodeGraphGitIgnoreMatcherTests
{
    // A pattern with no interior slash floats to any depth; a leading slash anchors
    // it to the matcher root.
    [Fact]
    public void FloatingPatternMatchesAnyDepth_AnchoredOnlyAtRoot()
    {
        var floating = new CodeGraphGitIgnoreMatcher().Add(new[] { "*.log" });
        Assert.True(floating.Ignores("app.log"));
        Assert.True(floating.Ignores("src/nested/app.log"));
        Assert.False(floating.Ignores("app.txt"));

        var anchored = new CodeGraphGitIgnoreMatcher().Add(new[] { "/build/" });
        Assert.True(anchored.Ignores("build/out.js")); // root-level build/
        Assert.False(anchored.Ignores("src/build/out.js")); // nested build/ is NOT anchored
    }

    // A trailing-slash pattern matches a directory (and its contents), not a same-
    // named file.
    [Fact]
    public void DirectoryOnlyPatternMatchesDirNotFile()
    {
        var ig = new CodeGraphGitIgnoreMatcher().Add(new[] { "dist/" });
        Assert.True(ig.Ignores("dist/"));
        Assert.True(ig.Ignores("dist/bundle.js"));
        Assert.True(ig.Ignores("packages/app/dist/bundle.js")); // floats to any depth
        Assert.False(ig.Ignores("dist")); // a FILE named 'dist' is not a directory match
    }

    // A leading `!` negates (re-includes); last matching rule wins. This is the
    // `!vendor/` opt-out of a DEFAULT_IGNORE_DIRS entry (#407).
    [Fact]
    public void NegationReincludesDefaultIgnoredDir()
    {
        var ig = new CodeGraphGitIgnoreMatcher()
            .Add(CodeGraphIgnoreDefaults.DefaultIgnorePatterns) // includes vendor/ and node_modules/
            .Add(new[] { "!vendor/" });

        // vendor/ is re-included by the negation...
        Assert.False(ig.Ignores("vendor/"));
        Assert.False(ig.Ignores("vendor/lib/pkg.go"));
        // ...but other default-ignored dirs stay ignored.
        Assert.True(ig.Ignores("node_modules/left-pad/index.js"));
    }

    // Git's parent rule: a file under an ignored directory cannot be re-included by a
    // later negation — only re-including the DIRECTORY itself works.
    [Fact]
    public void ParentIgnoreCannotBeUndoneByChildNegation()
    {
        var childNegated = new CodeGraphGitIgnoreMatcher().Add(new[] { "build/", "!build/keep.txt" });
        // Parent build/ is ignored, so keep.txt stays ignored despite the negation.
        Assert.True(childNegated.Ignores("build/keep.txt"));

        var dirNegated = new CodeGraphGitIgnoreMatcher().Add(new[] { "build/", "!build/" });
        // Re-including the directory does re-include its contents.
        Assert.False(dirNegated.Ignores("build/"));
        Assert.False(dirNegated.Ignores("build/keep.txt"));
    }

    // Blank lines and `#` comments are skipped.
    [Fact]
    public void SkipsBlankLinesAndComments()
    {
        var ig = new CodeGraphGitIgnoreMatcher().Add("# a comment\n\n*.tmp\n");
        Assert.True(ig.Ignores("scratch.tmp"));
        Assert.False(ig.Ignores("a comment")); // the comment line created no rule
    }
}

// -----------------------------------------------------------------------------
// (b) CodeGraphIgnoreDefaults / CodeGraphScopeIgnore — DEFAULT_IGNORE_DIRS plus the
// root `.gitignore` merge and the user exclude/include precedence, over a temp dir.
// -----------------------------------------------------------------------------
public sealed class CodeGraphScopeIgnoreTests
{
    // DEFAULT_IGNORE_DIRS is skipped out of the box; the root `.gitignore` layers on
    // top (with negations winning).
    [Fact]
    public void BuildDefaultIgnore_SkipsDefaultDirs_AndMergesRootGitignore()
    {
        WithTempDir(dir =>
        {
            File.WriteAllText(Path.Combine(dir, ".gitignore"), "*.log\n!important.log\n");
            var ig = CodeGraphIgnoreDefaults.BuildDefaultIgnore(dir);

            // Built-in defaults (node_modules is the canonical case).
            Assert.True(ig.Ignores("node_modules/"));
            Assert.True(ig.Ignores("node_modules/react/index.js"));
            Assert.True(ig.Ignores("dist/"));
            Assert.True(ig.Ignores("obj/")); // .NET build output

            // First-party source is NOT ignored.
            Assert.False(ig.Ignores("src/"));
            Assert.False(ig.Ignores("src/index.ts"));

            // Root `.gitignore` merged: *.log ignored, !important.log re-included.
            Assert.True(ig.Ignores("debug.log"));
            Assert.False(ig.Ignores("important.log"));
        });
    }

    // ScopeIgnore is the single scope source: defaults apply, and user `exclude`
    // (codegraph.json) drops paths git would keep — checked first, wins always (#999).
    [Fact]
    public void ScopeIgnore_AppliesDefaults_AndUserExcludeWins()
    {
        WithTempDir(dir =>
        {
            var config = new CodeGraphProjectConfig(
                new Dictionary<string, string>(),
                Array.Empty<string>(),
                exclude: new[] { "*.secret.ts" },
                include: Array.Empty<string>());

            var scope = CodeGraphScopeIgnore.Build(dir, config, Array.Empty<string>());

            // Defaults still skip node_modules; ordinary source is kept.
            Assert.True(scope.Ignores("node_modules/pkg/index.js"));
            Assert.False(scope.Ignores("src/index.ts"));

            // User exclude drops a git-tracked-looking path that no default would.
            Assert.True(scope.Ignores("src/db.secret.ts"));
            Assert.False(scope.Ignores("src/db.ts"));
        });
    }

    // Run body against a fresh temp dir, always cleaned up.
    private static void WithTempDir(Action<string> body)
    {
        var dir = Path.Combine(Path.GetTempPath(), "codegraph-scan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            body(dir);
        }
        finally
        {
            CodeGraphTestSupport.DeleteDir(dir);
        }
    }
}
