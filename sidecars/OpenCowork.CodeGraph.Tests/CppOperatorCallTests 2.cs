using System.Text;
using Xunit;

// =============================================================================
// M7-W2 upstream catch-up goldens, both GATED on the C++ grammar (self-skip):
//   * #1247 — explicit operator calls `a.operator+(b)` / `p->operator+(b)`
//     produce a `calls` ref shaped `<receiver>.operator+` (spaced call sites
//     normalize compact; a non-simple receiver drops the ref rather than guess).
//   * CUDA launch normalization end-to-end — a `.cu` file's
//     `kernel<<<grid, block>>>(args)` statement parses via the space-blanking
//     PreParse and emits a `calls` ref to the kernel.
// =============================================================================
public sealed class CodeGraphCppOperatorCallTests
{
    private static CodeGraphExtractionResult ExtractCpp(string filePath, string source) =>
        CodeGraphExtractor.ExtractFromSource(
            filePath,
            Encoding.UTF8.GetBytes(source),
            CodeGraphLanguage.Cpp,
            CodeGraphCppExtractor.Instance,
            CodeGraphExtractionHarness.Grammars);

    [Fact]
    public void ExplicitOperatorCalls_EmitReceiverQualifiedCallsRefs()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Cpp)) return;

        const string source =
            "struct Vec {\n" +
            "  Vec operator+(const Vec& o);\n" +
            "  bool operator<(const Vec& o);\n" +
            "};\n" +
            "Vec add(Vec a, Vec b) { return a.operator+(b); }\n" +
            "void touch(Vec* p, Vec q) { p->operator+(q); }\n" +
            "bool lt(Vec other, Vec self) { return other.operator < (self); }\n";

        var r = ExtractCpp("src/vec.cpp", source);

        // `.` and `->` forms both emit `<receiver>.operator+`.
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "a.operator+"));
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "p.operator+"));

        // A spaced symbolic call site (`operator < (…)`) normalizes compact.
        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "other.operator<"));
    }

    [Fact]
    public void ComplexReceiver_DropsOperatorRef_NeverBareGuess()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Cpp)) return;

        // `(*it)` can't aid receiver-type inference; a bare `operator*` ref would let
        // exact-name matching GUESS among same-named operators. Silent miss instead.
        const string source = "int deref(It it) { return (*it).operator*(); }\n";

        var r = ExtractCpp("src/it.cpp", source);

        Assert.DoesNotContain(r.UnresolvedReferences, x =>
            x.ReferenceKind == CodeGraphEdgeKind.Calls && x.ReferenceName.Contains("operator*"));
    }

    [Fact]
    public void CudaLaunch_ParsesAsPlainCall_EmitsKernelCallsRef()
    {
        if (!CodeGraphExtractionHarness.GrammarAvailable(CodeGraphLanguage.Cpp)) return;

        const string source =
            "void myKernel(float* data, int n);\n" +
            "void run(float* data, int n) {\n" +
            "  myKernel<<<dim3(n / 256), dim3(256)>>>(data, n);\n" +
            "}\n";

        var r = ExtractCpp("gpu/run.cu", source);

        Assert.True(CodeGraphExtractionHarness.HasRef(r, CodeGraphEdgeKind.Calls, "myKernel"));
    }
}
